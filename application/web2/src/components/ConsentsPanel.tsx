// Consentimientos: estado actual + historial de versiones del ledger
// (GetHistoryForKey) expandible por fila — cada grant/revoke queda como una
// versión separada e inmutable.
import { Fragment, useState } from 'react'
import { api, fmtDia, fmtFecha, msgError, orgByMsp, shortHash, useFetch } from '../api'
import type { Consent, ConsentHistoryEntry } from '../types'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge, EmptyRow, ErrorText, OrgName, Panel, Result, tdCls, thCls } from '../ui'

function estado(c: Consent): { label: string; tone: 'permit' | 'deny' | 'warn' } {
  if (c.Revoked) return { label: 'revocado', tone: 'deny' }
  if (new Date(c.Expiry) <= new Date()) return { label: 'vencido', tone: 'warn' }
  return { label: 'vigente', tone: 'permit' }
}

type Historial = ConsentHistoryEntry[] | { error: string } | null

export default function ConsentsPanel({ tick }: { tick: number }) {
  const { data: consents, error } = useFetch<Consent[]>('/consents', { tick })
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [history, setHistory] = useState<Historial>(null)

  const toggleHistory = async (c: Consent) => {
    const key = `${c.PatientIDHash}:${c.GrantedToOrg}`
    if (openKey === key) {
      setOpenKey(null)
      return
    }
    setOpenKey(key)
    setHistory(null)
    try {
      setHistory(await api<ConsentHistoryEntry[]>(
        `/consents/history?patientIDHash=${c.PatientIDHash}&grantedToOrg=${c.GrantedToOrg}`,
      ))
    } catch (err) {
      setHistory({ error: msgError(err) })
    }
  }

  return (
    <Panel title="Consentimientos">
      {error && <Result kind="error">{error}</Result>}
      <Table>
        <TableHeader>
          <TableRow>
            {['Paciente (ref)', 'Otorgado por', 'Otorgado a', 'Tipos de recurso', 'Vence', 'Estado', ''].map((h, i) => (
              <TableHead key={i} className={thCls}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {consents?.map((c) => {
            const key = `${c.PatientIDHash}:${c.GrantedToOrg}`
            const st = estado(c)
            const by = orgByMsp(c.GrantedByOrg)
            const to = orgByMsp(c.GrantedToOrg)
            return (
              <Fragment key={key}>
                <TableRow>
                  <TableCell className={tdCls}><code title={c.PatientIDHash}>{shortHash(c.PatientIDHash)}</code></TableCell>
                  <TableCell className={tdCls}><OrgName>{by.label}</OrgName></TableCell>
                  <TableCell className={tdCls}><OrgName>{to.label}</OrgName></TableCell>
                  <TableCell className={tdCls}>{c.ResourceTypes.length ? c.ResourceTypes.join(', ') : '—'}</TableCell>
                  <TableCell className={`${tdCls} text-muted-foreground`} title={c.Expiry}>{fmtDia(c.Expiry)}</TableCell>
                  <TableCell className={tdCls}><Badge tone={st.tone}>{st.label}</Badge></TableCell>
                  <TableCell className={`${tdCls} w-px whitespace-nowrap`}>
                    <Button variant="link" size="sm" className="h-auto p-0" aria-expanded={openKey === key} onClick={() => toggleHistory(c)}>
                      {openKey === key ? 'ocultar historial' : 'historial'}
                    </Button>
                  </TableCell>
                </TableRow>
                {openKey === key && (
                  <TableRow className="bg-muted hover:bg-muted">
                    <TableCell colSpan={7} className={tdCls}>
                      {!history && 'Cargando historial…'}
                      {history && 'error' in history && <ErrorText>{history.error}</ErrorText>}
                      {Array.isArray(history) && (
                        <ol className="my-1.5 flex list-decimal flex-col gap-1 pl-5 text-[12.5px]">
                          {history.map((h) => (
                            <li key={h.TxID}>
                              <span className="text-muted-foreground" title={h.Timestamp}>{fmtFecha(h.Timestamp)}</span> — {h.Consent?.Revoked ? 'revocación' : 'otorgamiento'}:
                              {' '}{h.Consent?.ResourceTypes?.length ? h.Consent.ResourceTypes.join(', ') : 'sin tipos vigentes'}
                              {' '}<code className="text-muted-foreground" title={h.TxID}>tx {shortHash(h.TxID, 8)}</code>
                            </li>
                          ))}
                        </ol>
                      )}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })}
          {!consents && !error && <EmptyRow cols={7}>Leyendo el ledger…</EmptyRow>}
          {consents?.length === 0 && (
            <EmptyRow cols={7}>
              Sin consentimientos: se otorgan desde Operación › Acciones o desde la ficha de un activo.
            </EmptyRow>
          )}
        </TableBody>
      </Table>
    </Panel>
  )
}
