// Alta y baja de instituciones del bus.
//
// No es un ABM contra una tabla: cada alta crea una organización Fabric real
// (MSP y peer propios) y la incorpora a canal-universal con una actualización
// de configuración firmada por las clínicas que ya estaban; la baja hace el
// camino inverso. Tarda ~30-40 s, así que el panel escucha el progreso por SSE
// y lo va mostrando en vez de dejar un spinner mudo.
//
// Se muestran las dos vistas del estado por separado —registro local y registro
// on-chain— porque pueden discrepar, y esa discrepancia es justamente lo que
// hay que poder ver (p.ej. una clínica en el canal pero sin registrar).
import { useState } from 'react';
import { api, useSSE } from '../api.js';

function EstadoBadge({ estado }) {
  if (!estado) return <span className="badge warn">sin registro</span>;
  const activa = estado === 'activa' || estado === 'ACTIVA';
  return <span className={`badge ${activa ? 'permit' : 'deny'}`}>{activa ? 'activa' : 'baja'}</span>;
}

export default function ClinicsPanel({ clinics, onChanged }) {
  const [key, setKey] = useState('');
  const [nombre, setNombre] = useState('');
  const [motivos, setMotivos] = useState({});
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [progreso, setProgreso] = useState([]);

  useSSE((msg) => {
    if (msg.type !== 'clinic-op') return;
    setProgreso((p) => [...p, msg].slice(-14));
    if (msg.estado === 'ok' || msg.estado === 'error') setBusy(null);
  });

  const correr = async (etiqueta, fn) => {
    setBusy(etiqueta);
    setError(null);
    setProgreso([]);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const alta = () => correr(`alta:${key}`, async () => {
    await api('/clinics', { key: key.trim(), nombre: nombre.trim() });
    setKey('');
    setNombre('');
  });

  const baja = (c) => correr(`baja:${c.key}`, () =>
    api(`/clinics/${c.key}/baja`, { motivo: motivos[c.key] || 'baja solicitada' }));

  const activas = clinics.filter((c) => c.activa).length;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Instituciones del bus</h2>
        <span className="hint">
          {activas} activa{activas === 1 ? '' : 's'} · el alta crea una org Fabric real y actualiza la config del canal
        </span>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Institución</th>
            <th>MSP ID</th>
            <th>Peer</th>
            <th>Registro local</th>
            <th>On-chain</th>
            <th>Nodo</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {clinics.map((c) => (
            <tr key={c.key} className={c.activa ? undefined : 'row-muted'}>
              <td>
                <span className="org-badge" style={{ color: c.color }}>{c.label}</span>
                {c.fundadora && <span className="hint"> · fundadora</span>}
              </td>
              <td><code>{c.mspId}</code></td>
              <td><code>{c.peerEndpoint?.split(':')[1]}</code></td>
              <td><EstadoBadge estado={c.estado} /></td>
              <td>
                <EstadoBadge estado={c.onChain?.estado} />
                {c.onChain?.motivoBaja && <div className="hint">{c.onChain.motivoBaja}</div>}
              </td>
              <td>{c.peerOk ? <span className="badge permit">up</span> : <span className="badge deny">down</span>}</td>
              <td className="cell-actions">
                {c.activa && (
                  <div className="btn-row">
                    <input
                      className="inline-input"
                      placeholder="motivo de la baja"
                      value={motivos[c.key] ?? ''}
                      onChange={(e) => setMotivos((m) => ({ ...m, [c.key]: e.target.value }))}
                    />
                    <button
                      className="danger"
                      disabled={!!busy || activas < 2}
                      title={activas < 2 ? 'No se puede dar de baja la última clínica activa' : undefined}
                      onClick={() => baja(c)}
                    >
                      Dar de baja
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="clinic-form">
        <label>
          Identificador
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="p.ej. rosario"
            spellCheck="false"
          />
          <span className="hint">minúsculas y dígitos, 3-16 · será el host, el contenedor y el canal privado</span>
        </label>
        <label>
          Nombre de la institución
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="p.ej. Hospital Rosario" />
        </label>
        <button className="primary" disabled={!!busy || !key.trim() || !nombre.trim()} onClick={alta}>
          Dar de alta
        </button>
      </div>

      {busy && <div className="result pending">Operación en curso ({busy}) — tarda ~30-40 s…</div>}
      {error && <div className="result error">{error}</div>}

      {progreso.length > 0 && (
        <ol className="op-log">
          {progreso.map((p, i) => (
            <li key={i} className={p.estado}>{p.linea}</li>
          ))}
        </ol>
      )}
    </section>
  );
}
