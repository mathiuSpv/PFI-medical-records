// Tabla de activos emitidos en canal-universal (metadatos públicos: el
// payload clínico está cifrado en IPFS).
import { orgByMsp, shortHash, useFetch } from '../api.js';

export default function AssetsPanel({ tick }) {
  const { data: assets, error } = useFetch('/assets', { deps: [tick] });

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Activos emitidos</h2>
        <span className="hint">{assets ? `${assets.length} en el ledger` : ''}</span>
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
                <td><code>{a.FhirResourceID}</code></td>
                <td>{a.ResourceType}</td>
                <td><code title={a.IpfsCid}>{shortHash(a.IpfsCid, 14)}</code></td>
                <td><code title={a.PatientIDHash}>{shortHash(a.PatientIDHash)}</code></td>
                <td><span className="org-badge" style={{ color: owner.color }}>{owner.label}</span></td>
                <td className="muted">{a.Timestamp}</td>
              </tr>
            );
          })}
          {assets?.length === 0 && <tr><td colSpan="6" className="empty">Sin activos todavía — emití uno desde Acciones.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
