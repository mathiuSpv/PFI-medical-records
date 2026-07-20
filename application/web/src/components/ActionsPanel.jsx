// Panel de acciones: emite activos, otorga/revoca consentimiento y pide
// acceso, siempre con la identidad de la org activa. El paciente se ingresa
// en claro (p.ej. "paciente-demo-001") y el backend lo hashea (SHA-256) —
// on-chain solo viaja el hash.
import { useState } from 'react';
import { api, ORGS, otherOrg } from '../api.js';

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

export default function ActionsPanel({ org, onDone }) {
  const [tab, setTab] = useState('emitir');
  const [patientId, setPatientId] = useState('paciente-demo-001');
  const [resourceType, setResourceType] = useState('Observation');
  const [resourceJSON, setResourceJSON] = useState(JSON.stringify(SAMPLE_RESOURCE, null, 2));
  const [grantTypes, setGrantTypes] = useState(['Observation']);
  const [expiry, setExpiry] = useState(defaultExpiry());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const other = ORGS[otherOrg(org)];

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

  const pedirAcceso = () => run('CheckAccess', () => api('/check-access', { org, resourceType, patientId }));

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Acciones</h2>
        <span className="hint">
          firmando como <strong style={{ color: ORGS[org].color }}>{ORGS[org].label}</strong>
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
        <label>
          Paciente (se hashea antes de ir al ledger)
          <input value={patientId} onChange={(e) => setPatientId(e.target.value)} />
        </label>

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
            <div className="field-label">Otorgar a: <strong style={{ color: other.color }}>{other.label}</strong> (la otra org)</div>
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
              <button className="primary" disabled={busy || grantTypes.length === 0} onClick={otorgar}>Otorgar consentimiento</button>
              <button disabled={busy || grantTypes.length === 0} onClick={() => revocar(false)}>Revocar seleccionados</button>
              <button className="danger" disabled={busy} onClick={() => revocar(true)}>Revocar todo</button>
            </div>
          </>
        )}

        {tab === 'acceder' && (
          <>
            <label>
              Tipo de recurso solicitado
              <select value={resourceType} onChange={(e) => setResourceType(e.target.value)}>
                {RESOURCE_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <button className="primary" disabled={busy} onClick={pedirAcceso}>
              Pedir acceso (CheckAccess on-chain)
            </button>
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
