// ABM de la solapa de red: dar de alta instituciones y emitir activos sin salir
// de donde se está mirando el grafo, para poder probar la topología y ver el
// efecto al toque.
//
// Reutiliza los paneles que ya existen —ClinicsPanel para instituciones y
// AssetsPanel para el listado de activos— en vez de duplicar tablas: son los
// mismos datos y una copia terminaría divergiendo.
//
// Alcance real, que no es un ABM completo y conviene no disimularlo: las
// instituciones se dan de alta y de baja (no se modifican, porque el MSP ID y
// el canal se fijan al crear el material criptográfico), y los activos solo se
// emiten. El chaincode no expone borrado de activos: el ledger es inmutable y
// un documento emitido no se deshace.
import { useState } from 'react';
import { api } from '../api.js';
import { RESOURCE_TYPES, SAMPLE_RESOURCE } from './ActionsPanel.jsx';
import AssetsPanel from './AssetsPanel.jsx';
import ClinicsPanel from './ClinicsPanel.jsx';

function EmitirActivo({ activas, org, onDone }) {
  const [emisor, setEmisor] = useState(org);
  const [patientId, setPatientId] = useState('paciente-demo-001');
  const [resourceType, setResourceType] = useState('Observation');
  const [resourceJSON, setResourceJSON] = useState(JSON.stringify(SAMPLE_RESOURCE, null, 2));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  // La org activa del header manda mientras el usuario no elija otra acá; si la
  // que eligió se da de baja, se cae a la primera activa.
  const emisorValido = activas.some((c) => c.key === emisor) ? emisor : (org ?? activas[0]?.key);

  const emitir = async () => {
    setBusy(true);
    setResult(null);
    try {
      const resource = JSON.parse(resourceJSON);
      const data = await api('/assets', { org: emisorValido, patientId, resourceType, resource });
      setResult({ ok: true, data });
      onDone();
    } catch (err) {
      // Un JSON mal escrito y un rechazo del chaincode fallan distinto pero
      // llegan acá igual: se muestra el mensaje tal cual en los dos casos.
      setResult({ ok: false, error: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form">
      <label>
        Institución emisora
        <select value={emisorValido ?? ''} onChange={(e) => setEmisor(e.target.value)}>
          {activas.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      </label>
      <label>
        Paciente (va al ledger como referencia opaca, HMAC con clave de red)
        <input value={patientId} onChange={(e) => setPatientId(e.target.value)} />
      </label>
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
      <div className="btn-row">
        <button className="primary" disabled={busy || !emisorValido} onClick={emitir}>
          Cifrar, subir a IPFS y emitir
        </button>
        <button
          disabled={busy}
          onClick={() => setResourceJSON(JSON.stringify(SAMPLE_RESOURCE, null, 2))}
          title="Vuelve al recurso de ejemplo"
        >
          Restablecer ejemplo
        </button>
      </div>

      {busy && <div className="result pending">Enviando transacción…</div>}
      {result && !result.ok && <div className="result error"><strong>No se emitió</strong>: {result.error}</div>}
      {result?.ok && (
        <div className="result ok">
          <strong>Activo emitido</strong>
          {result.data.cid && <> · CID <code>{result.data.cid}</code></>}
          {' '}— ya aparece en el mapa de arriba.
        </div>
      )}
    </div>
  );
}

export default function AbmPanel({ clinics, activas, org, tick, onChanged }) {
  const [sub, setSub] = useState('instituciones');

  return (
    <section className="panel abm-panel">
      <div className="panel-head">
        <div>
          <h2>Alta y baja</h2>
          <span className="hint">para probar la topología: lo que se crea acá aparece en el mapa de arriba</span>
        </div>
        <div className="tabs">
          {[['instituciones', 'Instituciones'], ['activos', 'Activos']].map(([id, etiqueta]) => (
            <button
              key={id}
              className={`tab ${sub === id ? 'active' : ''}`}
              onClick={() => setSub(id)}
              aria-pressed={sub === id}
            >
              {etiqueta}
            </button>
          ))}
        </div>
      </div>

      {sub === 'instituciones' ? (
        <>
          <p className="hint">
            El alta genera material criptográfico, levanta el peer y lo suma al canal compartido; puede tardar
            un par de minutos. La baja la deja en el registro como dada de baja: sus activos siguen existiendo
            y por eso sigue apareciendo en el mapa.
          </p>
          <ClinicsPanel clinics={clinics} onChanged={onChanged} />
        </>
      ) : (
        <>
          <p className="hint">
            Un activo emitido no se borra: el ledger es inmutable y el chaincode no expone baja de activos.
          </p>
          <EmitirActivo activas={activas} org={org} onDone={onChanged} />
          <AssetsPanel tick={tick} />
        </>
      )}
    </section>
  );
}
