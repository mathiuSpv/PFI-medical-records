// Vista de grafo: la trazabilidad de cada activo médico digital.
//
// Dos entidades y una relación: la institución emitió el documento. Todo lo
// auditable —quién lo pidió, cuándo, qué respondió el chaincode y bajo qué
// consentimiento— vive dentro de esa línea, no como aristas aparte.
//
// El layout NO se anima: se calcula entero y se pinta ya acomodado. Ver el
// grafo sacudirse hasta encontrar su lugar no aporta y se ve mal.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Maximize2, Minimize2, RefreshCw } from 'lucide-react'
import { RUTA_MAPA, irA, nombreJurisdiccion, orgByMsp, rutaActivo, useFetch } from '../api'
import { TIPOS, acomodar, construirGrafo } from '../grafo'
import type { GraphNode, PosicionPrevia } from '../grafo'
import type { AccessLog, Asset, ClinicView, Consent } from '../types'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { Hint, Panel, Prop, Props, labelCls } from '../ui'
import Dropdown from './Dropdown'

// El viewBox se hace del tamaño real del lienzo, medido: una unidad del dibujo
// es un píxel en pantalla. Con un ancho fijo el mapa se achicaba hasta ser
// ilegible en un celular y se agrandaba en pantalla completa, con rótulos de
// tamaños distintos según dónde se mirara. El alto arranca bajo y crece con la
// cantidad de nodos (con 30 y pico apretados en 440 px los rótulos se pisan);
// en pantalla completa es el de la ventana.
const W_INICIAL = 1120
const W_MIN = 320
const H_MIN = 440
const H_MAX = 900
const altoPara = (nodos: number, ancho: number) =>
  Math.min(H_MAX, Math.max(H_MIN, 300 + nodos * 13 * Math.max(1, 700 / ancho)))

// Distancia del centro del nodo a su borde en la dirección dada. El activo se
// dibuja como rectángulo, así que un radio fijo dejaría la punta de la flecha
// flotando o metida adentro según por dónde llegue.
function radioBorde(nodo: GraphNode, dx: number, dy: number) {
  const t = TIPOS[nodo.tipo]
  if (nodo.tipo !== 'activo') return t.radio
  const hw = t.radio
  const hh = t.radio * 0.72
  const ax = Math.abs(dx) || 0.001
  const ay = Math.abs(dy) || 0.001
  const d = Math.sqrt(ax * ax + ay * ay)
  return ax * hh > ay * hw ? (hw * d) / ax : (hh * d) / ay
}

type Arrastre =
  | { tipo: 'nodo'; id: string; dx: number; dy: number; x0: number; y0: number; movio: boolean; documento: string | null }
  | { tipo: 'lienzo'; x0: number; y0: number; vx: number; vy: number }

// Rótulos del SVG: se perfilan con el color del lienzo para que se lean cuando
// caen encima de una arista.
const TEXTO_PERFILADO = 'pointer-events-none stroke-background stroke-[3px] [paint-order:stroke] [stroke-linejoin:round]'

