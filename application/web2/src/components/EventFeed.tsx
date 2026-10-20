// Feed en vivo (SSE): eventos AccessPermitted del chaincode y entregas de
// clave (la org dueña envuelve la clave AES para el certificado del
// solicitante). Cada entrega se puede "descifrar como" la org destinataria:
// el backend desenvuelve la clave con la clave privada de esa org, baja el
// blob de IPFS y devuelve el recurso FHIR en claro — el círculo completo.
import { useState } from 'react'
import { ArrowRight, Building2, Key, LogOut, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import { api, fmtTs, msgError, orgByMsp, shortHash } from '../api'
import type { Delivery, FeedItem } from '../types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ErrorText, Hint, OrgName, Panel } from '../ui'

const Pre = ({ className, children }: { className?: string; children: ReactNode }) => (
  <pre className={cn('mt-1.5 max-h-[260px] overflow-x-auto rounded-lg border bg-card p-2 text-[11px]', className ?? 'border-border')}>
    {children}
  </pre>
)

const Details = ({ summary, open, children }: { summary: string; open?: boolean; children: ReactNode }) => (
  <details open={open} className="mt-1">
    <summary className="cursor-pointer text-xs text-muted-foreground">{summary}</summary>
    {children}
  </details>
)

function Card({ delivery: highlight = false, children }: { delivery?: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-[10px] border px-3 py-2.5 text-[13px]',
        highlight ? 'border-l-[3px] border-amber bg-amber-tint' : 'border-border bg-muted',
      )}
    >
      {children}
    </div>
  )
}

const CardTitle = ({ children }: { children: ReactNode }) => <div className="mb-1 flex items-center gap-1.5 font-bold">{children}</div>
const CardBody = ({ children }: { children: ReactNode }) => <div className="flex flex-col gap-1">{children}</div>

function DeliveryCard({ delivery }: { delivery: Delivery }) {
  const [decrypted, setDecrypted] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const from = orgByMsp(delivery.fromOrg)
  const to = orgByMsp(delivery.toOrg)

  const decrypt = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await api<{ resource: unknown }>(`/deliveries/${delivery.id}/decrypt`, { org: delivery.recipientOrgKey })
      setDecrypted(res.resource)
    } catch (err) {
      setError(msgError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card delivery>
      <CardTitle>
        <Key className="size-4 text-primary" /> Entrega de clave <span className="font-normal text-muted-foreground">(simulada)</span>
      </CardTitle>
      <CardBody>
        <div className="flex flex-wrap items-center gap-2">
          <OrgName>{from.label}</OrgName>
          <ArrowRight className="size-3.5 text-muted-foreground" />
          <OrgName>{to.label}</OrgName>
        </div>
        <div className="text-muted-foreground">{delivery.resourceType} · <code>{delivery.fhirResourceID}</code></div>
        <Details summary="Sobre (ECDH P-256 + HKDF + AES-256-GCM)">
          <Pre>{JSON.stringify(delivery.envelope, null, 2)}</Pre>
        </Details>
        {!decrypted && (
          <Button size="sm" disabled={busy} onClick={decrypt} className="self-start">
            {busy ? 'Descifrando…' : `Descifrar como ${to.label}`}
          </Button>
        )}
        {error && <ErrorText>{error}</ErrorText>}
        {decrypted != null && (
          <Details summary="Recurso FHIR descifrado" open>
            <Pre className="border-permit">{JSON.stringify(decrypted, null, 2)}</Pre>
          </Details>
        )}
      </CardBody>
    </Card>
  )
}

export default function EventFeed({ feed, soloEntregas = false }: { feed: FeedItem[]; soloEntregas?: boolean }) {
  // Vista "Entregas": solo las tarjetas de entrega de clave (con el botón
  // Descifrar). Sin el flag, el feed completo (accesos + altas/bajas + entregas).
  const items = soloEntregas ? feed.filter((f) => f.type === 'key-delivery') : feed
  return (
    <Panel
      title={soloEntregas ? 'Entregas de clave' : 'Eventos en vivo'}
      action={<Hint>{soloEntregas ? 'ECDH P-256 + HKDF + AES-256-GCM' : 'SSE · canal-nacional'}</Hint>}
      className="max-h-[calc(100vh-60px)]"
    >
      <div className={cn('flex flex-col gap-2.5 overflow-y-auto', soloEntregas && 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,380px),1fr))] items-start')}>
        {items.length === 0 && (
          <div className="col-span-full p-3.5 text-center italic text-muted-foreground">
            {soloEntregas
              ? 'Sin entregas de clave todavía: aparecen cuando un pedido de acceso recibe PERMIT.'
              : 'Sin eventos.'}
          </div>
        )}
        {items.map((item, i) => {
          if (item.type === 'key-delivery' && item.delivery) {
            return <DeliveryCard key={item.delivery.id} delivery={item.delivery} />
          }

          // Alta y baja de instituciones: el registro on-chain también emite
          // eventos, y no se leen como un acceso (no hay solicitante ni
          // paciente), así que tienen su propia tarjeta.
          if (item.type === 'clinic-event') {
            const alta = item.eventName === 'ClinicRegistered'
            const org = orgByMsp(item.mspId ?? '')
            return (
              <Card key={`${item.txId}-${i}`}>
                <CardTitle>
                  {alta ? <Building2 className="size-4 text-primary" /> : <LogOut className="size-4 text-primary" />} {item.eventName} <span className="font-normal text-muted-foreground">{fmtTs(item.receivedAt)}</span>
                </CardTitle>
                <CardBody>
                  <span>
                    <OrgName>{org.label ?? item.nombre ?? item.mspId}</OrgName>
                    {alta ? ' se incorporó al bus' : ' fue dada de baja del bus'}
                  </span>
                  <div className="text-muted-foreground">
                    <code>{item.mspId}</code>
                    {' · bloque '}{item.blockNumber}
                    {' · tx '}<code title={item.txId}>{shortHash(item.txId, 8)}</code>
                  </div>
                </CardBody>
              </Card>
            )
          }

          const req = orgByMsp(item.requesterOrg ?? '')
          return (
            <Card key={`${item.txId}-${i}`}>
              <CardTitle><Zap className="size-4 text-primary" /> {item.eventName} <span className="font-normal text-muted-foreground">{fmtTs(item.receivedAt)}</span></CardTitle>
              <CardBody>
                <span>
                  <OrgName>{req.label}</OrgName>
                  {' obtuvo PERMIT sobre '}<code>{item.fhirResourceID}</code>
                </span>
                <div className="text-muted-foreground">
                  {item.resourceType}
                  {' · paciente '}<code title={item.patientIDHash}>{shortHash(item.patientIDHash)}</code>
                  {' · bloque '}{item.blockNumber}
                  {' · tx '}<code title={item.txId}>{shortHash(item.txId, 8)}</code>
                </div>
              </CardBody>
            </Card>
          )
        })}
      </div>
    </Panel>
  )
}
