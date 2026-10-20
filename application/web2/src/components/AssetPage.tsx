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
import { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { api, fmtDia, fmtFecha, irA, msgError, orgByMsp, rutaAnterior, useFetch } from '../api'
import type { AccessLog, Asset, BlockInfo, ClinicView, Consent } from '../types'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { Badge, Hint, Panel, Prop, Props, Result, labelCls } from '../ui'
import Dropdown from './Dropdown'

const Hash = ({ children }: { children: ReactNode }) => <code className="break-all">{children}</code>

function Bloque({ txId, channel }: { txId: string; channel?: string }) {
  const [estado, setEstado] = useState<{ cargando?: true; datos?: BlockInfo; error?: string }>({ cargando: true })

  useEffect(() => {
    let vivo = true
    setEstado({ cargando: true })
    // El acceso puede haber quedado en un canal provincial o en el nacional: el
    // canal viene del access-log y se pasa para que qscc mire el canal correcto.
    const qs = channel ? `?channel=${encodeURIComponent(channel)}` : ''
    api<BlockInfo>(`/blocks/by-tx/${txId}${qs}`)
      .then((datos) => { if (vivo) setEstado({ datos }) })
      .catch((err) => { if (vivo) setEstado({ error: msgError(err) }) })
    return () => { vivo = false }
  }, [txId, channel])

  const ficha = 'mt-2.5 rounded-lg border px-3 py-2.5'

  if (estado.cargando) return <div className={cn(ficha, 'border bg-muted italic text-muted-foreground')}>Buscando el bloque…</div>
  if (estado.error) {
    return (
      <div className={cn(ficha, 'border-destructive bg-deny-tint text-deny-ink')}>
        No se pudo leer el bloque: {estado.error}
      </div>
    )
  }

  const b = estado.datos!
  return (
    <div className={cn(ficha, 'border bg-muted')}>
      <div className="mb-1.5 text-[13px] font-bold">bloque #{b.numero}</div>
      <Props>
        <Prop label="Canal"><code>{b.canal}</code></Prop>
        <Prop label="Transacciones en el bloque">{b.transacciones}</Prop>
        <Prop label="Hash de datos"><Hash>{b.dataHash || '—'}</Hash></Prop>
        <Prop label="Hash del bloque anterior"><Hash>{b.previousHash || '—'}</Hash></Prop>
      </Props>
    </div>
  )
}

// Un año de vigencia: el chaincode exige vencimiento futuro y no acepta
// consentimientos sin plazo, así que hay que fijar uno. Para operar por clic
// se toma el mismo valor por defecto que el formulario completo.
function vencimientoPorDefecto() {
  const d = new Date()
  d.setFullYear(d.getFullYear() + 1)
  return `${d.toISOString().slice(0, 10)}T23:59:59Z`
}

// A la ficha se llega desde el mapa, la tabla de Activos o la Auditoría:
// "volver" lleva a ese lugar. Sin origen conocido (link directo) va al mapa.
const ORIGENES: Record<string, string> = {
  '/red': 'volver al mapa',
  '/mapa': 'volver al mapa',
  '/operacion/activos': 'volver a Activos',
  '/operacion/auditoria': 'volver a Auditoría',
}

type Resultado =
  | { ok: true; accion: string; etiqueta: string; data: { decision?: string; reason?: string } }
  | { ok: false; etiqueta: string; error: string }

interface Props_ {
  id: string
  tick: number
  activas?: ClinicView[]
  onDone?: () => void
}

export default function AssetPage({ id, tick, activas = [], onDone }: Props_) {
  const [ocupado, setOcupado] = useState<string | null>(null)
  const [resultado, setResultado] = useState<Resultado | null>(null)
  const [destino, setDestino] = useState('')
  // Quién pide el acceso. Es lo único que hay que elegir en esta página: ceder y
  // revocar los firma la institución emisora, porque el chaincode no acepta un
  // GrantConsent que venga de otra — no hay decisión que tomar ahí.
  const [solicitante, setSolicitante] = useState('')

  // Las tres acciones comparten forma: bloquean, ejecutan, refrescan y dejan el
  // resultado a la vista. Sin formularios: el recurso ya es este y el resto se
  // deriva del activo.
  const correr = async (accion: string, etiqueta: string, fn: () => Promise<object>) => {
    setOcupado(accion)
    setResultado(null)
    try {
      const data = await fn()
      setResultado({ ok: true, accion, etiqueta, data })
      onDone?.()
    } catch (err) {
      setResultado({ ok: false, etiqueta, error: msgError(err) })
    } finally {
      setOcupado(null)
    }
  }

  const { data: assets } = useFetch<Asset[]>('/assets', { tick })
  const { data: logs } = useFetch<AccessLog[]>('/access-logs', { tick })
  const { data: consents } = useFetch<Consent[]>('/consents', { tick })

  const activo = assets?.find((a) => a.FhirResourceID === id)
  const accesos = (logs ?? [])
    .filter((l) => l.FhirResourceID === id)
    .sort((a, b) => String(b.Timestamp).localeCompare(String(a.Timestamp)))

  const consentimientos = (consents ?? []).filter((c) => c.PatientIDHash === activo?.PatientIDHash)

  const cargandoHistorial = !logs || !consents
  const entradas = consentimientos.length + accesos.length

  const anterior = rutaAnterior()
  const origen = anterior && ORIGENES[anterior] ? anterior : '/red'
  const volver = (
    <Button variant="outline" size="sm" className="shrink-0 rounded-full" onClick={() => irA(origen)}>
      <ArrowLeft className="size-3.5" /> {ORIGENES[origen]}
    </Button>
  )

  if (assets && !activo) {
    return (
      <Panel title="Activo no encontrado" action={volver}>
        <p className="text-xs text-muted-foreground">
          No hay ningún activo con el identificador <code>{id}</code> en el ledger.
        </p>
      </Panel>
    )
  }

  if (!activo) {
    return (
      <Panel title="Cargando…" action={volver} />
    )
  }

  const emisor = orgByMsp(activo.OwnerOrg)

  // Ceder es potestad de quien emitió el documento: el chaincode rechaza un
  // GrantConsent que no venga de la org dueña del activo. Si esa institución
  // está dada de baja no hay con qué firmar, y se dice en vez de ofrecer un
  // botón que va a fallar.
  const emisorActivo = activas.find((c) => c.mspId === activo.OwnerOrg)

  // Solicitantes y destinatarias posibles: cualquier institución activa que no
  // sea la emisora (la dueña ya tiene el recurso, pedirse acceso a sí misma no
  // es un caso).
  const solicitantes = activas.filter((c) => c.mspId !== activo.OwnerOrg)
  const solicitanteValido = solicitantes.some((c) => c.key === solicitante)
    ? solicitante
    : solicitantes[0]?.key ?? ''
  const quienPide = solicitantes.find((c) => c.key === solicitanteValido)

  const destinatarias = solicitantes
  const destinoValido = destinatarias.some((c) => c.key === destino)
    ? destino
    : destinatarias[0]?.key ?? ''
  const orgDestino = destinatarias.find((c) => c.key === destinoValido)

  const consentDestino = consentimientos.find((c) => c.GrantedToOrg === orgDestino?.mspId)
  const cedido = !!consentDestino && !consentDestino.Revoked
    && new Date(consentDestino.Expiry) > new Date()

  const ceder = () => correr('ceder', 'Consentimiento otorgado', () => api<object>('/consents', {
    org: emisorActivo?.key,
    grantedToOrg: orgDestino?.mspId,
    patientIDHash: activo.PatientIDHash,
    resourceTypes: [activo.ResourceType],
    expiry: vencimientoPorDefecto(),
  }))

  const revocar = () => correr('revocar', 'Consentimiento revocado', () => api<object>('/consents/revoke', {
    org: emisorActivo?.key,
    grantedToOrg: orgDestino?.mspId,
    patientIDHash: activo.PatientIDHash,
    // Lista vacía: revoca todo lo otorgado, no solo este tipo.
    resourceTypes: [],
  }))

  const pedirAcceso = () => correr('pedir', 'CheckAccess', () =>
    api<object>('/check-access', { org: solicitanteValido, fhirResourceID: id }))

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title={
          <div className="flex flex-col gap-1">
            <h2 className="font-head text-[15px] font-semibold leading-none">{activo.FhirResourceID}</h2>
            <Hint>
              {activo.ResourceType} · emitido por{' '}
              <strong className="text-primary">{emisor.label}</strong>
            </Hint>
          </div>
        }
        action={volver}
      >

        {/* Las dos acciones del circuito, por clic. El acceso lo pide la
            institución que se elija; ceder y revocar los firma la emisora, sin
            elección posible: el chaincode rechaza un GrantConsent de otra org. */}
        <div className="mb-3 flex flex-wrap items-end gap-2.5">
          <div className="flex flex-wrap items-end gap-2.5">
          <Label className={cn(labelCls, 'min-w-48')}>
            Pedir acceso como
            <Dropdown
              value={solicitanteValido}
              onChange={setSolicitante}
              disabled={!!ocupado || solicitantes.length < 2}
              options={solicitantes.map((c) => ({ value: c.key, label: c.label }))}
              ariaLabel="Pedir acceso como"
            />
          </Label>
          <Button disabled={!!ocupado || !quienPide} onClick={pedirAcceso}>
            {ocupado === 'pedir' ? 'Evaluando…' : 'Pedir acceso'}
          </Button>
          </div>

          {emisorActivo && orgDestino && (
            <div className="flex flex-wrap items-end gap-2.5 border-l pl-5 max-sm:border-l-0 max-sm:pl-0">
              <Label className={cn(labelCls, 'min-w-48')}>
                Ceder a
                <Dropdown
                  value={destinoValido}
                  onChange={setDestino}
                  disabled={!!ocupado || destinatarias.length < 2}
                  options={destinatarias.map((c) => ({ value: c.key, label: c.label }))}
                  ariaLabel="Ceder a"
                />
              </Label>
              {cedido ? (
                <Button variant="destructive" disabled={!!ocupado} onClick={revocar}>
                  {ocupado === 'revocar' ? 'Revocando…' : 'Revocar consentimiento'}
                </Button>
              ) : (
                <Button variant="outline" disabled={!!ocupado} onClick={ceder}>
                  {ocupado === 'ceder' ? 'Cediendo…' : `Ceder ${activo.ResourceType} por un año (firma ${emisor.label})`}
                </Button>
              )}
            </div>
          )}

          {!emisorActivo && (
            <Hint>
              {emisor.label} está dada de baja: sin su identidad no se puede ceder ni revocar este documento.
            </Hint>
          )}

          {solicitantes.length === 0 && (
            <Hint>No hay otra institución activa que pueda pedir acceso a este documento.</Hint>
          )}
        </div>

        {resultado && !resultado.ok && (
          <Result kind="error"><strong>{resultado.etiqueta} falló</strong>: {resultado.error}</Result>
        )}
        {resultado?.ok && resultado.accion === 'pedir' && (
          <div
            className={cn(
              'rounded-lg border p-4 text-center text-[26px] font-extrabold',
              resultado.data.decision === 'PERMIT'
                ? 'border-permit bg-teal-tint text-permit'
                : 'border-deny bg-deny-tint text-deny-ink',
            )}
          >
            {resultado.data.decision}
            {resultado.data.reason && <span className="mt-1 block text-sm font-normal"> — {resultado.data.reason}</span>}
          </div>
        )}
        {resultado?.ok && resultado.accion !== 'pedir' && (
          <Result kind="ok"><strong>{resultado.etiqueta}</strong> — ya se ve en el historial.</Result>
        )}

        {/* Los hashes son largos y no se abrevian: en una vista de auditoría el
            valor completo es el punto. Se parten donde entren. */}
        <Props layout="wide">
          <Prop label="Tipo FHIR">{activo.ResourceType}</Prop>
          <Prop label="Emitido"><span title={activo.Timestamp}>{fmtFecha(activo.Timestamp)}</span></Prop>
          <Prop label="Paciente"><Hash>{activo.PatientIDHash}</Hash></Prop>
          <Prop label="CID en IPFS"><Hash>{activo.IpfsCid}</Hash></Prop>
          <Prop label="Contenido">cifrado AES-256-GCM, fuera del ledger</Prop>
          <Prop label="Bloque de emisión"><span className="text-muted-foreground">no disponible</span></Prop>
        </Props>
      </Panel>

      {/* Historial único: consentimientos y accesos son la misma historia del
          documento y separarlos obligaba a leer dos listas para reconstruirla.
          Los consentimientos van primero porque no traen fecha de otorgamiento
          —el chaincode guarda el vencimiento, no la creación— y no hay con qué
          intercalarlos entre los accesos. */}
      <Panel
        title="Historial"
        action={
          <Hint>
            {cargandoHistorial
              ? 'cargando…'
              : `${entradas} ${entradas === 1 ? 'entrada' : 'entradas'} sobre este documento`}
          </Hint>
        }
      >
        {!cargandoHistorial && entradas === 0 && (
          <p className="text-xs text-muted-foreground">Todavía no hay movimientos sobre este documento.</p>
        )}

        <ol className="m-0 flex list-none flex-col gap-3.5 p-0">
          {consentimientos.map((c) => {
            const para = orgByMsp(c.GrantedToOrg)
            const vencido = new Date(c.Expiry) <= new Date()
            const estado = c.Revoked ? 'revocado' : vencido ? 'vencido' : 'vigente'
            return (
              <li key={`c:${c.GrantedToOrg}`} className="rounded-[10px] border px-3.5 py-3">
                <div className="mb-1 flex flex-wrap items-center gap-2.5">
                  <Badge tone={estado === 'vigente' ? 'permit' : estado === 'revocado' ? 'deny' : 'warn'}>{estado}</Badge>
                  <strong>Consentimiento</strong>
                  <span className="text-muted-foreground">otorgado a</span>
                  <strong className="text-primary">{para.label}</strong>
                </div>
                <div className="text-muted-foreground">
                  {c.ResourceTypes?.length ? c.ResourceTypes.join(', ') : 'sin tipos'}
                  {' · vence '}{fmtDia(c.Expiry)}
                </div>
              </li>
            )
          })}

          {accesos.map((l) => {
            const quien = orgByMsp(l.RequesterOrg)
            return (
              <li key={l.TxID} className="rounded-[10px] border px-3.5 py-3">
                <div className="mb-1 flex flex-wrap items-center gap-2.5">
                  <Badge tone={l.Decision === 'PERMIT' ? 'permit' : 'deny'}>{l.Decision}</Badge>
                  <strong className="text-primary">{quien.label}</strong>
                  <span className="text-muted-foreground">pidió acceso</span>
                  <span className="text-muted-foreground" title={l.Timestamp}>{fmtFecha(l.Timestamp)}</span>
                </div>
                {l.Reason && <div className="text-muted-foreground">{l.Reason}</div>}
                <div className="text-muted-foreground">tx <Hash>{l.TxID}</Hash></div>
                <Bloque txId={l.TxID} channel={l._channel} />
              </li>
            )
          })}
        </ol>
      </Panel>
    </div>
  )
}
