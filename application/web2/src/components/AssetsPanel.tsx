// Tabla de activos emitidos en canal-nacional (metadatos públicos: el
// payload clínico está cifrado en IPFS).
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fmtFecha, hrefActivo, orgByMsp, shortHash, useFetch } from '../api'
import type { Asset } from '../types'
import { EmptyRow, OrgName, Panel, Result, enlaceActivo, tdCls, thCls } from '../ui'

export default function AssetsPanel({ tick }: { tick: number }) {
  const { data: assets, error } = useFetch<Asset[]>('/assets', { tick })

  return (
    <Panel title="Activos emitidos">
      {error && <Result kind="error">{error}</Result>}
      <Table>
        <TableHeader>
          <TableRow>
            {['ID', 'Tipo', 'CID (IPFS)', 'Paciente (ref)', 'Emisor', 'Fecha'].map((h) => (
              <TableHead key={h} className={thCls}>{h}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {assets?.map((a) => {
            const owner = orgByMsp(a.OwnerOrg)
            return (
              <TableRow key={a.FhirResourceID}>
                <TableCell className={tdCls}><a className={enlaceActivo} href={hrefActivo(a.FhirResourceID)}><code>{a.FhirResourceID}</code></a></TableCell>
                <TableCell className={tdCls}>{a.ResourceType}</TableCell>
                <TableCell className={tdCls}><code title={a.IpfsCid}>{shortHash(a.IpfsCid, 14)}</code></TableCell>
                <TableCell className={tdCls}><code title={a.PatientIDHash}>{shortHash(a.PatientIDHash)}</code></TableCell>
                <TableCell className={tdCls}><OrgName>{owner.label}</OrgName></TableCell>
                <TableCell className={`${tdCls} text-muted-foreground`} title={a.Timestamp}>{fmtFecha(a.Timestamp)}</TableCell>
              </TableRow>
            )
          })}
          {!assets && !error && <EmptyRow cols={6}>Leyendo el ledger…</EmptyRow>}
          {assets?.length === 0 && (
            <EmptyRow cols={6}>Todavía no se emitió ningún activo: se emiten desde Operación › Acciones.</EmptyRow>
          )}
        </TableBody>
      </Table>
    </Panel>
  )
}
