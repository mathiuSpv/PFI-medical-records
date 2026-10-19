// Alta y baja de instituciones del bus.
//
// No es un ABM contra una tabla: cada alta crea una organización Fabric real
// (MSP y peer propios) y la incorpora a canal-nacional con una actualización
// de configuración firmada por las clínicas que ya estaban; la baja hace el
// camino inverso. Tarda ~30-40 s, así que el panel escucha el progreso por SSE
// y lo va mostrando en vez de dejar un spinner mudo.
//
// Se muestran las dos vistas del estado por separado —registro local y registro
// on-chain— porque pueden discrepar, y esa discrepancia es justamente lo que
// hay que poder ver (p.ej. una clínica en el canal pero sin registrar).
import { useState } from 'react';
import { api, nombreJurisdiccion, useSSE } from '../api.js';
import Dropdown from './Dropdown.jsx';

function EstadoBadge({ estado }) {
  if (!estado) return <span className="badge warn">sin registro</span>;
  const activa = estado === 'activa' || estado === 'ACTIVA';
  return <span className={`badge ${activa ? 'permit' : 'deny'}`}>{activa ? 'activa' : 'baja'}</span>;
}

export default function ClinicsPanel({ clinics, onChanged }) {
  const [key, setKey] = useState('');
  const [nombre, setNombre] = useState('');
  const [jurisdiccion, setJurisdiccion] = useState('');
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

  // Se ofrecen las jurisdicciones que ya tienen canal provincial (alguna clínica
  // activa en ellas). Una jurisdicción nueva —que addOrg.sh sí sabe crear, con
  // su canal— se da de alta por la API; el formulario no la ofrece.
  const jurisdicciones = [...new Set(
    (clinics ?? []).filter((c) => c.activa && c.jurisdiccion).map((c) => c.jurisdiccion),
  )];

  const alta = () => correr(`alta:${key}`, async () => {
    await api('/clinics', {
      key: key.trim(),
      nombre: nombre.trim(),
      jurisdiccion: jurisdiccion || undefined,
    });
    setKey('');
    setNombre('');
    setJurisdiccion('');
  });

  // El motivo lo pone el backend por default: la baja se decide con el botón y
  // el porqué no se pedía en ningún flujo real, era un campo libre de más.
  const baja = (c) => correr(`baja:${c.key}`, () => api(`/clinics/${c.key}/baja`, {}));

  const activas = clinics.filter((c) => c.activa).length;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Instituciones del bus</h2>
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
                  <button
                    className="danger small"
                    disabled={!!busy || activas < 2}
                    title={activas < 2 ? 'No se puede dar de baja la última clínica activa' : undefined}
                    onClick={() => baja(c)}
                  >
                    Dar de baja
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="subtitulo">Nueva institución</h3>
      <div className="clinic-form">
        <label>
          Identificador
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="p.ej. rosario"
            spellCheck="false"
          />
        </label>
        <label>
          Nombre de la institución
          <input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="p.ej. Hospital Rosario" />
        </label>
        <label>
          Jurisdicción
          <Dropdown
            value={jurisdiccion}
            onChange={setJurisdiccion}
            options={[
              { value: '', label: 'Sólo canal nacional' },
              ...jurisdicciones.map((j) => ({ value: j, label: nombreJurisdiccion(j) })),
            ]}
            ariaLabel="Jurisdicción"
          />
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