export default function GraphPanel({ clinics, tick, soloMapa = false }: { clinics: ClinicView[]; tick: number; soloMapa?: boolean }) {
  const { data: assets } = useFetch<Asset[]>('/assets', { tick })
  const { data: consents } = useFetch<Consent[]>('/consents', { tick })
  const { data: logs } = useFetch<AccessLog[]>('/access-logs', { tick })

  const [sel, setSel] = useState<GraphNode | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [vista, setVista] = useState({ x: 0, y: 0, k: 1 })
  const [, setFrame] = useState(0)
  // Capa de red seleccionada: se ve UNA sola capa a la vez. Por defecto la
  // nacional (todas las instituciones son miembros del canal nacional).
  const [capaSel, setCapaSel] = useState('nacional')

  const svgRef = useRef<SVGSVGElement>(null)
  const mundoRef = useRef<SVGGElement>(null)
  const nodosRef = useRef<GraphNode[]>([])
  const lienzoRef = useRef<HTMLDivElement>(null)
  // Con qué tamaño, y con qué datos, se calculó el layout que está a la vista.
  const layoutRef = useRef({ W: 0, H: 0, completo: false })
  const arrastreRef = useRef<Arrastre | null>(null)

  const [tam, setTam] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = lienzoRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(([entrada]) => {
      const w = Math.round(entrada.contentRect.width)
      const h = Math.round(entrada.contentRect.height)
      // Se ignoran variaciones de un par de píxeles (scrollbars, redondeos):
      // cada cambio de tamaño reescala el dibujo.
      setTam((t) => (Math.abs(t.w - w) < 4 && Math.abs(t.h - h) < 4 ? t : { w, h }))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const grafoFull = useMemo(
    () => construirGrafo({
      clinics,
      assets,
      consents,
      logs,
      etiquetaOrg: (msp) => orgByMsp(msp).label,
    }),
    [clinics, assets, consents, logs],
  )

  // La capa activa es la elegida si existe; si no (p.ej. quedó seleccionada una
  // provincia que ya no tiene nodos), cae a la primera disponible.
  const capaActiva = grafoFull.capas.includes(capaSel) ? capaSel : (grafoFull.capas[0] ?? 'nacional')

  // Vista del grafo: SÓLO la capa activa. Cada nodo que pertenece a esa capa se
  // ubica en su (única) banda; las aristas quedan si ambos extremos están.
  const grafo = useMemo(() => {
    const nodos = grafoFull.nodos
      .filter((n) => n.capas.includes(capaActiva))
      .map((n) => ({ ...n, capa: capaActiva }))
    const ids = new Set(nodos.map((n) => n.id))
    const aristas = grafoFull.aristas.filter((a) => ids.has(a.origen) && ids.has(a.destino))
    return { nodos, aristas, capas: [capaActiva] }
  }, [grafoFull, capaActiva])

  const cargando = !assets || !consents || !logs

  // Ancho = el del lienzo. Alto: el de la ventana en pantalla completa; si no,
  // crece con los nodos y reserva una franja por capa.
  const W = Math.max(W_MIN, tam.w || W_INICIAL)
  const H = soloMapa && tam.h > 0
    ? Math.max(tam.h, 320)
    : Math.max(altoPara(grafo.nodos.length, W), (grafo.capas.length || 1) * 170)

  // El layout se resuelve completo antes de pintar. Las posiciones de los nodos
  // que ya estaban se conservan (llevadas al tamaño actual): si no, emitir un
  // activo o girar el celular reordenaría todo el grafo y se perdería la
  // referencia visual. Un layout hecho mientras los datos todavía cargaban no
  // cuenta como referencia: eran las instituciones solas.
  useEffect(() => {
    const prev = layoutRef.current
    const sx = prev.W ? W / prev.W : 1
    const sy = prev.H ? H / prev.H : 1
    const previas = prev.completo
      ? new Map<string, PosicionPrevia>(nodosRef.current.map((n) => [n.id, { x: n.x * sx, y: n.y * sy, fijo: n.fijo }]))
      : null
    const nodos = grafo.nodos.map((n) => ({ ...n }))
    acomodar(nodos, grafo.aristas, W, H, grafo.capas, previas)
    nodosRef.current = nodos
    layoutRef.current = { W, H, completo: !cargando }
    setFrame((f) => f + 1)
  }, [grafo, W, H, cargando])

  const reacomodar = useCallback(() => {
    const nodos = grafo.nodos.map((n) => ({ ...n }))
    acomodar(nodos, grafo.aristas, W, H, grafo.capas)
    nodosRef.current = nodos
    layoutRef.current = { W, H, completo: !cargando }
    setVista({ x: 0, y: 0, k: 1 })
    setFrame((f) => f + 1)
  }, [grafo, W, H, cargando])

  // Pantalla -> coordenadas del grafo. Se toma la matriz del grupo que lleva el
  // transform de zoom/pan, así la conversión ya contempla la vista actual.
  const aMundo = (evt: { clientX: number; clientY: number }) => {
    const svg = svgRef.current
    const g = mundoRef.current
    if (!svg || !g) return { x: 0, y: 0 }
    const p = svg.createSVGPoint()
    p.x = evt.clientX
    p.y = evt.clientY
    const m = g.getScreenCTM()
    if (!m) return { x: 0, y: 0 }
    const q = p.matrixTransform(m.inverse())
    return { x: q.x, y: q.y }
  }

  useEffect(() => {
    const mover = (evt: PointerEvent) => {
      const arr = arrastreRef.current
      if (!arr) return
      if (arr.tipo === 'nodo') {
        // Umbral: por debajo de 4 px el gesto sigue siendo un clic. Sin esto,
        // el temblor de la mano al hacer clic ya contaba como arrastre y el
        // nodo quedaba anclado sin que nadie lo pidiera.
        if (Math.hypot(evt.clientX - arr.x0, evt.clientY - arr.y0) < 4) return
        arr.movio = true
        const p = aMundo(evt)
        const vivo = nodosRef.current.find((n) => n.id === arr.id)
        if (!vivo) return
        vivo.x = p.x + arr.dx
        vivo.y = p.y + arr.dy
        // Queda anclado donde se lo suelte, y nada más se mueve: recalcular el
        // layout al soltar reacomodaba todo el grafo de golpe.
        vivo.fijo = true
        setFrame((f) => f + 1)
      } else {
        setVista((v) => ({ ...v, x: arr.vx + (evt.clientX - arr.x0), y: arr.vy + (evt.clientY - arr.y0) }))
      }
    }
    const soltar = () => {
      const arr = arrastreRef.current
      arrastreRef.current = null
      // Clic sin arrastre sobre un documento: se abre su página. El nodo se
      // comporta como la línea, que es lo que espera cualquiera que lo vea
      // como un enlace al documento.
      if (arr?.tipo === 'nodo' && !arr.movio && arr.documento) {
        irA(rutaActivo(arr.documento))
      }
    }
    window.addEventListener('pointermove', mover)
    window.addEventListener('pointerup', soltar)
    return () => {
      window.removeEventListener('pointermove', mover)
      window.removeEventListener('pointerup', soltar)
    }
  }, [])

  // Zoom con la rueda. Listener nativo y no-pasivo: el onWheel de React es
  // pasivo y no deja hacer preventDefault, así que la página scrolleaba a la vez.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return undefined
    const onWheel = (evt: WheelEvent) => {
      evt.preventDefault()
      setVista((v) => {
        const factor = evt.deltaY < 0 ? 1.12 : 1 / 1.12
        return { ...v, k: Math.max(0.35, Math.min(3, v.k * factor)) }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const posiciones = new Map(nodosRef.current.map((n) => [n.id, n]))

  return (
    <Panel
      expanded={soloMapa}
      title={
        <div className="flex items-center gap-2.5">
          {soloMapa && <img className="block flex-none" src="/favicon.svg" alt="Medámbar" width="28" height="28" />}
          <h2 className="font-head text-[15px] font-semibold leading-none">Trazabilidad de los activos</h2>
        </div>
      }
      action={
        grafoFull.capas.length > 0 && (
          <Label className={cn(labelCls, 'flex-row items-center gap-2')}>
            Capa de red
            <Dropdown
              className="min-w-[220px]"
              value={capaActiva}
              onChange={setCapaSel}
              options={grafoFull.capas.map((c) => ({ value: c, label: nombreJurisdiccion(c) }))}
              ariaLabel="Capa de red"
            />
          </Label>
        )
      }
    >
      <div
        className={cn(
          soloMapa
            ? 'flex min-h-0 w-full flex-1 flex-col gap-4'
            : 'grid grid-cols-[minmax(0,1fr)_300px] items-start gap-4 max-[1000px]:grid-cols-1',
        )}
      >
        <div ref={lienzoRef} className={cn('relative min-w-0', soloMapa && 'min-h-0 w-full flex-1 overflow-hidden')}>
          {/* Solo iconos: el rótulo comía ancho del lienzo. Llevan title y
              aria-label porque un icono suelto no se lee ni con lector de
              pantalla ni de un vistazo la primera vez. Flotan sobre el lienzo
              porque son acciones sobre el mapa y no sobre el panel. */}
          <div className="absolute right-2.5 top-2.5 z-[2] flex gap-1.5">
            <Button
              variant="outline" size="icon-sm" className="rounded-full text-[15px]"
              onClick={reacomodar} title="Reacomodar el grafo" aria-label="Reacomodar el grafo"
            >
              <RefreshCw className="size-[15px]" />
            </Button>
            {/* El mismo icono en los dos sentidos: lleva al mapa a pantalla
                completa y, estando en ella, vuelve a la solapa Red de datos. */}
            <Button
              variant="outline"
              size="icon-sm"
              className={cn('rounded-full text-[15px]', soloMapa && 'border-primary text-primary')}
              onClick={() => irA(soloMapa ? '/red' : RUTA_MAPA)}
              aria-pressed={soloMapa}
              title={soloMapa ? 'Volver a Red de datos' : 'Ver solo el mapa'}
              aria-label={soloMapa ? 'Volver a Red de datos' : 'Ver solo el mapa'}
            >
              {soloMapa ? <Minimize2 className="size-[15px]" /> : <Maximize2 className="size-[15px]" />}
            </Button>
          </div>

          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="xMidYMid meet"
            // touch-none: el arrastre lo maneja el componente, no el scroll.
            // En pantalla completa el SVG sale del flujo: con h-auto su alto lo
            // fija el aspect ratio del viewBox, que en una pantalla ancha da más
            // alto que la pantalla y estira la página en vez de ajustarse.
            className={cn(
              'block w-full cursor-grab touch-none rounded-[10px] border border bg-background active:cursor-grabbing',
              soloMapa ? 'absolute inset-0 h-full' : 'h-auto',
            )}
            onPointerDown={(e) => { arrastreRef.current = { tipo: 'lienzo', x0: e.clientX, y0: e.clientY, vx: vista.x, vy: vista.y } }}
            role="img"
            aria-label={`Grafo de trazabilidad con ${grafo.nodos.length} nodos y ${grafo.aristas.length} emisiones de documentos.`}
          >
            <defs>
              <marker
                id="punta-emitio" viewBox="0 0 10 10" refX="9" refY="5"
                markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className="fill-line" />
              </marker>
            </defs>

            <g ref={mundoRef} transform={`translate(${vista.x}, ${vista.y}) scale(${vista.k})`}>
              {/* Bandas por capa: una franja por nivel (nacional arriba,
                  provincias debajo). Van primero, detrás de aristas y nodos, y
                  no capturan el puntero para no estorbar el arrastre. */}
              {grafo.capas.map((capa, i) => {
                const bandH = H / (grafo.capas.length || 1)
                const top = i * bandH
                const esNacional = capa === 'nacional'
                return (
                  <g key={`banda-${capa}`}>
                    <rect
                      x="0" y={top} width={W} height={bandH}
                      className={cn('pointer-events-none fill-transparent stroke-none')}
                    />
                    <text
                      x="14" y={top + 20}
                      className={cn(
                        'pointer-events-none font-head text-[11px] font-bold uppercase tracking-[0.04em]',
                        esNacional ? 'fill-foreground' : 'fill-permit',
                      )}
                    >
                      {esNacional ? 'Nacional · canal-nacional' : `${nombreJurisdiccion(capa)} · canal-${capa}`}
                    </text>
                  </g>
                )
              })}

              {grafo.aristas.map((a, i) => {
                const o = posiciones.get(a.origen)
                const d = posiciones.get(a.destino)
                if (!o || !d) return null
                const clave = `${a.origen}->${a.destino}-${i}`
                const dx = d.x - o.x
                const dy = d.y - o.y
                const dist = Math.sqrt(dx * dx + dy * dy) || 1
                const rd = radioBorde(d, dx, dy) + 11
                const ro = radioBorde(o, dx, dy) + 2
                const ix = o.x + (dx / dist) * ro
                const iy = o.y + (dy / dist) * ro
                const fx = d.x - (dx / dist) * rd
                const fy = d.y - (dy / dist) * rd
                return (
                  <g key={clave}>
                    <line
                      x1={ix} y1={iy} x2={fx} y2={fy}
                      className={cn('fill-none stroke-line', hover === clave ? 'stroke-[3.5px]' : 'stroke-[1.5px]')}
                      markerEnd="url(#punta-emitio)"
                    />
                    {/* Franja invisible y ancha: una línea de 1.5 px es casi
                        imposible de acertar con el mouse. Clic en la línea: se
                        va a la página del documento, donde está el bloque de
                        cada acceso. El stopPropagation del pointerdown evita
                        que además arranque el pan del lienzo. */}
                    <line
                      x1={ix} y1={iy} x2={fx} y2={fy}
                      className="cursor-pointer stroke-transparent stroke-[14px]"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => irA(rutaActivo(a.documento))}
                      onPointerEnter={() => setHover(clave)}
                      onPointerLeave={() => setHover((h) => (h === clave ? null : h))}
                    />
                  </g>
                )
              })}

              {grafo.nodos.map((n) => {
                const p = posiciones.get(n.id)
                if (!p) return null
                const t = TIPOS[n.tipo]
                const elegido = sel?.id === n.id
                // El círculo/hoja lleva un borde claro para despegarse de las
                // aristas que le llegan por detrás; el elegido lo lleva oscuro.
                const borde = elegido ? 'stroke-foreground stroke-[3px]' : 'stroke-card stroke-2'
                return (
                  <g
                    key={n.id}
                    transform={`translate(${p.x}, ${p.y})`}
                    className="cursor-pointer"
                    onPointerDown={(e: ReactPointerEvent<SVGGElement>) => {
                      e.stopPropagation()
                      const q = aMundo(e)
                      arrastreRef.current = {
                        tipo: 'nodo', id: n.id, dx: p.x - q.x, dy: p.y - q.y,
                        x0: e.clientX, y0: e.clientY, movio: false,
                        // Solo los documentos navegan; las instituciones se
                        // inspeccionan en el panel de al lado.
                        documento: n.tipo === 'activo' ? n.etiqueta : null,
                      }
                      setSel(n)
                    }}
                    onDoubleClick={() => { p.fijo = false; setFrame((f) => f + 1) }}
                  >
                    {/* El activo va como hoja y la institución como círculo: son
                        las dos únicas entidades, y distinguirlas por forma se
                        lee antes que por color. Una institución dada de baja se
                        dibuja hueca: sigue en el grafo porque sus activos y
                        consentimientos siguen existiendo, pero ya no opera. */}
                    {n.tipo === 'activo' ? (
                      <rect
                        x={-t.radio} y={-t.radio * 0.72} width={t.radio * 2} height={t.radio * 1.44} rx="4"
                        className={cn('fill-activo', borde)}
                      />
                    ) : n.baja ? (
                      <circle
                        r={t.radio}
                        className={cn('fill-card stroke-deny [stroke-dasharray:4_3]', elegido ? 'stroke-[3px]' : 'stroke-2')}
                      />
                    ) : (
                      <circle r={t.radio} className={cn('fill-primary', borde)} style={n.color ? { fill: n.color } : undefined} />
                    )}
                    {p.fijo && <circle r={t.radio + 6} className="fill-none stroke-input stroke-1 [stroke-dasharray:2_3]" />}
                    <text y={t.radio + 15} textAnchor="middle" className={cn(TEXTO_PERFILADO, 'fill-foreground text-[11px] font-semibold')}>
                      {n.etiqueta}
                    </text>
                    {n.subtipo && (
                      <text y={t.radio + 27} textAnchor="middle" className={cn(TEXTO_PERFILADO, 'fill-muted text-[10px]')}>
                        {n.subtipo}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>

            {/* Lienzo vacío: sin esto queda un rectángulo en blanco y no se
                distingue "todavía cargando" de "no pasó nada todavía". */}
            {grafo.nodos.length === 0 && (
              <text x={W / 2} y={H / 2} textAnchor="middle" className="fill-muted text-sm italic">
                {cargando
                  ? 'Leyendo el ledger…'
                  : clinics.length
                    ? 'Sin activos emitidos todavía — emití uno desde Operación.'
                    : 'No hay instituciones en el registro.'}
              </text>
            )}
          </svg>
        </div>

        <aside className={cn('rounded-[10px] border border bg-muted p-3.5', soloMapa && 'max-h-[32vh] w-full overflow-y-auto')}>
          {!sel && (
            <>
              <h3 className="mb-1 text-sm">Referencias</h3>
              {/* La referencia tiene que coincidir con lo que se dibuja: forma
                  y color, no solo color. */}
              <ul className={cn('my-2.5 flex list-none gap-1.5 p-0 text-xs', soloMapa ? 'flex-row flex-wrap gap-x-[18px]' : 'flex-col')}>
                <li className="flex items-center gap-2"><span className="size-3 flex-none rounded-full bg-primary" /> Institución</li>
                <li className="flex items-center gap-2"><span className="h-[11px] w-4 flex-none rounded-sm bg-activo" /> Activo médico digital</li>
                <li className="flex items-center gap-2"><span className="h-[3px] w-4 flex-none rounded-sm bg-line" /> Emitió el documento</li>
              </ul>
            </>
          )}

          {sel && (
            <>
              <h3 className="mb-1 break-words text-sm">{sel.etiqueta}</h3>
              <Hint>{sel.tipo === 'org' ? 'Institución' : 'Activo médico digital'}</Hint>
              <Props layout={soloMapa ? 'grid' : 'col'}>
                {Object.entries(sel.props).map(([k, v]) => (
                  <Prop key={k} label={k}>{v || '—'}</Prop>
                ))}
              </Props>
              <div className="flex flex-wrap gap-2">
                {sel.tipo === 'activo' && (
                  <Button variant="outline" size="sm" className="rounded-full" onClick={() => irA(rutaActivo(sel.etiqueta))}>
                    ver bloques →
                  </Button>
                )}
                <Button variant="outline" size="sm" className="rounded-full" onClick={() => setSel(null)}>cerrar</Button>
              </div>
            </>
          )}
        </aside>
      </div>
    </Panel>
  )
}
