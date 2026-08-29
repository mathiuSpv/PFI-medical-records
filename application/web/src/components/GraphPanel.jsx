// Vista de grafo: la trazabilidad de cada activo médico digital.
//
// Dos entidades y una relación: la institución emitió el documento. Todo lo
// auditable —quién lo pidió, cuándo, qué respondió el chaincode y bajo qué
// consentimiento— vive dentro de esa línea, no como aristas aparte.
//
// El layout NO se anima: se calcula entero y se pinta ya acomodado. Ver el
// grafo sacudirse hasta encontrar su lugar no aporta y se ve mal.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RUTA_MAPA, irA, orgByMsp, rutaActivo, useFetch } from '../api.js';
import { TIPOS, acomodar, construirGrafo } from '../grafo.js';

// El lienzo arranca bajo —el grafo comparte la solapa con el ABM, que va abajo,
// y un mapa alto empuja los formularios fuera de la pantalla— pero crece con la
// cantidad de nodos: con 30 y pico apretados en 440 px los rótulos se pisan.
// En pantalla completa el SVG se estira y recupera todo el alto igual.
const W = 1120;
const H_MIN = 440;
const H_MAX = 900;
const altoPara = (nodos) => Math.min(H_MAX, Math.max(H_MIN, 300 + nodos * 13));

// Distancia del centro del nodo a su borde en la dirección dada. El activo se
// dibuja como rectángulo, así que un radio fijo dejaría la punta de la flecha
// flotando o metida adentro según por dónde llegue.
function radioBorde(nodo, dx, dy) {
  const t = TIPOS[nodo.tipo];
  if (nodo.tipo !== 'activo') return t.radio;
  const hw = t.radio;
  const hh = t.radio * 0.72;
  const ax = Math.abs(dx) || 0.001;
  const ay = Math.abs(dy) || 0.001;
  const d = Math.sqrt(ax * ax + ay * ay);
  return ax * hh > ay * hw ? (hw * d) / ax : (hh * d) / ay;
}

