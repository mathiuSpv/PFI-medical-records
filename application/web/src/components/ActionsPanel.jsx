// Panel de acciones: emite activos, otorga/revoca consentimiento y pide
// acceso, siempre con la identidad de la org activa. El paciente se ingresa
// en claro (p.ej. "paciente-demo-001") y el backend lo hashea (SHA-256) —
// on-chain solo viaja el hash.
import { useEffect, useState } from 'react';
import { api, clinicByKey, orgByMsp, shortHash, useFetch } from '../api.js';

const RESOURCE_TYPES = ['Observation', 'MedicationRequest', 'DiagnosticReport', 'Condition'];

const SAMPLE_RESOURCE = {
  resourceType: 'Observation',
  id: 'obs-demo-001',
  status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel' }] },
  subject: { reference: 'Patient/paciente-demo-001' },
  effectiveDateTime: '2026-07-15T09:30:00Z',
  component: [
    { code: { text: 'Presión sistólica' }, valueQuantity: { value: 118, unit: 'mmHg' } },
    { code: { text: 'Presión diastólica' }, valueQuantity: { value: 76, unit: 'mmHg' } },
  ],
};

function defaultExpiry() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

export default function ActionsPanel({ org, clinics, tick, onDone }) {
  const [tab, setTab] = useState('emitir');
  const [patientId, setPatientId] = useState('paciente-demo-001');
  const [resourceType, setResourceType] = useState('Observation');
  const [resourceJSON, setResourceJSON] = useState(JSON.stringify(SAMPLE_RESOURCE, null, 2));
  const [grantTypes, setGrantTypes] = useState(['Observation']);
  const [expiry, setExpiry] = useState(defaultExpiry());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  // Con más de dos clínicas ya no existe "la otra": hay que elegir a quién se
  // le otorga el consentimiento.
  const destinatarias = clinics.filter((c) => c.key !== org);
  const [targetKey, setTargetKey] = useState(destinatarias[0]?.key);
  useEffect(() => {
    if (!destinatarias.some((c) => c.key === targetKey)) {
      setTargetKey(destinatarias[0]?.key);
    }
  }, [destinatarias, targetKey]);

  const yo = clinicByKey(org) ?? { label: org, color: 'var(--muted)' };
  const other = clinicByKey(targetKey);

  // El acceso se pide por recurso concreto, no por tipo: el paciente y el tipo
  // los deriva el chaincode del activo. Por eso acá hace falta la lista de
  // activos emitidos y no alcanza con un combo de tipos.
  const { data: assets } = useFetch('/assets', { deps: [tick] });
  const [assetId, setAssetId] = useState('');
  useEffect(() => {
    if (!assets) return;
    if (!assets.some((a) => a.FhirResourceID === assetId)) {
      setAssetId(assets[0]?.FhirResourceID ?? '');
    }
  }, [assets, assetId]);

  const run = async (label, fn) => {
    setBusy(true);
    setResult(null);
    try {
      const data = await fn();
      setResult({ ok: true, label, data });
      onDone();
    } catch (err) {
      setResult({ ok: false, label, error: err.message });
    } finally {
      setBusy(false);
    }
  };

  const toggleType = (t) =>
    setGrantTypes((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]));

  const emitir = () => run('EmitAsset', async () => {
    const resource = JSON.parse(resourceJSON);
    return api('/assets', { org, patientId, resourceType, resource });
  });

  const otorgar = () => run('GrantConsent', () => api('/consents', {
    org,
    grantedToOrg: other.mspId,
    patientId,
    resourceTypes: grantTypes,
    expiry: `${expiry}T23:59:59Z`,
  }));

  const revocar = (total) => run('RevokeConsent', () => api('/consents/revoke', {
    org,
    grantedToOrg: other.mspId,
    patientId,
    resourceTypes: total ? [] : grantTypes,
  }));

  const pedirAcceso = () => run('CheckAccess', () => api('/check-access', { org, fhirResourceID: assetId }));

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Acciones</h2>
        <span className="hint">
          firmando como <strong style={{ color: yo.color }}>{yo.label}</strong>
        </span>
      </div>

      <div className="tabs">
        {[['emitir', 'Emitir activo'], ['consentir', 'Consentimiento'], ['acceder', 'Pedir acceso']].map(([key, label]) => (
          <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => { setTab(key); setResult(null); }}>
            {label}
          </button>
        ))}
      </div>

      <div className="form">
        {/* En "Pedir acceso" el paciente no se ingresa: sale del activo elegido.
            Mostrar el campo igual sería un control que no hace nada. */}
        {tab !== 'acceder' && (
          <label>
            Paciente (va al ledger como referencia opaca, HMAC con clave de red)
            <input value={patientId} onChange={(e) => setPatientId(e.target.value)} />
          </label>
        )}

        {tab === 'emitir' && (
          <>
            <label>
              Tipo de recurso FHIR
              <select value={resourceType} onChange={(e) => setResourceType(e.target.value)}>
                {RESOURCE_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label>
              Recurso (JSON — se cifra con AES-256-GCM y va a IPFS; el ledger solo ve el CID)
              <textarea rows="8" value={resourceJSON} onChange={(e) => setResourceJSON(e.target.value)} spellCheck="false" />
            </label>
            <button className="primary" disabled={busy} onClick={emitir}>Cifrar, subir a IPFS y emitir</button>
          </>
        )}

        {tab === 'consentir' && (
          <>
            <label>
              Otorgar a
              <select value={targetKey ?? ''} onChange={(e) => setTargetKey(e.target.value)}>
                {destinatarias.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </label>
            <div className="checkboxes">
              {RESOURCE_TYPES.map((t) => (
                <label key={t} className="checkbox">
                  <input type="checkbox" checked={grantTypes.includes(t)} onChange={() => toggleType(t)} />
                  {t}
                </label>
              ))}
            </div>
            <label>
              Vencimiento
              <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </label>
            <div className="btn-row">
              <button className="primary" disabled={busy || !other || grantTypes.length === 0} onClick={otorgar}>Otorgar consentimiento</button>
              <button disabled={busy || !other || grantTypes.length === 0} onClick={() => revocar(false)}>Revocar seleccionados</button>
              <button className="danger" disabled={busy || !other} onClick={() => revocar(true)}>Revocar todo</button>
            </div>
          </>
        )}

        {tab === 'acceder' && (
          <>
            <label>
              Recurso solicitado
              <select value={assetId} onChange={(e) => setAssetId(e.target.value)} disabled={!assets?.length}>
                {assets?.map((a) => (
                  <option key={a.FhirResourceID} value={a.FhirResourceID}>
                    {a.FhirResourceID} · {a.ResourceType} · paciente {shortHash(a.PatientIDHash, 8)} · {orgByMsp(a.OwnerOrg).label}
                  </option>
                ))}
              </select>
              <span className="hint">
                el tipo y el paciente los toma el chaincode del activo, no se declaran acá
              </span>
            </label>
            <button className="primary" disabled={busy || !assetId} onClick={pedirAcceso}>
              Pedir acceso (CheckAccess on-chain)
            </button>
            {assets?.length === 0 && (
              <div className="result pending">No hay activos emitidos todavía: emití uno primero.</div>
            )}
          </>
        )}

        {busy && <div className="result pending">Enviando transacción…</div>}
        {result && !result.ok && <div className="result error"><strong>{result.label}</strong>: {result.error}</div>}
        {result?.ok && result.label === 'CheckAccess' && (
          <div className={`result decision ${result.data.decision === 'PERMIT' ? 'permit' : 'deny'}`}>
            {result.data.decision}
            {result.data.reason && <span className="reason"> — {result.data.reason}</span>}
          </div>
        )}
        {result?.ok && result.label !== 'CheckAccess' && (
          <div className="result ok">
            <strong>{result.label} OK</strong>
            {result.data.cid && <> · CID <code>{result.data.cid}</code></>}
            {result.data.patientIDHash && <> · hash <code>{result.data.patientIDHash.slice(0, 16)}…</code></>}
          </div>
        )}
      </div>
    </section>
  );
}
