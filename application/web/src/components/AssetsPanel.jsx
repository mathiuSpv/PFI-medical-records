// Tabla de activos emitidos en canal-nacional (metadatos públicos: el
// payload clínico está cifrado en IPFS).
import { fmtFecha, orgByMsp, rutaActivo, shortHash, useFetch } from '../api.js';

export default function AssetsPanel({ tick }) {
  const { data: assets, error } = useFetch('/assets', { deps: [tick] });

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Activos emitidos</h2>
      </div>
      {error && <div className="result error">{error}</div>}
      <table>
        <thead>
          <tr><th>ID</th><th>Tipo</th><th>CID (IPFS)</th><th>Paciente (ref)</th><th>Emisor</th><th>Fecha</th></tr>
        </thead>
        <tbody>
          {assets?.map((a) => {
            const owner = orgByMsp(a.OwnerOrg);
            return (
              <tr key={a.FhirResourceID}>
                <td><a className="enlace-activo" href={rutaActivo(a.FhirResourceID)}><code>{a.FhirResourceID}</code></a></td>
                <td>{a.ResourceType}</td>
                <td><code title={a.IpfsCid}>{shortHash(a.IpfsCid, 14)}</code></td>
                <td><code title={a.PatientIDHash}>{shortHash(a.PatientIDHash)}</code></td>
                <td><span className="org-badge" style={{ color: owner.color }}>{owner.label}</span></td>
                <td className="muted" title={a.Timestamp}>{fmtFecha(a.Timestamp)}</td>
              </tr>
            );
          })}
          {!assets && !error && <tr><td colSpan="6" className="empty">Leyendo el ledger…</td></tr>}
          {assets?.length === 0 && (
            <tr><td colSpan="6" className="empty">Todavía no se emitió ningún activo: se emiten desde Operación › Acciones.</td></tr>
          )}
        </tbody>
      </table>
    </section>
  );
}
