// Auditoría de accesos: cada CheckAccess (PERMIT o DENY) queda en el ledger
// con su motivo y con el recurso puntual que se pidió — nada se evalúa sin
// dejar rastro, y el rastro dice CUÁL recurso, no solo de qué tipo era.
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fmtFecha, hrefActivo, orgByMsp, shortHash, useFetch } from '../api'
import type { AccessLog } from '../types'
import { Badge, EmptyRow, OrgName, Panel, Result, enlaceActivo, tdCls, thCls } from '../ui'

const COLUMNAS = ['Fecha', 'Solicitante', 'Recurso', 'Tipo', 'Paciente (ref)', 'Decisión', 'Motivo', 'Tx']

export default function AccessLogPanel({ tick }: { tick: number }) {
  const { data: logs, error } = useFetch<AccessLog[]>('/access-logs', { tick })
  const sorted = logs ? [...logs].sort((a, b) => b.Timestamp.localeCompare(a.Timestamp)) : null

  return (
    <Panel title="Auditoría de accesos">
      {error && <Result kind="error">{error}</Result>}
      <Table>
        <TableHeader>
          <TableRow>
            {COLUMNAS.map((h) => <TableHead key={h} className={thCls}>{h}</TableHead>)}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted?.map((l) => {
            const req = orgByMsp(l.RequesterOrg)
            return (
              <TableRow key={l.TxID}>
                <TableCell className={`${tdCls} text-muted-foreground`} title={l.Timestamp}>{fmtFecha(l.Timestamp)}</TableCell>
                <TableCell className={tdCls}><OrgName>{req.label}</OrgName></TableCell>
                <TableCell className={tdCls}>
                  {l.FhirResourceID
                    ? <a className={enlaceActivo} href={hrefActivo(l.FhirResourceID)}><code>{l.FhirResourceID}</code></a>
                    : '—'}
                </TableCell>
                <TableCell className={tdCls}>{l.ResourceType}</TableCell>
                <TableCell className={tdCls}><code title={l.PatientIDHash}>{shortHash(l.PatientIDHash)}</code></TableCell>
                <TableCell className={tdCls}><Badge tone={l.Decision === 'PERMIT' ? 'permit' : 'deny'}>{l.Decision}</Badge></TableCell>
                <TableCell className={`${tdCls} text-muted-foreground`}>{l.Reason || '—'}</TableCell>
                <TableCell className={tdCls}><code className="text-muted-foreground" title={l.TxID}>{shortHash(l.TxID, 8)}</code></TableCell>
              </TableRow>
            )
          })}
          {!sorted && !error && <EmptyRow cols={8}>Leyendo el ledger…</EmptyRow>}
          {sorted?.length === 0 && (
            <EmptyRow cols={8}>
              Sin evaluaciones de acceso todavía: se registran al pedir acceso desde la ficha de un activo.
            </EmptyRow>
          )}
        </TableBody>
      </Table>
    </Panel>
  )
}
