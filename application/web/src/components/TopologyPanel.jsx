// Topología de la red: orderer + peer de cada clínica + nodo IPFS, con el canal
// público como bus horizontal y el canal privado de cada institución debajo de
// su peer. Los datos: /api/status (health, poll 10s) y /api/channels según la
// org activa (alturas de bloque; los canales privados ajenos vienen como
// sinAcceso — el peer de la org activa no es miembro).
//
// El dibujo se calcula a partir de la lista de clínicas, no está fijo a dos:
// dar de alta una tercera agrega su peer y su canal sin tocar nada acá.
import { useFetch } from '../api.js';

const W = 960;
const MARGEN = 20;

function StatusDot({ ok }) {
  return <circle r="5" className={ok ? 'dot-ok' : 'dot-down'} />;
}

function NodeBox({ x, y, w = 200, title, subtitle, ok, accent }) {
  return (
    <g transform={`translate(${x - w / 2}, ${y})`}>
      <rect width={w} height="52" rx="8" className="node-box" style={accent ? { stroke: accent } : undefined} />
      <g transform="translate(16, 26)"><StatusDot ok={ok} /></g>
      <text x="30" y="22" className="node-title">{title}</text>
      <text x="30" y="40" className="node-sub">{subtitle}</text>
    </g>
  );
}

function ChannelBadge({ x, y, w = 190, name, info, accent }) {
  const label = !info ? '…' : info.sinAcceso ? 'sin acceso 🔒' : `altura: ${info.height}`;
  return (
    <g transform={`translate(${x}, ${y})`} className={info?.sinAcceso ? 'channel locked' : 'channel'}>
      <rect x={-w / 2} width={w} height="40" rx="8" style={accent && !info?.sinAcceso ? { stroke: accent } : undefined} />
      <text y="17" textAnchor="middle" className="channel-name">{name}</text>
      <text y="33" textAnchor="middle" className="channel-info">{label}</text>
    </g>
  );
}

export default function TopologyPanel({ org, clinics, tick }) {
  const { data: status } = useFetch('/status', { intervalMs: 10000 });
  const { data: channels } = useFetch(org ? `/channels?org=${org}` : '/channels', {
    deps: [tick, org],
    intervalMs: 10000,
  });

  const ch = (name) => channels?.find((c) => c.name === name);
  const activa = clinics.find((c) => c.key === org);

  const n = Math.max(clinics.length, 1);
  const paso = (W - 2 * MARGEN) / n;
  const posX = (i) => MARGEN + paso * (i + 0.5);
  // Las cajas se angostan a medida que entran más clínicas, con un piso para
  // que el MSP ID siga siendo legible (después de eso el SVG scrollea).
  const anchoCaja = Math.max(150, Math.min(200, paso - 20));

  // Con aire arriba: la caja de IPFS va a la misma altura que el orderer y
  // pegada al borde se le comía el borde superior.
  const Y_ORDERER = 18;
  const Y_BUS = 104;
  const Y_PEERS = 180;
  const Y_CANALES = 262;
  const X_IPFS = 866;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Topología de la red</h2>
        <span className="hint">
          {activa ? `vista de canales según ${activa.label}` : 'sin clínica seleccionada'}
        </span>
      </div>
      <div className="topology-scroll">
        <svg viewBox={`0 0 ${W} 340`} className="topology" style={{ minWidth: n > 4 ? `${n * 200}px` : undefined }}>
          {/* orderer -> bus del canal público */}
          <line x1={W / 2} y1={Y_ORDERER + 52} x2={W / 2} y2={Y_BUS} className="link" />
          {/* IPFS: fuera del ledger, lo usa la capa de aplicación. La línea
              arranca en el borde del orderer y termina en el de IPFS, no en
              sus centros, para no cruzar por encima de las cajas. */}
          <line x1={W / 2 + 100} y1={Y_ORDERER + 26} x2={X_IPFS - 65} y2={Y_ORDERER + 26} className="link dashed" />

          {clinics.map((c, i) => (
            <g key={`links-${c.key}`}>
              {/* bus <-> peer, y peer <-> su canal privado */}
              <line x1={posX(i)} y1={Y_BUS + 40} x2={posX(i)} y2={Y_PEERS} className="link" />
              <line x1={posX(i)} y1={Y_PEERS + 52} x2={posX(i)} y2={Y_CANALES} className="link" />
            </g>
          ))}

          <NodeBox
            x={W / 2} y={Y_ORDERER}
            title="orderer.example.com"
            subtitle={`Raft · ordena ${1 + clinics.length} canales`}
            ok={status?.orderer.ok}
          />
          <NodeBox
            x={X_IPFS} y={Y_ORDERER} w={130}
            title="IPFS (Kubo)"
            subtitle={status?.ipfs.version ? `v${status.ipfs.version} · off-chain` : 'payload cifrado'}
            ok={status?.ipfs.ok}
          />

          {/* canal-universal como bus: lo comparten todas las instituciones */}
          <ChannelBadge x={W / 2} y={Y_BUS} w={Math.min(W - 2 * MARGEN, 240 + n * 60)} name="canal-universal" info={ch('canal-universal')} />

          {clinics.map((c, i) => (
            <NodeBox
              key={`peer-${c.key}`}
              x={posX(i)} y={Y_PEERS} w={anchoCaja}
              title={`peer0.${c.key}`}
              subtitle={c.mspId}
              ok={status?.peers?.[c.key]?.ok}
              accent={c.color}
            />
          ))}

          {clinics.map((c, i) => (
            <ChannelBadge
              key={`ch-${c.key}`}
              x={posX(i)} y={Y_CANALES} w={anchoCaja}
              name={c.privateChannel}
              info={ch(c.privateChannel)}
              accent={c.color}
            />
          ))}

          <text x={W / 2} y="330" textAnchor="middle" className="topology-note">
            El payload clínico cifrado vive en IPFS; el ledger solo guarda metadatos, consentimiento y auditoría.
          </text>
        </svg>
      </div>
    </section>
  );
}
