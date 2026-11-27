// Passo a passo PERSONALIZADO que vem do backend (issue.manualSteps): já cita a placa de vídeo do inventário,
// notebook × desktop, o "freio de energia" da página Hardware etc. Cada passo ganha, quando faz sentido, um atalho
// para a tela do app ou do Windows que ele menciona.
import clsx from 'clsx'
import { useState } from 'react'
import { ArrowRight, ChevronDown, Footprints, ListChecks } from 'lucide-react'
import type { GuideAction } from './CrashGuide'

/** Atalho sugerido pelo texto do passo (o primeiro que combinar). */
export function stepAction(text: string): GuideAction | undefined {
  const t = text.toLowerCase()
  if (/p[aá]gina hardware|temperatura|bateria/.test(t)) return { kind: 'page', page: 'hardware', label: 'Abrir Hardware' }
  // "desative na BIOS" (XMP/overclock) não é atualização de driver: só quando fala em atualizar driver/chipset/BIOS.
  if (/\bdrivers?\b|chipset|atualiz\w* (a|da) bios/.test(t)) return { kind: 'page', page: 'drivers', label: 'Abrir Drivers' }
  // Só quando o passo manda ABRIR o Windows Update (não quando cita a correção "Reparar o Windows Update").
  if (/abr\w*[^.]{0,25}windows update|configura[cç][oõ]es\s*>\s*windows update|verificar atualiza/.test(t)) return { kind: 'settings', uri: 'ms-settings:windowsupdate', label: 'Abrir Windows Update' }
  if (/limpeza|liberar espa[cç]o|espa[cç]o livre/.test(t)) return { kind: 'page', page: 'cleanup', label: 'Abrir Limpeza' }
  if (/desinstal/.test(t)) return { kind: 'page', page: 'apps', label: 'Abrir Jogos & Programas' }
  if (/verifica[cç][aã]o completa/.test(t)) return { kind: 'deepScan', label: 'Verificação completa' }
  return undefined
}

/** "Notebook: use o carregador..." -> ['Notebook', 'use o carregador...'] (só quando o começo é curto). */
export function splitLead(text: string): [string | null, string] {
  const i = text.indexOf(':')
  if (i > 2 && i <= 42 && !/\d$/.test(text.slice(0, i)) && !/^[a-z]:/i.test(text)) return [text.slice(0, i).trim(), text.slice(i + 1).trim()]
  return [null, text]
}

export function StepList({ steps, onAction }: { steps: string[]; onAction: (a: GuideAction) => void }) {
  return (
    <ol className="space-y-2">
      {steps.map((s, i) => {
        const [lead, rest] = splitLead(s)
        const action = stepAction(s)
        return (
          <li key={i} className="flex gap-3 rounded-lg border border-border/70 bg-surface/70 p-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-info/15 text-[12px] font-semibold text-info tabular-nums">{i + 1}</span>
            <p className="selectable min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
              {lead && <b className="font-semibold text-text">{lead}: </b>}
              {rest}
            </p>
            {action && (
              <button
                type="button"
                onClick={() => onAction(action)}
                className="flex shrink-0 items-center gap-1 self-center rounded-md px-2 py-1 text-[12px] font-medium whitespace-nowrap text-accent hover:bg-surface-3"
              >
                {action.label}
                <ArrowRight className="size-3.5" />
              </button>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/** Bloco recolhível "O que fazer" para problemas sem correção automática honesta (ou com passos extras). */
export function ManualSteps({
  steps,
  title = 'O que fazer',
  intro,
  defaultOpen,
  crash,
  onAction
}: {
  steps: string[]
  title?: string
  intro?: string
  defaultOpen?: boolean
  /** Visual do guia de travamentos */
  crash?: boolean
  onAction: (a: GuideAction) => void
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen))
  if (!steps.length) return null
  const Icon = crash ? Footprints : ListChecks
  return (
    <div className={clsx('mt-3 rounded-lg border', crash ? 'border-info/25 bg-info/5' : 'border-border bg-surface-2/40')}>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left" aria-expanded={open}>
        <span className={clsx('flex items-center gap-2 text-[13px] font-semibold', crash ? 'text-info' : 'text-text')}>
          <Icon className="size-4" />
          {title}
          <span className="font-normal text-muted">· {steps.length === 1 ? '1 passo' : `${steps.length} passos`}</span>
        </span>
        <ChevronDown className={clsx('size-4 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="px-3.5 pb-3.5">
          {intro && <p className="mb-2.5 text-[13px] text-muted">{intro}</p>}
          <StepList steps={steps} onAction={onAction} />
        </div>
      )}
    </div>
  )
}
