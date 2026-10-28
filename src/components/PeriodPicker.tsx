import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, ChevronDown } from 'lucide-react'

export type Range = { start: string; end: string }

export const HOJE = new Date().toISOString().slice(0, 10)

const shiftDay = (base: string, days: number) => {
  const date = new Date(`${base}T12:00:00`)
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

const monthEnd = (base: string) => {
  const [year, month] = base.split('-').map(Number)
  const last = new Date(year, month, 0)
  return `${year}-${String(month).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`
}

const prevMonth = (base: string) => {
  const [year, month] = base.split('-').map(Number)
  const date = new Date(year, month - 2, 1)
  const start = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`
  const end = monthEnd(start)
  return { start, end }
}

const buildPresets = (base: string): { label: string; range: Range }[] => [
  { label: 'Últimos 3 dias', range: { start: shiftDay(base, -2), end: base } },
  { label: 'Últimos 7 dias', range: { start: shiftDay(base, -6), end: base } },
  { label: 'Últimos 30 dias', range: { start: shiftDay(base, -29), end: base } },
  { label: 'Este mês', range: { start: `${base.slice(0, 7)}-01`, end: monthEnd(base) } },
  { label: 'Mês anterior', range: prevMonth(base) },
  { label: 'Este ano', range: { start: `${base.slice(0, 4)}-01-01`, end: `${base.slice(0, 4)}-12-31` } },
]

export const PRESET_DEFAULT = 'Últimos 30 dias'

const presets = buildPresets(HOJE)

export const DEFAULT_RANGE: Range =
  presets.find((item) => item.label === PRESET_DEFAULT)?.range ?? { start: shiftDay(HOJE, -29), end: HOJE }

export const fullBR = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })

type Props = {
  value: Range
  onChange: (range: Range) => void
}

export default function PeriodPicker({ value, onChange }: Props) {
  const periodPresets = useMemo(() => presets, [])
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Range>(value)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const activePreset = periodPresets.find(
    (item) => item.range.start === value.start && item.range.end === value.end,
  )
  const triggerLabel = activePreset ? activePreset.label : `${fullBR(value.start)} — ${fullBR(value.end)}`

  const toggle = () => {
    setDraft(value)
    setOpen((current) => !current)
  }

  const applyPreset = (label: string) => {
    const found = periodPresets.find((item) => item.label === label)!
    setDraft(found.range)
    setOpen(false)
    onChange(found.range)
  }

  const applyCustom = () => {
    if (!draft.start || !draft.end) return
    const start = draft.start <= draft.end ? draft.start : draft.end
    const end = draft.start <= draft.end ? draft.end : draft.start
    setDraft({ start, end })
    setOpen(false)
    onChange({ start, end })
  }

  const reset = () => {
    const fallback = periodPresets.find((item) => item.label === PRESET_DEFAULT)!.range
    setDraft(fallback)
    setOpen(false)
    onChange(fallback)
  }

  return (
    <div className="period-picker" ref={pickerRef}>
      <button type="button" className="select-box period-trigger" onClick={toggle}>
        <span className="filter-label">Período</span>
        <span className="trigger-value">
          <CalendarDays size={14} />
          {triggerLabel}
          <ChevronDown size={14} className={open ? 'chevron up' : 'chevron'} />
        </span>
      </button>

      {open && (
        <div className="period-pop">
          <p className="pop-title">Período personalizado</p>
          <div className="period-presets">
            {periodPresets.map((item) => (
              <button
                key={item.label}
                type="button"
                className={activePreset?.label === item.label ? 'active' : ''}
                onClick={() => applyPreset(item.label)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="period-fields">
            <label>
              <span>Início</span>
              <input
                type="date"
                value={draft.start}
                onChange={(event) => setDraft((value) => ({ ...value, start: event.target.value }))}
              />
            </label>
            <label>
              <span>Fim</span>
              <input
                type="date"
                value={draft.end}
                onChange={(event) => setDraft((value) => ({ ...value, end: event.target.value }))}
              />
            </label>
          </div>

          <div className="period-foot">
            <span className="period-hint">navegue por meses e anos no calendário</span>
            <div className="period-actions">
              <button type="button" className="ghost" onClick={reset}>
                Limpar
              </button>
              <button type="button" className="primary" onClick={applyCustom}>
                Aplicar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
