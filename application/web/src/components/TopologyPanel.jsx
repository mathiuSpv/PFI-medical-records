// Topología de la red: orderer + canal-universal como bus + peer de cada
// institución con su canal privado debajo, y el almacenamiento off-chain en una
// banda aparte. Los datos: /api/status (health, poll 10s) y /api/channels según
// la org activa (alturas de bloque; los canales privados ajenos vienen como
// sinAcceso — el peer de la org activa no es miembro).
//
// El dibujo se calcula a partir de la lista de instituciones, no está fijo a
// dos: dar de alta una tercera agrega su peer y su canal sin tocar nada acá. A
// partir de cierta cantidad el SVG se ensancha y scrollea en vez de comprimir
// las cajas hasta volverlas ilegibles.
//
// IPFS va en una banda propia y NO cuelga del orderer. La versión anterior
// dibujaba una línea orderer → IPFS que era falsa: el almacenamiento off-chain
// lo usa la capa de aplicación de cada institución, no el servicio de
// ordenamiento. Por eso los punteados bajan desde cada peer.
import { useState } from 'react';
import { colorFor, useFetch } from '../api.js';

const BASE_W = 960;
const MARGEN = 20;

// Alturas de cada banda. El alto total sale de la última más su caja.
const Y_ORDERER = 16;
const H_CAJA = 52;
const Y_RAIL = 112;
const Y_PEERS = 158;
const Y_CANALES = 246;
const H_BADGE = 40;
const Y_OFFCHAIN = 324;
const H_BANDA = 48;
const Y_LEYENDA = 398;
const H_SVG = 416;

// Instituciones simuladas para previsualizar el layout. No salen del registro:
// sirven para ver cómo queda el dibujo con más nodos sin tener que dar de alta
// orgs reales (que generan material criptográfico y levantan contenedores).
// Van marcadas como simulado en todo el dibujo para que una captura de
// pantalla no pueda confundirse con la red real.
function institucionesSimuladas(cantidad) {
  return Array.from({ length: cantidad }, (_, i) => ({
    key: `generica${i + 1}`,
    label: `Clínica Genérica ${i + 1}`,
    mspId: `ClinicaGenerica${i + 1}MSP`,
    privateChannel: `canal-generica-${i + 1}`,
    color: colorFor(`generica${i + 1}`),
    simulado: true,
  }));
}

function StatusDot({ ok, simulado }) {
  if (simulado) return <circle r="5" className="dot-sim" />;
  return <circle r="5" className={ok ? 'dot-ok' : 'dot-down'} />;
}

function NodeBox({ x, y, w = 200, title, subtitle, ok, simulado, accent }) {
  return (
    <g transform={`translate(${x - w / 2}, ${y})`}>
      <rect width={w} height={H_CAJA} rx="8" className="node-box" style={accent ? { stroke: accent } : undefined} />
      <g transform={`translate(16, ${H_CAJA / 2})`}><StatusDot ok={ok} simulado={simulado} /></g>
      <text x="30" y="22" className="node-title">{title}</text>
      <text x="30" y="40" className="node-sub">{subtitle}</text>
    </g>
  );
}

function ChannelBadge({ x, y, w = 190, name, info, simulado, accent }) {
  const label = simulado ? 'simulado' : !info ? '…' : info.sinAcceso ? 'sin acceso 🔒' : `altura: ${info.height}`;
  const bloqueado = !simulado && info?.sinAcceso;
  return (
    <g transform={`translate(${x}, ${y})`} className={bloqueado ? 'channel locked' : 'channel'}>
      <rect x={-w / 2} width={w} height={H_BADGE} rx="8" style={accent && !bloqueado ? { stroke: accent } : undefined} />
      <text y="17" textAnchor="middle" className="channel-name">{name}</text>
      <text y="33" textAnchor="middle" className="channel-info">{label}</text>
    </g>
  );
}

