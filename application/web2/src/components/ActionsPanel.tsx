// Panel de acciones: emite activos y otorga/revoca consentimiento. El paciente
// se ingresa en claro (p.ej. "paciente-demo-001") y el backend lo convierte en
// referencia opaca (HMAC con clave de red) — on-chain solo viaja esa referencia.
//
// La identidad que firma se elige acá adentro, en cada acción, y no en el
// encabezado: la consola es de administración de la red y mira todo sin ser
// ninguna institución en particular, pero Fabric exige que cada transacción la
// someta una org con su MSP, y de eso dependen el ABAC y la auditoría. Por eso
// el firmante aparece donde efectivamente hay una transacción que firmar.
//
// Pedir acceso no está acá: se pide desde la ficha del documento, que es donde
// se ve de quién es el recurso y qué se le autorizó.
import { useEffect, useState } from 'react'
import { api, clinicByKey, msgError } from '../api'
import { RESOURCE_TYPES, armarRecurso, camposDe, valoresIniciales } from '../fhir-forms'
import type { ResourceType, Valores } from '../fhir-forms'
import type { ClinicView } from '../types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { Badge, Panel, Result, labelCls } from '../ui'
import Dropdown from './Dropdown'

function defaultExpiry() {
  const d = new Date()
  d.setFullYear(d.getFullYear() + 1)
  return d.toISOString().slice(0, 10)
}

type Tab = 'emitir' | 'consentir'
const TABS: [Tab, string][] = [['emitir', 'Emitir activo'], ['consentir', 'Consentimiento']]

interface ResultadoAccion {
  ok: boolean
  label: string
  data?: { cid?: string; patientIDHash?: string }
  error?: string
}

interface RenaperResp {
  found: boolean
  dni?: string
  persona?: { nombre: string; apellido: string }
  error?: string
}