export default function GraphPanel({ clinics, tick, soloMapa = false }) {
  const { data: assets } = useFetch('/assets', { deps: [tick] });
  const { data: consents } = useFetch('/consents', { deps: [tick] });
  const { data: logs } = useFetch('/access-logs', { deps: [tick] });

  const [sel, setSel] = useState(null);
  const [hover, setHover] = useState(null);
  const [vista, setVista] = useState({ x: 0, y: 0, k: 1 });
  const [, setFrame] = useState(0);

  const svgRef = useRef(null);
  const mundoRef = useRef(null);
  const nodosRef = useRef([]);
  const arrastreRef = useRef(null);

  const grafo = useMemo(
    () => construirGrafo({
      clinics,
      assets,
      consents,
      logs,
      etiquetaOrg: (msp) => orgByMsp(msp).label,
    }),
    [clinics, assets, consents, logs],
  );

  const H = altoPara(grafo.nodos.length);

  // El layout se resuelve completo antes de pintar. Las posiciones de los nodos
  // que ya estaban se conservan: si no, emitir un activo reordenaría todo el
  // grafo y se perdería la referencia visual.
  useEffect(() => {
    const previas = new Map(nodosRef.current.map((n) => [n.id, n]));
    const nodos = grafo.nodos.map((n) => ({ ...n }));
    acomodar(nodos, grafo.aristas, W, H);
    for (const n of nodos) {
      const vieja = previas.get(n.id);
      if (vieja) {
        n.x = vieja.x;
        n.y = vieja.y;
        n.fijo = vieja.fijo;
      }
    }
    nodosRef.current = nodos;
    setFrame((f) => f + 1);
  }, [grafo, H]);

  const reacomodar = useCallback(() => {
    const nodos = grafo.nodos.map((n) => ({ ...n }));
    acomodar(nodos, grafo.aristas, W, H);
    nodosRef.current = nodos;
    setVista({ x: 0, y: 0, k: 1 });
    setFrame((f) => f + 1);
  }, [grafo, H]);


  // Pantalla -> coordenadas del grafo. Se toma la matriz del grupo que lleva el
  // transform de zoom/pan, así la conversión ya contempla la vista actual.
  const aMundo = (evt) => {
    const svg = svgRef.current;
    const g = mundoRef.current;
    if (!svg || !g) return { x: 0, y: 0 };
    const p = svg.createSVGPoint();
    p.x = evt.clientX;
    p.y = evt.clientY;
    const m = g.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const q = p.matrixTransform(m.inverse());
    return { x: q.x, y: q.y };
  };

  useEffect(() => {
    const mover = (evt) => {
      const arr = arrastreRef.current;
      if (!arr) return;
      if (arr.tipo === 'nodo') {
        // Umbral: por debajo de 4 px el gesto sigue siendo un clic. Sin esto,
        // el temblor de la mano al hacer clic ya contaba como arrastre y el
        // nodo quedaba anclado sin que nadie lo pidiera.
        if (Math.hypot(evt.clientX - arr.x0, evt.clientY - arr.y0) < 4) return;
        arr.movio = true;
        const p = aMundo(evt);
        const vivo = nodosRef.current.find((n) => n.id === arr.id);
        if (!vivo) return;
        vivo.x = p.x + arr.dx;
        vivo.y = p.y + arr.dy;
        // Queda anclado donde se lo suelte, y nada más se mueve: recalcular el
        // layout al soltar reacomodaba todo el grafo de golpe.
        vivo.fijo = true;
        setFrame((f) => f + 1);
      } else {
        setVista((v) => ({ ...v, x: arr.vx + (evt.clientX - arr.x0), y: arr.vy + (evt.clientY - arr.y0) }));
      }
    };
    const soltar = () => {
      const arr = arrastreRef.current;
      arrastreRef.current = null;
      // Clic sin arrastre sobre un documento: se abre su página. El nodo se
      // comporta como la línea, que es lo que espera cualquiera que lo vea
      // como un enlace al documento.
      if (arr?.tipo === 'nodo' && !arr.movio && arr.documento) {
        irA(rutaActivo(arr.documento));
      }
    };
    window.addEventListener('pointermove', mover);
    window.addEventListener('pointerup', soltar);
    return () => {
      window.removeEventListener('pointermove', mover);
      window.removeEventListener('pointerup', soltar);
    };
  }, []);

  const onWheel = (evt) => {
    evt.preventDefault();
    setVista((v) => {
      const factor = evt.deltaY < 0 ? 1.12 : 1 / 1.12;
      return { ...v, k: Math.max(0.35, Math.min(3, v.k * factor)) };
    });
  };

  const posiciones = new Map(nodosRef.current.map((n) => [n.id, n]));
  const cargando = !assets || !consents || !logs;

  return (
    <section className={`panel ${soloMapa ? 'grafo-expandido' : ''}`}>
      <div className="panel-head">
        <div>
          <h2>Trazabilidad de los activos</h2>
        </div>
      </div>

      <div className="grafo-layout">
        <div className="grafo-lienzo">
          {/* Solo iconos: el rótulo comía ancho del lienzo. Llevan title y
              aria-label porque un icono suelto no se lee ni con lector de
              pantalla ni de un vistazo la primera vez. */}
          <div className="grafo-acciones">
            <button
              className="chip chip-icono"
              onClick={reacomodar}
              title="Reacomodar el grafo"
              aria-label="Reacomodar el grafo"
            >
              ⟳
            </button>
            {/* El mismo icono en los dos sentidos: lleva a la vista dedicada
                del mapa y, estando en ella, vuelve al dashboard. */}
            <button
              className={`chip chip-icono ${soloMapa ? 'active' : ''}`}
              onClick={() => irA(soloMapa ? '/' : RUTA_MAPA)}
              aria-pressed={soloMapa}
              title={soloMapa ? 'Volver al dashboard' : 'Ver solo el mapa'}
              aria-label={soloMapa ? 'Volver al dashboard' : 'Ver solo el mapa'}
            >
              {soloMapa ? '⤡' : '⤢'}
            </button>
          </div>

          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="xMidYMid meet"
            className="grafo"
            onWheel={onWheel}
            onPointerDown={(e) => { arrastreRef.current = { tipo: 'lienzo', x0: e.clientX, y0: e.clientY, vx: vista.x, vy: vista.y }; }}
            role="img"
            aria-label={`Grafo de trazabilidad con ${grafo.nodos.length} nodos y ${grafo.aristas.length} emisiones de documentos.`}
          >
            <defs>
              <marker
                id="punta-emitio" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="punta-emitio" />
              </marker>
            </defs>

            <g ref={mundoRef} transform={`translate(${vista.x}, ${vista.y}) scale(${vista.k})`}>
              {grafo.aristas.map((a, i) => {
                const o = posiciones.get(a.origen);
                const d = posiciones.get(a.destino);
                if (!o || !d) return null;
                const clave = `${a.origen}->${a.destino}-${i}`;
                const dx = d.x - o.x;
                const dy = d.y - o.y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                const rd = radioBorde(d, dx, dy) + 11;
                const ro = radioBorde(o, dx, dy) + 2;
                const ix = o.x + (dx / dist) * ro;
                const iy = o.y + (dy / dist) * ro;
                const fx = d.x - (dx / dist) * rd;
                const fy = d.y - (dy / dist) * rd;
                return (
                  <g key={clave} className={hover === clave ? 'arista-sel' : undefined}>
                    <line x1={ix} y1={iy} x2={fx} y2={fy} className="arista rel-emitio" markerEnd="url(#punta-emitio)" />
                    {/* Franja invisible y ancha: una línea de 1.5 px es casi
                        imposible de acertar con el mouse. */}
                    {/* Clic en la línea: se va a la página del documento, donde
                        está el bloque de cada acceso. El stopPropagation del
                        pointerdown evita que además arranque el pan del lienzo. */}
                    <line
                      x1={ix} y1={iy} x2={fx} y2={fy}
                      className="arista-hit"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => irA(rutaActivo(a.documento))}
                      onPointerEnter={() => setHover(clave)}
                      onPointerLeave={() => setHover((h) => (h === clave ? null : h))}
                    />
                  </g>
                );
              })}

              {grafo.nodos.map((n) => {
                const p = posiciones.get(n.id);
                if (!p) return null;
                const t = TIPOS[n.tipo];
                const elegido = sel?.clase === 'nodo' && sel.datos.id === n.id;
                return (
                  <g
                    key={n.id}
                    transform={`translate(${p.x}, ${p.y})`}
                    className={`nodo ${t.clase} ${elegido ? 'nodo-sel' : ''} ${n.baja ? 'nodo-baja' : ''}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      const q = aMundo(e);
                      arrastreRef.current = {
                        tipo: 'nodo', id: n.id, dx: p.x - q.x, dy: p.y - q.y,
                        x0: e.clientX, y0: e.clientY, movio: false,
                        // Solo los documentos navegan; las instituciones se
                        // inspeccionan en el panel de al lado.
                        documento: n.tipo === 'activo' ? n.etiqueta : null,
                      };
                      setSel({ clase: 'nodo', datos: n });
                    }}
                    onDoubleClick={() => { p.fijo = false; setFrame((f) => f + 1); }}
                  >
                    {/* El activo va como hoja y la institución como círculo: son
                        las dos únicas entidades, y distinguirlas por forma se
                        lee antes que por color. */}
                    {n.tipo === 'activo' ? (
                      <rect x={-t.radio} y={-t.radio * 0.72} width={t.radio * 2} height={t.radio * 1.44} rx="4" />
                    ) : (
                      <circle r={t.radio} style={n.color ? { fill: n.color } : undefined} />
                    )}
                    {p.fijo && <circle r={t.radio + 6} className="ancla" />}
                    <text y={t.radio + 15} textAnchor="middle" className="nodo-label">{n.etiqueta}</text>
                    {n.subtipo && <text y={t.radio + 27} textAnchor="middle" className="nodo-sub-label">{n.subtipo}</text>}
                  </g>
                );
              })}
            </g>

            {/* Lienzo vacío: sin esto queda un rectángulo en blanco y no se
                distingue "todavía cargando" de "no pasó nada todavía". */}
            {grafo.nodos.length === 0 && (
              <text x={W / 2} y={H / 2} textAnchor="middle" className="grafo-vacio">
                {cargando
                  ? 'Leyendo el ledger…'
                  : clinics?.length
                    ? 'Sin activos emitidos todavía — emití uno desde Operación.'
                    : 'No hay instituciones en el registro.'}
              </text>
            )}
          </svg>

        </div>

        <aside className="grafo-props">
          {!sel && (
            <>
              <h3>Referencias</h3>
              <ul className="grafo-leyenda">
                <li><span className="punto n-org" /> Institución</li>
                <li><span className="hoja" /> Activo médico digital</li>
                <li><span className="raya rel-emitio" /> Emitió el documento</li>
              </ul>
            </>
          )}

          {sel?.clase === 'nodo' && (
            <>
              <h3>{sel.datos.etiqueta}</h3>
              <p className="hint">{sel.datos.tipo === 'org' ? 'Institución' : 'Activo médico digital'}</p>
              <dl className="props">
                {Object.entries(sel.datos.props ?? {}).map(([k, v]) => (
                  <div key={k}><dt>{k}</dt><dd>{v || '—'}</dd></div>
                ))}
              </dl>
              <div className="btn-row">
                {sel.datos.tipo === 'activo' && (
                  <button className="chip" onClick={() => irA(rutaActivo(sel.datos.etiqueta))}>
                    ver bloques →
                  </button>
                )}
                <button className="chip" onClick={() => setSel(null)}>cerrar</button>
              </div>
            </>
          )}

        </aside>
      </div>
    </section>
  );
}