export default function TopologyPanel({ org, clinics, tick }) {
  const [preview, setPreview] = useState(0);

  const { data: status } = useFetch('/status', { intervalMs: 10000 });
  const { data: channels } = useFetch(org ? `/channels?org=${org}` : '/channels', {
    deps: [tick, org],
    intervalMs: 10000,
  });

  const ch = (name) => channels?.find((c) => c.name === name);

  const reales = clinics;
  const dibujadas = preview ? institucionesSimuladas(preview) : reales;
  // En vista previa se resalta la primera: no hay org activa real que resaltar.
  const keyActiva = preview ? dibujadas[0]?.key : org;
  const activa = reales.find((c) => c.key === org);

  const n = Math.max(dibujadas.length, 1);
  // paso con piso: por debajo de 180 px el MSP ID deja de entrar. Cuando el
  // piso manda, el SVG se ensancha y el contenedor scrollea.
  const paso = Math.max(180, (BASE_W - 2 * MARGEN) / n);
  const W = Math.max(BASE_W, 2 * MARGEN + paso * n);
  const posX = (i) => MARGEN + paso * (i + 0.5);
  const anchoCaja = Math.max(150, Math.min(210, paso - 24));

  const infoBus = preview ? null : ch('canal-universal');
  const labelBus = preview
    ? 'simulado'
    : !infoBus ? '…' : infoBus.sinAcceso ? 'sin acceso 🔒' : `altura: ${infoBus.height}`;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Topología de la red</h2>
        <div className="topology-controls">
          {preview ? (
            <span className="badge warn">vista previa · {preview} instituciones simuladas</span>
          ) : (
            <span className="hint">
              {activa ? `vista de canales según ${activa.label}` : 'sin institución seleccionada'}
            </span>
          )}
          <span className="preview-switch" role="group" aria-label="Cantidad de instituciones a previsualizar">
            <span className="preview-label">ver con</span>
            {[0, 4, 6, 8].map((cant) => (
              <button
                key={cant}
                className={`chip ${preview === cant ? 'active' : ''}`}
                onClick={() => setPreview(cant)}
                title={cant === 0 ? 'Instituciones reales del registro' : `Previsualizar con ${cant} instituciones simuladas`}
              >
                {cant === 0 ? `reales (${reales.length})` : cant}
              </button>
            ))}
          </span>
        </div>
      </div>

      <div className="topology-scroll">
        <svg
          viewBox={`0 0 ${W} ${H_SVG}`}
          className={`topology ${preview ? 'is-preview' : ''}`}
          style={W > BASE_W ? { minWidth: `${W}px` } : undefined}
          role="img"
          aria-label={`Topología de la red con ${n} instituciones: un servicio de ordenamiento, el canal universal compartido, un peer y un canal privado por institución, y almacenamiento IPFS fuera del ledger.`}
        >
          {/* Punta de flecha para las bajadas off-chain. Sin ella, con muchas
              instituciones las líneas punteadas se leen como separadores de
              columna en vez de como conexiones hacia la banda de IPFS. */}
          <defs>
            <marker id="flecha-offchain" viewBox="0 0 8 8" refX="4" refY="4"
                    markerWidth="6" markerHeight="6" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" className="punta-offchain" />
            </marker>
          </defs>

          {/* Columna resaltada: la institución con cuya identidad se está
              mirando la red. Sin esto, "vista de canales según X" es una
              afirmación del header que el dibujo no acompaña. */}
          {dibujadas.map((c, i) => c.key === keyActiva && (
            <rect
              key={`hl-${c.key}`}
              x={posX(i) - anchoCaja / 2 - 12} y={Y_PEERS - 14}
              width={anchoCaja + 24} height={Y_CANALES + H_BADGE + 14 - Y_PEERS}
              rx="12" className="col-activa" style={{ fill: c.color, stroke: c.color }}
            />
          ))}

          {/* orderer -> rail del canal público */}
          <line x1={W / 2} y1={Y_ORDERER + H_CAJA} x2={W / 2} y2={Y_RAIL} className="link" />

          {/* El bus propiamente dicho: una barra que cruza todo el ancho y de la
              que cada institución toma una derivación. */}
          <line x1={MARGEN} y1={Y_RAIL} x2={W - MARGEN} y2={Y_RAIL} className="bus-rail" />
          {/* La etiqueta del bus se ata al rail con un tramo corto: flotando
              suelta arriba se leía como un título aparte y no como el nombre
              de la barra. */}
          <line x1={MARGEN + 20} y1={Y_RAIL - 8} x2={MARGEN + 20} y2={Y_RAIL} className="bus-stem" />
          <g transform={`translate(${MARGEN}, ${Y_RAIL - 42})`} className="bus-pill">
            <rect width="240" height="34" rx="8" />
            <text x="12" y="14" className="channel-name">canal-universal</text>
            <text x="12" y="28" className="channel-info">bus compartido · {labelBus}</text>
          </g>

          {dibujadas.map((c, i) => (
            <g key={`links-${c.key}`}>
              {/* derivación del bus al peer, y del peer a su canal privado */}
              <circle cx={posX(i)} cy={Y_RAIL} r="4" className="bus-tap" style={{ fill: c.color }} />
              <line x1={posX(i)} y1={Y_RAIL} x2={posX(i)} y2={Y_PEERS} className="link" />
              <line x1={posX(i)} y1={Y_PEERS + H_CAJA} x2={posX(i)} y2={Y_CANALES} className="link" />
              {/* bajada punteada a IPFS: sale del peer y esquiva el badge del
                  canal privado por el pasillo que queda a su izquierda. */}
              <path
                className="link dashed"
                markerEnd="url(#flecha-offchain)"
                d={`M ${posX(i) - anchoCaja / 2} ${Y_PEERS + H_CAJA}
                    V ${Y_PEERS + H_CAJA + 14}
                    H ${posX(i) - anchoCaja / 2 - 10}
                    V ${Y_OFFCHAIN - 7}`}
              />
            </g>
          ))}

          <NodeBox
            x={W / 2} y={Y_ORDERER}
            title="orderer.example.com"
            subtitle={`Raft · ordena ${1 + n} canales`}
            ok={status?.orderer.ok}
            simulado={!!preview}
          />

          {dibujadas.map((c, i) => (
            <NodeBox
              key={`peer-${c.key}`}
              x={posX(i)} y={Y_PEERS} w={anchoCaja}
              title={`peer0.${c.keyLabel ?? c.key}`}
              subtitle={c.mspLabel ?? c.mspId}
              ok={status?.peers?.[c.key]?.ok}
              simulado={c.simulado}
              accent={c.color}
            />
          ))}

          {dibujadas.map((c, i) => (
            <ChannelBadge
              key={`ch-${c.key}`}
              x={posX(i)} y={Y_CANALES} w={anchoCaja}
              name={c.channelLabel ?? c.privateChannel}
              info={ch(c.privateChannel)}
              simulado={c.simulado}
              accent={c.color}
            />
          ))}

          {/* Banda off-chain: un solo nodo IPFS que usan todas las capas de
              aplicación. Va con borde punteado y separado del resto para que se
              lea que está fuera del ledger. */}
          <g transform={`translate(${MARGEN}, ${Y_OFFCHAIN})`} className="offchain">
            <rect width={W - 2 * MARGEN} height={H_BANDA} rx="10" />
            <g transform={`translate(18, ${H_BANDA / 2})`}><StatusDot ok={status?.ipfs.ok} simulado={!!preview} /></g>
            <text x="34" y={H_BANDA / 2 - 3} className="node-title">
              IPFS (Kubo){status?.ipfs.version ? ` · v${status.ipfs.version}` : ''}
            </text>
            <text x="34" y={H_BANDA / 2 + 14} className="node-sub">
              Payload clínico cifrado, fuera del ledger — lo escribe y lo lee la capa de aplicación de cada institución, no el orderer.
            </text>
          </g>

          {/* Leyenda: sin esto nadie sabe qué distingue una línea sólida de una
              punteada, que es justo la separación on-chain / off-chain. */}
          <g transform={`translate(${MARGEN}, ${Y_LEYENDA})`} className="leyenda">
            <line x1="0" y1="-4" x2="26" y2="-4" className="link" />
            <text x="34" y="0">membresía de canal (on-chain)</text>
            <line x1="240" y1="-4" x2="266" y2="-4" className="link dashed" />
            <text x="274" y="0">almacenamiento off-chain</text>
            <rect x="470" y="-11" width="14" height="14" rx="3" className="muestra-locked" />
            <text x="492" y="0">canal del que la institución activa no es miembro</text>
          </g>
        </svg>
      </div>
    </section>
  );
}