export default function ActionsPanel({ clinics, onDone }: { clinics: ClinicView[]; onDone: () => void }) {
  const [tab, setTab] = useState<Tab>('emitir')
  // Firmante de la acción. Arranca en la primera activa y se corrige sola si esa
  // institución se da de baja mientras el panel está abierto.
  const [org, setOrg] = useState(clinics[0]?.key)
  useEffect(() => {
    if (!clinics.some((c) => c.key === org)) setOrg(clinics[0]?.key)
  }, [clinics, org])

  const [patientId, setPatientId] = useState('paciente-demo-001')
  const [resourceType, setResourceType] = useState<ResourceType>('Observation')
  // Los campos de cada tipo se conservan al cambiar de uno a otro. El JSON que se
  // envía sale de ellos; `manual` (si no es null) lo reemplaza por un texto
  // editado a mano.
  const [valoresPorTipo, setValoresPorTipo] = useState<Partial<Record<ResourceType, Valores>>>({})
  const valores = valoresPorTipo[resourceType] ?? valoresIniciales(resourceType)
  const setCampo = (name: string, valor: string) =>
    setValoresPorTipo((m) => ({ ...m, [resourceType]: { ...valores, [name]: valor } }))
  const resourceJSON = armarRecurso(resourceType, valores, patientId)
  const [manual, setManual] = useState<string | null>(null)
  const [grantTypes, setGrantTypes] = useState(['Observation'])
  const [expiry, setExpiry] = useState(defaultExpiry())
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ResultadoAccion | null>(null)

  // Verificación de identidad simulada (RENAPER mock): informativa, no
  // condiciona ninguna transacción.
  const [dni, setDni] = useState('')
  const [renaper, setRenaper] = useState<RenaperResp | null>(null)
  const [renaperBusy, setRenaperBusy] = useState(false)

  const validarIdentidad = async () => {
    setRenaperBusy(true)
    setRenaper(null)
    try {
      setRenaper(await api<RenaperResp>('/renaper/validar', { dni }))
    } catch (err) {
      setRenaper({ found: false, error: msgError(err) })
    } finally {
      setRenaperBusy(false)
    }
  }

  // Con más de dos clínicas ya no existe "la otra": hay que elegir a quién se
  // le otorga el consentimiento.
  const destinatarias = clinics.filter((c) => c.key !== org)
  const [targetKey, setTargetKey] = useState(destinatarias[0]?.key)
  useEffect(() => {
    if (!destinatarias.some((c) => c.key === targetKey)) {
      setTargetKey(destinatarias[0]?.key)
    }
  }, [destinatarias, targetKey])

  const other = clinicByKey(targetKey)

  const run = async (label: string, fn: () => Promise<ResultadoAccion['data']>) => {
    setBusy(true)
    setResult(null)
    try {
      const data = await fn()
      setResult({ ok: true, label, data })
      onDone()
    } catch (err) {
      setResult({ ok: false, label, error: msgError(err) })
    } finally {
      setBusy(false)
    }
  }

  const toggleType = (t: string) =>
    setGrantTypes((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t]))

  const emitir = () => run('EmitAsset', async () => {
    const resource = JSON.parse(manual ?? resourceJSON)
    return api('/assets', { org, patientId, resourceType, resource })
  })

  const otorgar = () => run('GrantConsent', () => api('/consents', {
    org,
    grantedToOrg: other?.mspId,
    patientId,
    resourceTypes: grantTypes,
    expiry: `${expiry}T23:59:59Z`,
  }))

  const revocar = (total: boolean) => run('RevokeConsent', () => api('/consents/revoke', {
    org,
    grantedToOrg: other?.mspId,
    patientId,
    resourceTypes: total ? [] : grantTypes,
  }))

  return (
    <Panel title="Acciones">
      <Tabs value={tab} onValueChange={(v) => { setTab(v as Tab); setResult(null) }} className="mb-3">
        <TabsList>
          {TABS.map(([key, label]) => (
            <TabsTrigger key={key} value={key}>{label}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Dos columnas en pantallas anchas: a la izquierda quién firma y sobre
          qué paciente (común a las dos acciones), a la derecha lo propio de
          cada una. En angosto se apilan en ese mismo orden. */}
      <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-start gap-x-7 gap-y-3 max-[900px]:grid-cols-1">
        <div className="flex flex-col gap-2.5">
          <Label className={labelCls}>
            {tab === 'emitir' ? 'Emite como' : 'Otorga'}
            <Dropdown
              value={org ?? ''}
              onChange={setOrg}
              options={clinics.map((c) => ({ value: c.key, label: c.label }))}
              ariaLabel={tab === 'emitir' ? 'Emite como' : 'Otorga'}
            />
          </Label>

          <Label className={labelCls}>
            Paciente
            <Input value={patientId} onChange={(e) => setPatientId(e.target.value)} spellCheck={false} />
          </Label>

          <div className="flex flex-wrap items-end gap-2.5">
            <Label className={cn(labelCls, 'min-w-40 flex-1')}>
              Código RENAPER
              <Input value={dni} onChange={(e) => setDni(e.target.value)} placeholder="DNI, p.ej. 30111222" inputMode="numeric" />
            </Label>
            <Button variant="outline" disabled={renaperBusy || !dni.trim()} onClick={validarIdentidad}>
              {renaperBusy ? 'Validando…' : 'Validar identidad'}
            </Button>
          </div>
          {renaper?.found && renaper.persona && (
            <div className="self-start">
              <Badge tone="permit">
                {renaper.persona.nombre} {renaper.persona.apellido} · DNI {renaper.dni}
              </Badge>
            </div>
          )}
          {renaper && !renaper.found && <div className="self-start"><Badge tone="deny">no encontrado en RENAPER</Badge></div>}

          {tab === 'emitir' && (
            <Label className={labelCls}>
              Tipo de recurso FHIR
              <Dropdown
                value={resourceType}
                onChange={(v) => { setResourceType(v as ResourceType); setManual(null) }}
                options={RESOURCE_TYPES.map((t) => ({ value: t, label: t }))}
                ariaLabel="Tipo de recurso FHIR"
              />
            </Label>
          )}
        </div>

        <div className="flex flex-col gap-2.5">
          {tab === 'emitir' && (
            <>
              {manual === null && (
                <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 max-sm:grid-cols-1">
                  {camposDe(resourceType).map((c) => (
                    <Label key={c.name} className={cn(labelCls, c.ancho && 'col-span-2 max-sm:col-span-1')}>
                      {c.label}
                      {c.kind === 'select' ? (
                        <Dropdown
                          value={valores[c.name]}
                          onChange={(v) => setCampo(c.name, v)}
                          options={(c.options ?? []).map((o) => ({ value: o, label: o }))}
                          ariaLabel={c.label}
                        />
                      ) : (
                        <Input
                          type={c.kind === 'datetime' ? 'datetime-local' : c.kind === 'number' ? 'number' : 'text'}
                          value={valores[c.name]}
                          onChange={(e) => setCampo(c.name, e.target.value)}
                          placeholder={c.placeholder}
                          spellCheck={false}
                        />
                      )}
                    </Label>
                  ))}
                </div>
              )}
              <Label className={labelCls}>
                <span className="flex items-center justify-between gap-2">
                  {manual === null ? 'JSON que se envía' : 'JSON (editado a mano)'}
                  <Button
                    variant="link" size="sm" className="h-auto p-0 text-xs"
                    onClick={() => setManual(manual === null ? resourceJSON : null)}
                  >
                    {manual === null ? 'Editar JSON a mano' : 'Volver al formulario'}
                  </Button>
                </span>
                <Textarea
                  rows={manual === null ? 8 : 16}
                  className="font-mono text-xs"
                  value={manual ?? resourceJSON}
                  readOnly={manual === null}
                  onChange={(e) => setManual(e.target.value)}
                  spellCheck={false}
                />
              </Label>
              <Button disabled={busy} onClick={emitir}>
                {busy ? 'Emitiendo…' : 'Cifrar, subir a IPFS y emitir'}
              </Button>
            </>
          )}

          {tab === 'consentir' && (
            <>
              <Label className={labelCls}>
                Otorgar a
                <Dropdown
                  value={targetKey ?? ''}
                  onChange={setTargetKey}
                  options={destinatarias.map((c) => ({ value: c.key, label: c.label }))}
                  ariaLabel="Otorgar a"
                />
              </Label>
              <fieldset className="flex flex-wrap gap-x-3.5 gap-y-2 border-0 p-0">
                <legend className={cn(labelCls, 'mb-1 p-0')}>Tipos de recurso</legend>
                {RESOURCE_TYPES.map((t) => (
                  <Label key={t} className="items-center gap-1.5 text-[12.5px] font-semibold">
                    <Checkbox checked={grantTypes.includes(t)} onCheckedChange={() => toggleType(t)} />
                    {t}
                  </Label>
                ))}
              </fieldset>
              <Label className={labelCls}>
                Vencimiento
                <Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
              </Label>
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy || !other || grantTypes.length === 0} onClick={otorgar}>
                  Otorgar consentimiento
                </Button>
                <Button variant="outline" disabled={busy || !other || grantTypes.length === 0} onClick={() => revocar(false)}>
                  Revocar seleccionados
                </Button>
                <Button variant="destructive" disabled={busy || !other} onClick={() => revocar(true)}>
                  Revocar todo
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-2.5" aria-live="polite">
        {busy && <Result kind="pending">Enviando transacción…</Result>}
        {result && !result.ok && <Result kind="error"><strong>{result.label}</strong>: {result.error}</Result>}
        {result?.ok && (
          <Result kind="ok">
            <strong>{result.label} OK</strong>
            {result.data?.cid && <> · CID <code>{result.data.cid}</code></>}
            {result.data?.patientIDHash && <> · hash <code>{result.data.patientIDHash.slice(0, 16)}…</code></>}
          </Result>
        )}
      </div>
    </Panel>
  )
}
