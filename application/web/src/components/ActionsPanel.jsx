// Panel de acciones: emite activos y otorga/revoca consentimiento. El paciente
// se ingresa en claro (p.ej. "paciente-demo-001") y el backend lo convierte en
// referencia opaca (HMAC con clave de red) — on-chain solo viaja esa referencia.
//
// La identidad que firma se elige acá adentro, en cada acción, y no en el
// encabezado: la consola es de administración de la red y mira todo sin ser
// ninguna institución en particular, pero Fabric exige que cada transacción la
// someta una org con su MSP, y de eso dependen el ABAC y la auditoría. Por eso
// el firmante aparece donde efectivamente hay una transacción que firmar.
//
// Pedir acceso no está acá: se pide desde la ficha del documento, que es donde
// se ve de quién es el recurso y qué se le autorizó.
import { useEffect, useState } from 'react';
import { api, clinicByKey } from '../api.js';

export const RESOURCE_TYPES = ['Observation', 'MedicationRequest', 'DiagnosticReport', 'Condition'];

export const SAMPLE_RESOURCE = {
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

export default function ActionsPanel({ clinics, onDone }) {
  const [tab, setTab] = useState('emitir');
  // Firmante de la acción. Arranca en la primera activa y se corrige sola si esa
  // institución se da de baja mientras el panel está abierto.
  const [org, setOrg] = useState(clinics[0]?.key);
  useEffect(() => {
    if (!clinics.some((c) => c.key === org)) setOrg(clinics[0]?.key);
  }, [clinics, org]);

  const [patientId, setPatientId] = useState('paciente-demo-001');
  const [resourceType, setResourceType] = useState('Observation');
  const [resourceJSON, setResourceJSON] = useState(JSON.stringify(SAMPLE_RESOURCE, null, 2));
  const [grantTypes, setGrantTypes] = useState(['Observation']);
  const [expiry, setExpiry] = useState(defaultExpiry());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  // Verificación de identidad simulada (RENAPER mock): informativa, no
  // condiciona ninguna transacción — ver ActionsPanel arriba.
  const [dni, setDni] = useState('');
  const [renaper, setRenaper] = useState(null);
  const [renaperBusy, setRenaperBusy] = useState(false);

  const validarIdentidad = async () => {
    setRenaperBusy(true);
    setRenaper(null);
    try {
      setRenaper(await api('/renaper/validar', { dni }));
    } catch (err) {
      setRenaper({ found: false, error: err.message });
    } finally {
      setRenaperBusy(false);
    }
  };

  // Con más de dos clínicas ya no existe "la otra": hay que elegir a quién se
  // le otorga el consentimiento.
  const destinatarias = clinics.filter((c) => c.key !== org);
  const [targetKey, setTargetKey] = useState(destinatarias[0]?.key);
  useEffect(() => {
    if (!destinatarias.some((c) => c.key === targetKey)) {
      setTargetKey(destinatarias[0]?.key);
    }
  }, [destinatarias, targetKey]);

  const other = clinicByKey(targetKey);

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

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Acciones</h2>
      </div>

      <div className="tabs">
        {[['emitir', 'Emitir activo'], ['consentir', 'Consentimiento']].map(([key, label]) => (
          <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => { setTab(key); setResult(null); }}>
            {label}
          </button>
        ))}
      </div>

      <div className="form">
        <label>
          {tab === 'emitir' ? 'Emite como' : 'Otorga'}
          <select value={org ?? ''} onChange={(e) => setOrg(e.target.value)}>
            {clinics.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        </label>

        <label>
          Paciente
          <input value={patientId} onChange={(e) => setPatientId(e.target.value)} />
        </label>

        <div className="renaper-check">
          <label>
            Código RENAPER
            <input value={dni} onChange={(e) => setDni(e.target.value)} placeholder="DNI, p.ej. 30111222" />
          </label>
          <button disabled={renaperBusy || !dni.trim()} onClick={validarIdentidad}>
            {renaperBusy ? 'Validando…' : 'Validar identidad'}
          </button>
          {renaper?.found && (
            <span className="badge permit">
              {renaper.persona.nombre} {renaper.persona.apellido} · DNI {renaper.dni}
            </span>
          )}
          {renaper && !renaper.found && <span className="badge deny">no encontrado en RENAPER</span>}
        </div>

        {tab === 'emitir' && (
          <>
            <label>
              Tipo de recurso FHIR
              <select value={resourceType} onChange={(e) => setResourceType(e.target.value)}>
                {RESOURCE_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </label>
            <label>
              Recurso
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

        {busy && <div className="result pending">Enviando transacción…</div>}
        {result && !result.ok && <div className="result error"><strong>{result.label}</strong>: {result.error}</div>}
        {result?.ok && (
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
