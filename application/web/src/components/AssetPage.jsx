// Página de un activo médico digital: la ficha del documento y, para cada
// acceso que se le pidió, el bloque del ledger donde quedó asentado.
//
// El bloque no viene con los datos del activo: se pide por TxID a
// /api/blocks/by-tx, que consulta el system chaincode qscc. Por eso cada acceso
// resuelve su bloque por separado y muestra su propio estado de carga: si el
// peer no responde para uno, los demás igual se ven.
//
// La emisión del activo no tiene bloque acá, y se dice explícitamente: el
// chaincode no guarda el TxID de la emisión ni expone el historial del activo,
// así que no hay por dónde buscarlo.
import { useEffect, useState } from 'react';
import { api, clinicByKey, irA, orgByMsp, useFetch } from '../api.js';

function Bloque({ txId }) {
  const [estado, setEstado] = useState({ cargando: true });

  useEffect(() => {
    let vivo = true;
    setEstado({ cargando: true });
    api(`/blocks/by-tx/${txId}`)
      .then((datos) => { if (vivo) setEstado({ datos }); })
      .catch((err) => { if (vivo) setEstado({ error: err.message }); });
    return () => { vivo = false; };
  }, [txId]);

  if (estado.cargando) return <div className="bloque bloque-pendiente">Buscando el bloque…</div>;
  if (estado.error) {
    return (
      <div className="bloque bloque-error">
        No se pudo leer el bloque: {estado.error}
      </div>
    );
  }

  const b = estado.datos;
  return (
    <div className="bloque">
      <div className="bloque-num">bloque #{b.numero}</div>
      <dl className="props">
        <div><dt>Canal</dt><dd><code>{b.canal}</code></dd></div>
        <div><dt>Transacciones en el bloque</dt><dd>{b.transacciones}</dd></div>
        <div><dt>Hash de datos</dt><dd><code className="hash">{b.dataHash || '—'}</code></dd></div>
        <div><dt>Hash del bloque anterior</dt><dd><code className="hash">{b.previousHash || '—'}</code></dd></div>
      </dl>
    </div>
  );
}

// Un año de vigencia: el chaincode exige vencimiento futuro y no acepta
// consentimientos sin plazo, así que hay que fijar uno. Para operar por clic
// se toma el mismo valor por defecto que el formulario completo.
function vencimientoPorDefecto() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return `${d.toISOString().slice(0, 10)}T23:59:59Z`;
}

