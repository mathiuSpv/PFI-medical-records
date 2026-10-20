// Auditoría de accesos: cada CheckAccess (PERMIT o DENY) queda en el ledger
// con su motivo y con el recurso puntual que se pidió — nada se evalúa sin
// dejar rastro, y el rastro dice CUÁL recurso, no solo de qué tipo era.
import { fmtFecha, orgByMsp, rutaActivo, shortHash, useFetch } from '../api.js';

export default function AccessLogPanel({ tick }) {
  const { data: logs, error } = useFetch('/access-logs', { deps: [tick] });
  const sorted = logs ? [...logs].sort((a, b) => b.Timestamp.localeCompare(a.Timestamp)) : null;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Auditoría de accesos</h2>
      </div>
      {error && <div className="result error">{error}</div>}
      <table>
        <thead>
          <tr><th>Fecha</th><th>Solicitante</th><th>Recurso</th><th>Tipo</th><th>Paciente (ref)</th><th>Decisión</th><th>Motivo</th><th>Tx</th></tr>
        </thead>
        <tbody>
          {sorted?.map((l) => {
            const req = orgByMsp(l.RequesterOrg);
            return (
              <tr key={l.TxID}>
                <td className="muted" title={l.Timestamp}>{fmtFecha(l.Timestamp)}</td>
                <td><span className="org-badge" style={{ color: req.color }}>{req.label}</span></td>
                <td>
                  {l.FhirResourceID
                    ? <a className="enlace-activo" href={rutaActivo(l.FhirResourceID)}><code>{l.FhirResourceID}</code></a>
                    : '—'}
                </td>
                <td>{l.ResourceType}</td>
                <td><code title={l.PatientIDHash}>{shortHash(l.PatientIDHash)}</code></td>
                <td><span className={`badge ${l.Decision === 'PERMIT' ? 'permit' : 'deny'}`}>{l.Decision}</span></td>
                <td className="muted">{l.Reason || '—'}</td>
                <td><code className="muted" title={l.TxID}>{shortHash(l.TxID, 8)}</code></td>
              </tr>
            );
          })}
          {!sorted && !error && <tr><td colSpan="8" className="empty">Leyendo el ledger…</td></tr>}
          {sorted?.length === 0 && (
            <tr><td colSpan="8" className="empty">Sin evaluaciones de acceso todavía: se registran al pedir acceso desde la ficha de un activo.</td></tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
