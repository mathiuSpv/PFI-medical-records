// Selector de una opción: envoltorio de shadcn Select con la API simple
// { value, label }. Radix no admite items con value '' (es el "sin selección"),
// así que la opción vacía se traduce a un centinela interno.
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface DropdownOption {
  value: string
  label: string
}

const VACIO = '__vacio__'

interface Props {
  value: string
  onChange: (value: string) => void
  options: DropdownOption[]
  disabled?: boolean
  ariaLabel?: string
  className?: string
}

export default function Dropdown({ value, onChange, options, disabled = false, ariaLabel, className }: Props) {
  return (
    <Select
      value={value === '' ? (options.some((o) => o.value === '') ? VACIO : '') : value}
      onValueChange={(v) => onChange(v === VACIO ? '' : v)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={ariaLabel} className={cn('h-10 w-full bg-field text-[13.5px] font-normal text-foreground', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value || VACIO} value={o.value === '' ? VACIO : o.value} className="text-[13.5px]">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
