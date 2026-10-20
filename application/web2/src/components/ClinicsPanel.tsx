// Alta y baja de instituciones del bus.
//
// No es un ABM contra una tabla: cada alta crea una organización Fabric real
// (MSP y peer propios) y la incorpora a canal-nacional con una actualización
// de configuración firmada por las clínicas que ya estaban; la baja hace el
// camino inverso. Tarda ~30-40 s, así que el panel escucha el progreso por SSE
// y lo va mostrando en vez de dejar un spinner mudo.
//
// Se muestran las dos vistas del estado por separado —registro local y registro
// on-chain— porque pueden discrepar, y esa discrepancia es justamente lo que
// hay que poder ver (p.ej. una clínica en el canal pero sin registrar).
import { useState } from 'react'
import { api, msgError, nombreJurisdiccion, useSSE } from '../api'
import type { ClinicView, SseMessage } from '../types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { Badge, Hint, OrgName, Panel, Result, labelCls, tdCls, thCls } from '../ui'
import Dropdown from './Dropdown'

function EstadoBadge({ estado }: { estado?: string }) {
  if (!estado) return <Badge tone="warn">sin registro</Badge>
  const activa = estado === 'activa' || estado === 'ACTIVA'
  return <Badge tone={activa ? 'permit' : 'deny'}>{activa ? 'activa' : 'baja'}</Badge>
}

const LOG_COLOR: Record<string, string> = { ok: 'font-semibold text-permit', error: 'font-semibold text-deny-ink' }

interface Props {
  clinics: ClinicView[]
  onChanged: () => void
}

export default function ClinicsPanel({ clinics, onChanged }: Props) {
  const [key, setKey] = useState('')
  const [nombre, setNombre] = useState('')
  const [jurisdiccion, setJurisdiccion] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progreso, setProgreso] = useState<SseMessage[]>([])

  useSSE((msg) => {
    if (msg.type !== 'clinic-op') return
    setProgreso((p) => [...p, msg].slice(-14))
    if (msg.estado === 'ok' || msg.estado === 'error') setBusy(null)
  })

  const correr = async (etiqueta: string, fn: () => Promise<unknown>) => {
    setBusy(etiqueta)
    setError(null)
    setProgreso([])
    try {
      await fn()
      onChanged()
    } catch (err) {
      setError(msgError(err))
    } finally {
      setBusy(null)
    }
  }

  // Se ofrecen las jurisdicciones que ya tienen canal provincial (alguna clínica
  // activa en ellas). Una jurisdicción nueva —que addOrg.sh sí sabe crear, con
  // su canal— se da de alta por la API; el formulario no la ofrece.
  const jurisdicciones = [...new Set(
    clinics.filter((c) => c.activa && c.jurisdiccion).map((c) => c.jurisdiccion as string),
  )]

  const alta = () => correr(`alta:${key}`, async () => {
    await api('/clinics', {
      key: key.trim(),
      nombre: nombre.trim(),
      jurisdiccion: jurisdiccion || undefined,
    })
    setKey('')
    setNombre('')
    setJurisdiccion('')
  })

  // El motivo lo pone el backend por default: la baja se decide con el botón y
  // el porqué no se pedía en ningún flujo real, era un campo libre de más.
  const baja = (c: ClinicView) => correr(`baja:${c.key}`, () => api(`/clinics/${c.key}/baja`, {}))

  const activas = clinics.filter((c) => c.activa).length

  return (
    <Panel title="Instituciones del bus">
      <Table>
        <TableHeader>
          <TableRow>
            {['Institución', 'MSP ID', 'Peer', 'Registro local', 'On-chain', 'Nodo', ''].map((h, i) => (
              <TableHead key={i} className={thCls}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {clinics.map((c) => {
            // Una clínica dada de baja se marca con un fondo tenue y su badge, no
            // bajándole la opacidad al texto: eso rompería el contraste justo en
            // la fila que hay que poder leer.
            const tenue = cn(tdCls, !c.activa && 'bg-muted')
            return (
              <TableRow key={c.key} className="hover:bg-transparent">
                <TableCell className={tenue}><OrgName>{c.label}</OrgName></TableCell>
                <TableCell className={tenue}><code>{c.mspId}</code></TableCell>
                <TableCell className={tenue}><code>{c.peerEndpoint?.split(':')[1]}</code></TableCell>
                <TableCell className={tenue}><EstadoBadge estado={c.estado} /></TableCell>
                <TableCell className={tenue}>
                  <EstadoBadge estado={c.onChain?.estado} />
                  {c.onChain?.motivoBaja && <div><Hint>{c.onChain.motivoBaja}</Hint></div>}
                </TableCell>
                <TableCell className={tenue}>
                  {c.peerOk ? <Badge tone="permit">up</Badge> : <Badge tone="deny">down</Badge>}
                </TableCell>
                <TableCell className={cn(tenue, 'w-px whitespace-nowrap')}>
                  {c.activa && (
                    <Button
                      variant="destructive" size="sm"
                      disabled={!!busy || activas < 2}
                      title={activas < 2 ? 'No se puede dar de baja la última clínica activa' : undefined}
                      onClick={() => baja(c)}
                    >
                      Dar de baja
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>

      <h3 className="mt-5 text-sm font-semibold">Nueva institución</h3>
      <div className="mt-2.5 grid grid-cols-[repeat(3,minmax(0,1fr))_auto] items-end gap-2.5 border-t pt-3.5 max-[700px]:grid-cols-1">
        <Label className={labelCls}>
          Identificador
          <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="p.ej. rosario" spellCheck={false} />
        </Label>
        <Label className={labelCls}>
          Nombre de la institución
          <Input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="p.ej. Hospital Rosario" />
        </Label>
        <Label className={labelCls}>
          Jurisdicción
          <Dropdown
            value={jurisdiccion}
            onChange={setJurisdiccion}
            options={[
              { value: '', label: 'Sólo canal nacional' },
              ...jurisdicciones.map((j) => ({ value: j, label: nombreJurisdiccion(j) })),
            ]}
            ariaLabel="Jurisdicción"
          />
        </Label>
        <Button disabled={!!busy || !key.trim() || !nombre.trim()} onClick={alta}>
          Dar de alta
        </Button>
      </div>

      {busy && <Result kind="pending">Operación en curso ({busy}) — tarda ~30-40 s…</Result>}
      {error && <Result kind="error">{error}</Result>}

      {progreso.length > 0 && (
        // Progreso del alta/baja: llega por SSE línea por línea mientras corre el
        // script, para que se vea en qué paso está y no parezca colgado.
        <ol className="mt-2.5 flex list-decimal flex-col gap-0.5 rounded-lg border bg-background py-2.5 pl-7 pr-3 font-mono text-[11.5px] text-muted-foreground">
          {progreso.map((p, i) => (
            <li key={i} className={p.estado ? LOG_COLOR[p.estado] : undefined}>{p.linea}</li>
          ))}
        </ol>
      )}
    </Panel>
  )
}
