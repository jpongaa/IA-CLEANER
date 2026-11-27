// Seções da Busca Profunda: uma por tipo de achado, a seção especial do Hydra Launcher e os detalhes da busca.
import clsx from 'clsx'
import { CheckCircle2, CircleDashed, Download, Gamepad2, Info, ListChecks, MapPin, PackageOpen, TriangleAlert } from 'lucide-react'
import type { DiscoverReport, Finding, FindingAction, FindingKind } from '@shared/types/discover'
import { formatBytes } from '@shared/format'
import { Badge, Button } from '../ui'
import { FindingRow } from './FindingRow'
import { kindMeta } from './meta'
import { isBulkEligible, isHydraLauncher, isPassive, type FindingNote, type HydraGameEntry, type HydraStateKey } from './logic'

export interface RowHandlers {
  notes: Record<string, FindingNote>
  selected: Set<string>
  onSelect: (id: string, v: boolean) => void
  onSelectMany: (ids: string[], v: boolean) => void
  onAction: (f: Finding, a: FindingAction) => void
  busy: { findingId: string; action: string } | null
  disabled?: boolean
}

function Rows({ findings, h, hideSource }: { findings: Finding[]; h: RowHandlers; hideSource?: boolean }) {
  return (
    <ul>
      {findings.map((f) => (
        <FindingRow
          key={f.id}
          finding={f}
          note={h.notes[f.id]}
          selected={h.selected.has(f.id)}
          onSelect={h.onSelect}
          onAction={h.onAction}
          busyAction={h.busy?.findingId === f.id ? h.busy.action : null}
          disabled={h.disabled}
          hideSource={hideSource}
        />
      ))}
    </ul>
  )
}

function SelectSafeButton({ findings, h }: { findings: Finding[]; h: RowHandlers }) {
  const ids = findings.filter(isBulkEligible).map((f) => f.id)
  if (ids.length === 0) return null
  const all = ids.every((id) => h.selected.has(id))
  return (
    <Button size="sm" variant="ghost" icon={ListChecks} onClick={() => h.onSelectMany(ids, !all)} disabled={h.disabled} data-testid="select-safe">
      {all ? 'Desmarcar' : `Marcar os seguros (${ids.length})`}
    </Button>
  )
}

export function KindSection({ kind, findings, h }: { kind: FindingKind; findings: Finding[]; h: RowHandlers }) {
  const m = kindMeta(kind)
  const bytes = findings.reduce((s, f) => s + Math.max(0, f.bytes), 0)
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface" data-section={kind}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 px-4 py-3">
        <div className="flex min-w-0 flex-1 basis-[360px] items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/10">
            <m.icon className="size-4 text-accent" />
          </div>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold">
              {m.label}{' '}
              <span className="text-[13px] font-normal text-muted">
                · {findings.length} {findings.length === 1 ? 'item' : 'itens'}
                {bytes > 0 ? ` · ${formatBytes(bytes)}` : ''}
              </span>
            </h3>
            <p className="mt-0.5 max-w-3xl text-[12.5px] leading-relaxed text-muted">{m.about}</p>
          </div>
        </div>
        <SelectSafeButton findings={findings} h={h} />
      </header>
      <Rows findings={findings} h={h} />
    </section>
  )
}

// ---------- Hydra Launcher ----------
const STATE_ICON: Record<HydraStateKey, typeof CheckCircle2> = { installed: CheckCircle2, installer: Download, other: PackageOpen, gone: CircleDashed }
const TONE_TEXT: Record<HydraGameEntry['tone'], string> = { ok: 'text-ok', warn: 'text-warn', info: 'text-info', neutral: 'text-faint' }

