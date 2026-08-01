// Consentimientos: estado actual + historial de versiones del ledger
// (GetHistoryForKey) expandible por fila — cada grant/revoke queda como una
// versión separada e inmutable.
import { useState } from 'react';
import { api, orgByMsp, shortHash, useFetch } from '../api.js';

function estado(c) {
  if (c.Revoked) return { label: 'revocado', cls: 'deny' };
  if (new Date(c.Expiry) <= new Date()) return { label: 'vencido', cls: 'warn' };
  return { label: 'vigente', cls: 'permit' };
}

export default function ConsentsPanel({ tick }) {
  const { data: consents, error } = useFetch('/consents', { deps: [tick] });
  const [openKey, setOpenKey] = useState(null);
  const [history, setHistory] = useState(null);

  const toggleHistory = async (c) => {
    const key = `${c.PatientIDHash}:${c.GrantedToOrg}`;
    if (openKey === key) {
      setOpenKey(null);
      return;
    }
    setOpenKey(key);
    setHistory(null);
    try {
      setHistory(await api(`/consents/history?patientIDHash=${c.PatientIDHash}&grantedToOrg=${c.GrantedToOrg}`));
    } catch (err) {
      setHistory({ error: err.message });
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Consentimientos</h2>
        <span className="hint">deny por defecto — solo existe lo otorgado explícitamente</span>
      </div>
      {error && <div className="result error">{error}</div>}
      <table>
        <thead>
          <tr><th>Paciente (hash)</th><th>Otorgado por</th><th>Otorgado a</th><th>Resource types</th><th>Vence</th><th>Estado</th><th></th></tr>
        </thead>
        <tbody>
          {consents?.map((c) => {
            const key = `${c.PatientIDHash}:${c.GrantedToOrg}`;
            const st = estado(c);
            const by = orgByMsp(c.GrantedByOrg);
            const to = orgByMsp(c.GrantedToOrg);
            return [
              <tr key={key}>
                <td><code title={c.PatientIDHash}>{shortHash(c.PatientIDHash)}</code></td>
                <td><span className="org-badge" style={{ color: by.color }}>{by.label}</span></td>
                <td><span className="org-badge" style={{ color: to.color }}>{to.label}</span></td>
                <td>{c.ResourceTypes.length ? c.ResourceTypes.join(', ') : '—'}</td>
                <td className="muted">{c.Expiry.slice(0, 10)}</td>
                <td><span className={`badge ${st.cls}`}>{st.label}</span></td>
                <td><button className="link" onClick={() => toggleHistory(c)}>{openKey === key ? 'ocultar' : 'historial'}</button></td>
              </tr>,
              openKey === key && (
                <tr key={`${key}-h`} className="history-row">
                  <td colSpan="7">
                    {!history && 'Cargando historial…'}
                    {history?.error && <span className="error-text">{history.error}</span>}
                    {Array.isArray(history) && (
                      <ol className="timeline">
                        {history.map((h) => (
                          <li key={h.TxID}>
                            <span className="muted">{h.Timestamp}</span> — {h.Consent?.Revoked ? 'revocación' : 'otorgamiento'}:
                            {' '}{h.Consent?.ResourceTypes?.length ? h.Consent.ResourceTypes.join(', ') : 'sin tipos vigentes'}
                            {' '}<code className="muted" title={h.TxID}>tx {shortHash(h.TxID, 8)}</code>
                          </li>
                        ))}
                      </ol>
                    )}
                  </td>
                </tr>
              ),
            ];
          })}
          {consents?.length === 0 && <tr><td colSpan="7" className="empty">Sin consentimientos — todo acceso cruzado da DENY.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
