// Feed en vivo (SSE): eventos AccessPermitted del chaincode y entregas de
// clave (la org dueña envuelve la clave AES para el certificado del
// solicitante). Cada entrega se puede "descifrar como" la org destinataria:
// el backend desenvuelve la clave con la clave privada de esa org, baja el
// blob de IPFS y devuelve el recurso FHIR en claro — el círculo completo.
import { useState } from 'react';
import { api, fmtTs, orgByMsp, shortHash } from '../api.js';

function DeliveryCard({ delivery }) {
  const [decrypted, setDecrypted] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const from = orgByMsp(delivery.fromOrg);
  const to = orgByMsp(delivery.toOrg);

  const decrypt = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api(`/deliveries/${delivery.id}/decrypt`, { org: delivery.recipientOrgKey });
      setDecrypted(res.resource);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="feed-item delivery">
      <div className="feed-title">
        🔑 Entrega de clave <span className="muted">(simulada)</span>
      </div>
      <div className="feed-body">
        <span className="org-badge" style={{ color: from.color }}>{from.label}</span>
        {' → '}
        <span className="org-badge" style={{ color: to.color }}>{to.label}</span>
        <div className="muted">{delivery.resourceType} · <code>{delivery.fhirResourceID}</code></div>
        <details>
          <summary>Sobre (ECDH P-256 + HKDF + AES-256-GCM)</summary>
          <pre>{JSON.stringify(delivery.envelope, null, 2)}</pre>
        </details>
        {!decrypted && (
          <button className="primary small" disabled={busy} onClick={decrypt}>
            {busy ? 'Descifrando…' : `Descifrar como ${to.label}`}
          </button>
        )}
        {error && <div className="error-text">{error}</div>}
        {decrypted && (
          <details open>
            <summary>Recurso FHIR descifrado</summary>
            <pre className="decrypted">{JSON.stringify(decrypted, null, 2)}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

export default function EventFeed({ feed }) {
  return (
    <section className="panel feed-panel">
      <div className="panel-head">
        <h2>Eventos en vivo</h2>
        <span className="hint">SSE · canal-universal</span>
      </div>
      <div className="feed">
        {feed.length === 0 && <div className="empty">Sin eventos todavía. Un CheckAccess con PERMIT dispara el primero.</div>}
        {feed.map((item, i) => {
          if (item.type === 'key-delivery') {
            return <DeliveryCard key={item.delivery.id} delivery={item.delivery} />;
          }

          // Alta y baja de instituciones: el registro on-chain también emite
          // eventos, y no se leen como un acceso (no hay solicitante ni
          // paciente), así que tienen su propia tarjeta.
          if (item.type === 'clinic-event') {
            const alta = item.eventName === 'ClinicRegistered';
            return (
              <div className="feed-item" key={`${item.txId}-${i}`}>
                <div className="feed-title">
                  {alta ? '🏥' : '🚪'} {item.eventName} <span className="muted">{fmtTs(item.receivedAt)}</span>
                </div>
                <div className="feed-body">
                  <span className="org-badge" style={{ color: orgByMsp(item.mspId).color }}>
                    {orgByMsp(item.mspId).label ?? item.nombre ?? item.mspId}
                  </span>
                  {alta ? ' se incorporó al bus' : ' fue dada de baja del bus'}
                  <div className="muted">
                    <code>{item.mspId}</code>
                    {' · bloque '}{item.blockNumber}
                    {' · tx '}<code title={item.txId}>{shortHash(item.txId, 8)}</code>
                  </div>
                </div>
              </div>
            );
          }

          const req = orgByMsp(item.requesterOrg);
          return (
            <div className="feed-item" key={`${item.txId}-${i}`}>
              <div className="feed-title">⚡ {item.eventName} <span className="muted">{fmtTs(item.receivedAt)}</span></div>
              <div className="feed-body">
                <span className="org-badge" style={{ color: req.color }}>{req.label}</span>
                {' obtuvo PERMIT sobre '}<code>{item.fhirResourceID}</code>
                <div className="muted">
                  {item.resourceType}
                  {' · paciente '}<code title={item.patientIDHash}>{shortHash(item.patientIDHash)}</code>
                  {' · bloque '}{item.blockNumber}
                  {' · tx '}<code title={item.txId}>{shortHash(item.txId, 8)}</code>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
