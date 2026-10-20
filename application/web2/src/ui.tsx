// Capa de dominio sobre shadcn/ui: lo que es propio de este dashboard (paneles
// con encabezado, badges de estado PERMIT/DENY, nombre de institución con su
// color, listas de propiedades). Los primitivos —Button, Input, Table, Select…—
// se importan directo de components/ui.
import type { ComponentProps, ReactNode } from 'react'
import { Alert } from '@/components/ui/alert'
import { Badge as ShadBadge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TableCell, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

// ---- Paneles ----

// Panel = Card con encabezado. `expanded` lo saca del flujo y lo lleva a pantalla
// completa (vista del mapa).
interface PanelProps extends Omit<ComponentProps<'div'>, 'title'> {
  title?: ReactNode
  action?: ReactNode
  expanded?: boolean
}

export function Panel({ title, action, expanded = false, className, children, ...rest }: PanelProps) {
  return (
    <Card
      className={cn(
        'gap-4 py-4',
        expanded && 'fixed inset-0 z-60 m-0 overflow-hidden rounded-none',
        className,
      )}
      {...rest}
    >
      {(title || action) && (
        <CardHeader className="flex items-center justify-between gap-2.5 px-4 max-sm:px-3">
          {typeof title === 'string' ? <CardTitle className="font-head text-[15px]">{title}</CardTitle> : title}
          {action}
        </CardHeader>
      )}
      <CardContent className={cn('px-4 max-sm:px-3', expanded && 'flex min-h-0 flex-1 flex-col')}>{children}</CardContent>
    </Card>
  )
}

export const Hint = ({ className, ...rest }: ComponentProps<'span'>) => (
  <span className={cn('text-xs text-muted-foreground', className)} {...rest} />
)

// ---- Estados ----

type Tone = 'permit' | 'deny' | 'warn'

const BADGE: Record<Tone, string> = {
  permit: 'bg-permit-bg text-permit',
  deny: 'bg-deny-bg text-deny-ink',
  warn: 'bg-warn-bg text-warn-ink',
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <ShadBadge className={cn('px-2.5 text-[11px] font-bold uppercase', BADGE[tone])}>{children}</ShadBadge>
  )
}

const RESULT = {
  ok: 'border-permit bg-teal-tint text-permit',
  error: 'border-destructive bg-deny-tint text-deny-ink',
  pending: 'border-transparent bg-transparent text-muted-foreground',
}

// Resultado de una operación: Alert con el color del estado.
export function Result({ kind, className, ...rest }: ComponentProps<'div'> & { kind: keyof typeof RESULT }) {
  return <Alert className={cn('block px-3 py-2.5 text-[13px]', RESULT[kind], className)} {...rest} />
}

export const ErrorText = ({ children }: { children: ReactNode }) => (
  <div className="text-xs text-deny-ink">{children}</div>
)

// Nombre de una institución: en el ámbar de marca, igual para todas.
export function OrgName({ children }: { children: ReactNode }) {
  return <span className="whitespace-nowrap font-semibold text-primary">{children}</span>
}

// ---- Tablas ----

export const EmptyRow = ({ cols, children }: { cols: number; children: ReactNode }) => (
  <TableRow className="hover:bg-transparent">
    <TableCell colSpan={cols} className="p-3.5 text-center italic text-muted-foreground">{children}</TableCell>
  </TableRow>
)

// Encabezado de columna en versión compacta, como el de las tablas del dashboard.
export const thCls = 'h-8 px-2 text-[11px] font-bold uppercase tracking-[0.05em] text-muted-foreground'
export const tdCls = 'px-2 py-[7px] align-top whitespace-normal'

// ---- Formularios ----

export const labelCls = 'flex flex-col items-stretch gap-1 text-[12.5px] font-semibold tracking-[0.01em] text-muted-foreground'

// Lista de propiedades (dt/dd). `layout` las apila (col), las reparte en
// columnas (grid) o en columnas más anchas (wide).
const PROPS_LAYOUT = {
  col: 'flex flex-col gap-2',
  grid: 'grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-5 gap-y-2.5',
  wide: 'grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-6 gap-y-3',
}

export function Props({ layout = 'col', children }: { layout?: keyof typeof PROPS_LAYOUT; children: ReactNode }) {
  return (
    <dl
      className={cn(
        'mb-3 mt-2 [&_dd]:mt-0.5 [&_dd]:break-words [&_dd]:text-[13px] [&_dt]:text-[11px] [&_dt]:uppercase [&_dt]:tracking-[0.05em] [&_dt]:text-muted-foreground',
        PROPS_LAYOUT[layout],
      )}
    >
      {children}
    </dl>
  )
}

export const Prop = ({ label, children }: { label: string; children: ReactNode }) => (
  <div>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
)

// Enlace al detalle de un activo desde tablas y listas.
export const enlaceActivo =
  'underline decoration-border underline-offset-4 transition-colors hover:text-primary hover:decoration-primary'