export function HydraSection({
  launcher,
  games,
  gameList,
  h
}: {
  /** Achado(s) do launcher (já filtrados) */
  launcher: Finding[]
  /** Jogos do Hydra que são achados (já filtrados) */
  games: Finding[]
  /** Situação de todos os jogos do Hydra (sem filtro) */
  gameList: HydraGameEntry[]
  h: RowHandlers
}) {
  const count = (k: HydraStateKey): number => gameList.filter((x) => x.state === k).length
  const actionable = games.filter((g) => g.paths.length > 0 || g.actions.some((a) => !isPassive(a.kind)))
  const bytes = launcher.reduce((s, f) => s + Math.max(0, f.bytes), 0) + gameList.reduce((s, g) => s + g.bytes, 0)
  return (
    <section className="overflow-hidden rounded-xl border border-ai/30 bg-surface" data-testid="discover-hydra">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 bg-ai/[0.05] px-4 py-3">
        <div className="flex min-w-0 flex-1 basis-[360px] items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-ai/15">
            <Gamepad2 className="size-4 text-ai" />
          </div>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold">
              Hydra Launcher{' '}
              <span className="text-[13px] font-normal text-muted">
                · {gameList.length} {gameList.length === 1 ? 'jogo' : 'jogos'}
                {bytes > 0 ? ` · ${formatBytes(bytes)} no disco` : ''}
              </span>
            </h3>
            <p className="mt-0.5 max-w-3xl text-[12.5px] leading-relaxed text-muted">
              O Hydra baixa jogos (geralmente repacks) fora da Steam/Epic, e eles costumam ficar esquecidos. Aqui está o próprio launcher, o que ele baixou e
              se cada jogo ainda está no PC.
            </p>
          </div>
        </div>
        <SelectSafeButton findings={[...launcher, ...games]} h={h} />
      </header>

      {launcher.length > 0 && <Rows findings={launcher} h={h} hideSource />}

      {gameList.length > 0 ? (
        <div className="border-t border-border/60 px-4 py-3" data-testid="hydra-games">
          <div className="mb-2.5 flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className="font-medium text-text">Situação de cada jogo:</span>
            {count('installed') > 0 && <Badge tone="ok">{count('installed')} {count('installed') === 1 ? 'instalado' : 'instalados'}</Badge>}
            {count('installer') > 0 && <Badge tone="info">{count('installer')} com instalador baixado</Badge>}
            {count('other') > 0 && <Badge tone="warn">{count('other')} com arquivos no disco</Badge>}
            {count('gone') > 0 && <Badge tone="neutral">{count('gone')} {count('gone') === 1 ? 'não está' : 'não estão'} mais no PC</Badge>}
          </div>
          <ul className="grid gap-x-6 gap-y-1 xl:grid-cols-2">
            {gameList.map((g) => {
              const Icon = STATE_ICON[g.state]
              return (
                <li key={g.key} className="flex min-w-0 items-center justify-between gap-3 border-b border-border/40 py-1.5 text-[13px]" data-hydra-game={g.key} title={g.path}>
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon className={clsx('size-3.5 shrink-0', TONE_TEXT[g.tone])} />
                    <span className={clsx('truncate', g.state === 'gone' ? 'text-muted' : 'text-text')}>{g.name}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge tone={g.tone}>{g.label}</Badge>
                    <span className="w-16 text-right text-[12px] text-faint tabular-nums">{g.bytes > 0 ? formatBytes(g.bytes) : '—'}</span>
                  </span>
                </li>
              )
            })}
          </ul>
          {count('gone') > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-[12px] text-faint">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              &quot;Não está mais no PC&quot;: o jogo está na biblioteca do Hydra, mas os arquivos não existem mais (já foram apagados). Não ocupa espaço.
            </p>
          )}
        </div>
      ) : (
        <p className="border-t border-border/60 px-4 py-3 text-[12.5px] text-muted">Nenhum jogo baixado pelo Hydra foi encontrado no disco.</p>
      )}

      {actionable.length > 0 && (
        <div className="border-t border-border/60">
          <p className="px-4 pt-3 text-[12px] font-semibold tracking-wide text-muted uppercase">O que dá para fazer</p>
          <Rows findings={actionable} h={h} hideSource />
        </div>
      )}
    </section>
  )
}

export function splitHydra(findings: Finding[]): { launcher: Finding[]; games: Finding[] } {
  const launcher: Finding[] = []
  const games: Finding[] = []
  for (const f of findings) {
    if (isHydraLauncher(f)) launcher.push(f)
    else games.push(f)
  }
  return { launcher, games }
}

// ---------- Detalhes da busca ----------
export function ScanDetails({ report }: { report: DiscoverReport }) {
  const locs = report.locationsScanned ?? []
  const warns = report.warnings ?? []
  if (locs.length === 0 && warns.length === 0) return null
  return (
    <div className="space-y-2 text-[12px] text-faint" data-testid="discover-scan-details">
      {locs.length > 0 && (
        <details>
          <summary className="cursor-pointer select-none hover:text-muted">
            <MapPin className="mr-1 inline size-3.5" />
            Onde procuramos ({locs.length} {locs.length === 1 ? 'local' : 'locais'})
          </summary>
          <ul className="selectable mt-2 columns-1 gap-6 pl-5 lg:columns-2">
            {locs.map((l) => (
              <li key={l} className="truncate" title={l}>
                {l}
              </li>
            ))}
          </ul>
        </details>
      )}
      {warns.length > 0 && (
        <details>
          <summary className="cursor-pointer select-none hover:text-muted">
            <TriangleAlert className="mr-1 inline size-3.5" />
            {warns.length} {warns.length === 1 ? 'aviso' : 'avisos'} da busca (lugares que não deu para ler)
          </summary>
          <ul className="selectable mt-2 space-y-1 pl-5">
            {warns.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