export default function AssetPage({ id, tick, org, activas = [], onDone }) {
  const [ocupado, setOcupado] = useState(null);
  const [resultado, setResultado] = useState(null);
  const [destino, setDestino] = useState('');

  // Las tres acciones comparten forma: bloquean, ejecutan, refrescan y dejan el
  // resultado a la vista. Sin formularios: el recurso ya es este, la identidad
  // sale del selector del header y el resto se deriva del activo.
  const correr = async (accion, etiqueta, fn) => {
    setOcupado(accion);
    setResultado(null);
    try {
      const data = await fn();
      setResultado({ ok: true, accion, etiqueta, data });
      onDone?.();
    } catch (err) {
      setResultado({ ok: false, etiqueta, error: err.message });
    } finally {
      setOcupado(null);
    }
  };

  const { data: assets } = useFetch('/assets', { deps: [tick] });
  const { data: logs } = useFetch('/access-logs', { deps: [tick] });
  const { data: consents } = useFetch('/consents', { deps: [tick] });

  const activo = assets?.find((a) => a.FhirResourceID === id);
  const accesos = (logs ?? [])
    .filter((l) => l.FhirResourceID === id)
    .sort((a, b) => String(b.Timestamp).localeCompare(String(a.Timestamp)));

  const consentimientos = (consents ?? []).filter((c) => c.PatientIDHash === activo?.PatientIDHash);

  const cargandoHistorial = !logs || !consents;
  const entradas = consentimientos.length + accesos.length;

  const volver = (
    <button className="chip" onClick={() => irA('/')}>← volver al mapa</button>
  );

  if (assets && !activo) {
    return (
      <section className="panel">
        <div className="panel-head"><h2>Activo no encontrado</h2>{volver}</div>
        <p className="hint">
          No hay ningún activo con el identificador <code>{id}</code> en el ledger.
        </p>
      </section>
    );
  }

  if (!activo) {
    return (
      <section className="panel">
        <div className="panel-head"><h2>Cargando…</h2>{volver}</div>
      </section>
    );
  }

  const emisor = orgByMsp(activo.OwnerOrg);
  const yo = clinicByKey(org);

  // Ceder es potestad de quien emitió el documento: el chaincode rechaza un
  // GrantConsent que no venga de la org dueña del activo.
  const soyDuenio = yo?.mspId === activo.OwnerOrg;
  const destinatarias = activas.filter((c) => c.mspId !== activo.OwnerOrg);
  const destinoValido = destinatarias.some((c) => c.key === destino)
    ? destino
    : destinatarias[0]?.key ?? '';
  const orgDestino = destinatarias.find((c) => c.key === destinoValido);

  const consentDestino = consentimientos.find((c) => c.GrantedToOrg === orgDestino?.mspId);
  const cedido = consentDestino && !consentDestino.Revoked
    && new Date(consentDestino.Expiry) > new Date();

  const ceder = () => correr('ceder', 'Consentimiento otorgado', () => api('/consents', {
    org,
    grantedToOrg: orgDestino.mspId,
    patientIDHash: activo.PatientIDHash,
    resourceTypes: [activo.ResourceType],
    expiry: vencimientoPorDefecto(),
  }));

  const revocar = () => correr('revocar', 'Consentimiento revocado', () => api('/consents/revoke', {
    org,
    grantedToOrg: orgDestino.mspId,
    patientIDHash: activo.PatientIDHash,
    // Lista vacía: revoca todo lo otorgado, no solo este tipo.
    resourceTypes: [],
  }));

  const pedirAcceso = () => correr('pedir', 'CheckAccess', () =>
    api('/check-access', { org, fhirResourceID: id }));

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{activo.FhirResourceID}</h2>
            <span className="hint">
              {activo.ResourceType} · emitido por{' '}
              <strong style={{ color: emisor.color }}>{emisor.label}</strong>
            </span>
          </div>
          {volver}
        </div>

        {/* Las dos acciones del circuito, por clic. Cuál se ofrece depende de
            con qué identidad se esté operando: el dueño cede, el resto pide. */}
        <div className="acciones-activo">
          <button className="primary" disabled={!!ocupado || !org} onClick={pedirAcceso}>
            {ocupado === 'pedir' ? 'Evaluando…' : `Pedir acceso como ${yo?.label ?? org}`}
          </button>

          {soyDuenio && orgDestino && (
            <>
              <label className="field-label">
                Ceder a
                <select
                  value={destinoValido}
                  onChange={(e) => setDestino(e.target.value)}
                  disabled={!!ocupado || destinatarias.length < 2}
                >
                  {destinatarias.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
              </label>
              {cedido ? (
                <button className="danger" disabled={!!ocupado} onClick={revocar}>
                  {ocupado === 'revocar' ? 'Revocando…' : 'Revocar consentimiento'}
                </button>
              ) : (
                <button disabled={!!ocupado} onClick={ceder}>
                  {ocupado === 'ceder' ? 'Cediendo…' : `Ceder ${activo.ResourceType} por un año`}
                </button>
              )}
            </>
          )}

          {!soyDuenio && (
            <span className="hint">
              Para ceder este documento hay que operar como {emisor.label}, que fue quien lo emitió.
            </span>
          )}
        </div>

        {resultado && !resultado.ok && (
          <div className="result error"><strong>{resultado.etiqueta} falló</strong>: {resultado.error}</div>
        )}
        {resultado?.ok && resultado.accion === 'pedir' && (
          <div className={`result decision ${resultado.data.decision === 'PERMIT' ? 'permit' : 'deny'}`}>
            {resultado.data.decision}
            {resultado.data.reason && <span className="reason"> — {resultado.data.reason}</span>}
          </div>
        )}
        {resultado?.ok && resultado.accion !== 'pedir' && (
          <div className="result ok"><strong>{resultado.etiqueta}</strong> — ya se ve en el historial.</div>
        )}

        <dl className="props props-anchas">
          <div><dt>Tipo FHIR</dt><dd>{activo.ResourceType}</dd></div>
          <div><dt>Emitido</dt><dd>{String(activo.Timestamp).replace('T', ' ').replace('Z', '')}</dd></div>
          <div><dt>Paciente</dt><dd><code className="hash">{activo.PatientIDHash}</code></dd></div>
          <div><dt>CID en IPFS</dt><dd><code className="hash">{activo.IpfsCid}</code></dd></div>
          <div><dt>Contenido</dt><dd>cifrado AES-256-GCM, fuera del ledger</dd></div>
          <div><dt>Bloque de emisión</dt><dd className="muted">no disponible</dd></div>
        </dl>

      </section>

      {/* Historial único: consentimientos y accesos son la misma historia del
          documento y separarlos obligaba a leer dos listas para reconstruirla.
          Los consentimientos van primero porque no traen fecha de otorgamiento
          —el chaincode guarda el vencimiento, no la creación— y no hay con qué
          intercalarlos entre los accesos. */}
      <section className="panel">
        <div className="panel-head">
          <h2>Historial</h2>
          <span className="hint">
            {cargandoHistorial
              ? 'cargando…'
              : `${entradas} ${entradas === 1 ? 'entrada' : 'entradas'} sobre este documento`}
          </span>
        </div>

        {!cargandoHistorial && entradas === 0 && (
          <p className="hint">Todavía no hay movimientos sobre este documento.</p>
        )}

        <ol className="accesos">
          {consentimientos.map((c) => {
            const para = orgByMsp(c.GrantedToOrg);
            const vencido = new Date(c.Expiry) <= new Date();
            const estado = c.Revoked ? 'revocado' : vencido ? 'vencido' : 'vigente';
            return (
              <li key={`c:${c.GrantedToOrg}`}>
                <div className="acceso-cab">
                  <span className={`badge ${estado === 'vigente' ? 'permit' : estado === 'revocado' ? 'deny' : 'warn'}`}>
                    {estado}
                  </span>
                  <strong>Consentimiento</strong>
                  <span className="muted">otorgado a</span>
                  <strong style={{ color: para.color }}>{para.label}</strong>
                </div>
                <div className="muted">
                  {c.ResourceTypes?.length ? c.ResourceTypes.join(', ') : 'sin tipos'}
                  {' · vence '}{String(c.Expiry).slice(0, 10)}
                </div>
              </li>
            );
          })}

          {accesos.map((l) => {
            const quien = orgByMsp(l.RequesterOrg);
            return (
              <li key={l.TxID}>
                <div className="acceso-cab">
                  <span className={`badge ${l.Decision === 'PERMIT' ? 'permit' : 'deny'}`}>{l.Decision}</span>
                  <strong style={{ color: quien.color }}>{quien.label}</strong>
                  <span className="muted">pidió acceso</span>
                  <span className="muted">{String(l.Timestamp).replace('T', ' ').replace('Z', '')}</span>
                </div>
                {l.Reason && <div className="muted">{l.Reason}</div>}
                <div className="muted">tx <code className="hash">{l.TxID}</code></div>
                <Bloque txId={l.TxID} />
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}
