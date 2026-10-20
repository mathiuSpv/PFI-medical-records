import { Link } from 'lucide-react'
import { useEffect, useState } from 'react'
import { RUTA_MAPA, api, idDeRuta, useClinics, useRuta, useSSE } from './api'
import type { Delivery, FeedItem } from './types'
import { cn } from '@/lib/utils'
import { Panel } from './ui'
import AccessLogPanel from './components/AccessLogPanel'
import ActionsPanel from './components/ActionsPanel'
import AssetPage from './components/AssetPage'
import AssetsPanel from './components/AssetsPanel'
import ClinicsPanel from './components/ClinicsPanel'
import ConsentsPanel from './components/ConsentsPanel'
import EventFeed from './components/EventFeed'
import GraphPanel from './components/GraphPanel'

// Módulos de Operación: cada uno es su propio panel, con su ruta y su enlace en
// la barra, para no apilarlos en una columna que obliga a scrollear.
const SUBMODULOS = [
  ['instituciones', 'Instituciones'],
  ['acciones', 'Acciones'],
  ['activos', 'Activos'],
  ['consentimientos', 'Consentimientos'],
  ['auditoria', 'Auditoría'],
  ['entregas', 'Entregas'],
] as const

// Solapas de la barra oscura: texto claro, fondo ámbar tenue al pasar/estar
// activa y una raya ámbar al pie de la activa.
const solapaCls = (activa: boolean) =>
  cn(
    'relative inline-flex cursor-pointer items-center gap-1 rounded-t-lg px-4 pb-2.5 pt-2 text-sm font-semibold transition-colors duration-150 max-sm:px-3',
    'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-bar-ink',
    'after:absolute after:inset-x-3 after:bottom-0 after:h-[3px] after:rounded-full',
    activa
      ? 'bg-amber/20 text-bar-ink after:bg-primary'
      : 'text-bar-muted hover:bg-amber/15 hover:text-bar-ink',
  )

export default function App() {
  const { clinics, reload: reloadClinics } = useClinics()
  const activas = clinics.filter((c) => c.activa)

  // No hay identidad global: la consola administra la red entera y no actúa como
  // ninguna institución. La org que firma se elige dentro de cada acción que
  // genera una transacción (ver ActionsPanel y AssetPage).
  //
  // tick: contador de refresco — las tablas refetchean cuando cambia
  // (tras cada acción propia y ante cada evento SSE).
  const [tick, setTick] = useState(0)
  const [feed, setFeed] = useState<FeedItem[]>([])
  const bump = () => setTick((t) => t + 1)

  // Ruta por hash: cada vista/módulo tiene su URL, así es linkeable y el botón
  // de atrás funciona. '#/activo/<id>' abre un documento, '#/mapa' el grafo a
  // pantalla completa, '#/red' la topología, '#/operacion/<mod>' un módulo, y
  // '/' (default) cae en Instituciones.
  const ruta = useRuta()
  const activoId = idDeRuta(ruta)
  const soloMapa = ruta === RUTA_MAPA
  const solapa = activoId ? null : ruta === '/red' ? 'red' : 'operacion'
  const subModRuta = ruta.startsWith('/operacion/') ? ruta.slice('/operacion/'.length) : ''
  const subOp = SUBMODULOS.find(([id]) => id === subModRuta)?.[0] ?? 'instituciones'

  // Entregas previas al load (el feed SSE solo trae lo nuevo).
  useEffect(() => {
    api<Delivery[]>('/deliveries')
      .then((ds) => setFeed(
        ds.map((d): FeedItem => ({ type: 'key-delivery', delivery: d, receivedAt: Date.parse(d.timestamp) })).reverse(),
      ))
      .catch(() => {})
  }, [])

  useSSE((msg) => {
    // El progreso de un alta/baja no va al feed general: lo muestra el panel de
    // clínicas, que es donde el usuario está mirando mientras corre.
    if (msg.type === 'clinic-op') {
      if (msg.estado === 'ok') reloadClinics()
      return
    }
    if (msg.type === 'clinic-event') reloadClinics()
    setFeed((f) => [{ ...msg, receivedAt: Date.now() }, ...f].slice(0, 100))
    bump()
  })

  // Vista del mapa: se devuelve antes del encabezado a propósito, porque la
  // idea es que no haya nada más en pantalla que la topología.
  if (soloMapa) return <GraphPanel clinics={clinics} tick={tick} soloMapa />

  return (
    <div className="p-5 max-sm:px-4 max-sm:py-3">
      {/* Barra superior Medámbar: banda oscura con el acento ámbar al pie, el
          logo, el wordmark y las solapas de nivel superior. Queda fija arriba al
          scrollear, así la navegación siempre está a mano, incluso desde la
          ficha de un activo. */}
      <header className="sticky top-0 z-50 -mx-5 -mt-5 mb-[18px] flex flex-wrap items-center gap-x-9 gap-y-3 border-b-[3px] border-primary bg-linear-to-b from-bar-from to-bar-to px-5 pt-2.5 shadow-bar max-sm:-mx-4 max-sm:-mt-3 max-sm:px-4">
        <div className="flex items-center gap-3 pb-2.5">
          <img className="block size-10 flex-none drop-shadow-[0_1px_1px_rgba(0,0,0,0.25)]" src="/favicon.svg" alt="Medámbar" width="40" height="40" />
          <h1 className="text-[22px] font-bold text-bar-ink">
            Med<span className="text-brand-text">ámbar</span>
          </h1>
        </div>

        {/* Los módulos de Operación y la vista de la red, todos a la vista como
            enlaces (cada vista tiene su URL), así que se marca la actual con
            aria-current. */}
        <nav className="ml-auto flex flex-wrap items-end justify-end gap-1 self-stretch" aria-label="Vistas">
          {SUBMODULOS.map(([id, etiqueta]) => {
            const actual = solapa === 'operacion' && subOp === id
            return (
              <a
                key={id}
                href={`#/operacion/${id}`}
                aria-current={actual ? 'page' : undefined}
                className={solapaCls(actual)}
              >
                {etiqueta}
              </a>
            )
          })}
          <Link className="mx-2 mb-3 size-4 flex-none self-end text-bar-muted" aria-hidden="true" />
          <a href="#/red" aria-current={solapa === 'red' ? 'page' : undefined} className={solapaCls(solapa === 'red')}>
            Red de datos
          </a>
        </nav>
      </header>

      {activoId ? (
        <AssetPage id={activoId} tick={tick} activas={activas} onDone={bump} />
      ) : (
        <>
          <div className="flex min-w-0 flex-col gap-4">
            {solapa === 'operacion' ? (
              <>
                {/* El módulo activo se elige en la barra superior. */}
                {subOp === 'instituciones' && (
                  <ClinicsPanel clinics={clinics} onChanged={() => { reloadClinics(); bump() }} />
                )}
                {subOp === 'acciones' && (
                  activas.length > 0
                    ? <ActionsPanel clinics={activas} onDone={bump} />
                    : <Panel><p className="text-xs text-muted-foreground">No hay instituciones activas para operar.</p></Panel>
                )}
                {subOp === 'activos' && <AssetsPanel tick={tick} />}
                {subOp === 'consentimientos' && <ConsentsPanel tick={tick} />}
                {subOp === 'auditoria' && <AccessLogPanel tick={tick} />}
                {subOp === 'entregas' && <EventFeed feed={feed} soloEntregas />}
              </>
            ) : (
              <GraphPanel clinics={clinics} tick={tick} />
            )}
          </div>
        </>
      )}
    </div>
  )
}
