// Topología de la red: orderer + peer de cada clínica + nodo IPFS, con los
// tres canales. Los datos: /api/status (health, poll 10s) y /api/channels
// según la org activa (alturas de bloque; el canal privado ajeno viene como
// sinAcceso — el peer de la org activa no es miembro).
import { ORGS, useFetch } from '../api.js';

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

function ChannelBadge({ x, y, name, info, accent }) {
  const label = !info ? '…' : info.sinAcceso ? 'sin acceso 🔒' : `altura: ${info.height}`;
  return (
    <g transform={`translate(${x}, ${y})`} className={info?.sinAcceso ? 'channel locked' : 'channel'}>
      <rect x="-95" width="190" height="40" rx="8" style={accent && !info?.sinAcceso ? { stroke: accent } : undefined} />
      <text y="17" textAnchor="middle" className="channel-name">{name}</text>
      <text y="33" textAnchor="middle" className="channel-info">{label}</text>
    </g>
  );
}

export default function TopologyPanel({ org, tick }) {
  const { data: status } = useFetch('/status', { intervalMs: 10000 });
  const { data: channels } = useFetch(`/channels?org=${org}`, { deps: [tick], intervalMs: 10000 });

  const ch = (name) => channels?.find((c) => c.name === name);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Topología de la red</h2>
        <span className="hint">vista de canales según {ORGS[org].label}</span>
      </div>
      <svg viewBox="0 0 960 330" className="topology">
        {/* enlaces orderer <-> peers */}
        <line x1="480" y1="88" x2="230" y2="150" className="link" />
        <line x1="480" y1="88" x2="730" y2="150" className="link" />
        {/* peers <-> canal universal */}
        <line x1="230" y1="202" x2="480" y2="245" className="link" />
        <line x1="730" y1="202" x2="480" y2="245" className="link" />
        {/* peers <-> canal privado propio */}
        <line x1="180" y1="202" x2="150" y2="245" className="link" />
        <line x1="780" y1="202" x2="810" y2="245" className="link" />
        {/* IPFS: fuera del ledger, lo usa la capa de aplicación */}
        <line x1="480" y1="36" x2="835" y2="36" className="link dashed" />

        <NodeBox x={480} y={36} title="orderer.example.com" subtitle="Raft · ordena los 3 canales" ok={status?.orderer.ok} />
        <NodeBox
          x={230} y={150}
          title="peer0.sancristobal"
          subtitle={ORGS.sancristobal.mspId}
          ok={status?.peers.sancristobal.ok}
          accent="var(--sc)"
        />
        <NodeBox
          x={730} y={150}
          title="peer0.montenegro"
          subtitle={ORGS.montenegro.mspId}
          ok={status?.peers.montenegro.ok}
          accent="var(--mn)"
        />
        <NodeBox
          x={890} y={12} w={130}
          title="IPFS (Kubo)"
          subtitle={status?.ipfs.version ? `v${status.ipfs.version} · off-chain` : 'payload cifrado'}
          ok={status?.ipfs.ok}
        />

        <ChannelBadge x={480} y={250} name="canal-universal" info={ch('canal-universal')} />
        <ChannelBadge x={150} y={250} name="canal-sancristobal" info={ch('canal-sancristobal')} accent="var(--sc)" />
        <ChannelBadge x={810} y={250} name="canal-montenegro" info={ch('canal-montenegro')} accent="var(--mn)" />

        <text x="480" y="320" textAnchor="middle" className="topology-note">
          El payload clínico cifrado vive en IPFS; el ledger solo guarda metadatos, consentimiento y auditoría.
        </text>
      </svg>
    </section>
  );
}
