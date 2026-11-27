// Atalhos para as ferramentas que vão além da limpeza: Reparar Erros e Busca Profunda (com o último resultado de cada).
import type { ReactNode } from 'react'
import { ArrowRight, ScanSearch, Wrench, type LucideIcon } from 'lucide-react'
import type { RepairReport } from '@shared/types/repair'
import type { DiscoverReport } from '@shared/types/discover'
import { formatBytes } from '@shared/format'
import { useNav, type PageId } from '../../lib/nav'
import { Badge, Card, Skeleton } from '../ui'
import { timeAgo } from '../history/meta'

function ToolTile({ icon: Icon, title, text, status, page, testId }: { icon: LucideIcon; title: string; text: ReactNode; status?: ReactNode; page: PageId; testId: string }) {
  const { go } = useNav()
  return (
    <button
      onClick={() => go(page)}
      data-testid={testId}
      className="group flex w-full items-start gap-3 rounded-xl border border-border bg-surface-2/40 p-3 text-left transition-colors hover:border-border-strong hover:bg-surface-2"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-accent/30 bg-accent/10">
        <Icon className="size-4.5 text-accent" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[13px] font-semibold">
          {title}
          <ArrowRight className="ml-auto size-3.5 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-accent" />
        </span>
        {status && <span className="mt-1 flex flex-wrap items-center gap-1.5">{status}</span>}
        <span className="mt-1 block text-[12px] text-muted">{text}</span>
      </span>
    </button>
  )
}

export function ToolsCard({
  repair,
  discover,
  loading
}: {
  repair: RepairReport | null
  discover: DiscoverReport | null
  loading: boolean
}) {
  // Ferramentas (tool) não são problemas: contam só os problemas reais.
  const issues = (repair?.issues ?? []).filter((i) => !i.tool && i.severity !== 'info')
  const problems = repair?.summary?.problems ?? issues.length
  const important = repair?.summary ? repair.summary.critical + repair.summary.high : issues.filter((i) => i.severity === 'critical' || i.severity === 'high').length
  const findings = discover?.findings ?? []
  const bytes = findings.reduce((s, f) => s + (Number.isFinite(f.bytes) ? f.bytes : 0), 0)
  return (
    <Card title="Vá mais fundo" icon={ScanSearch} subtitle="O que a limpeza comum não pega.">
      {loading && !repair && !discover ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <div className="space-y-2.5">
          <ToolTile
            testId="tool-repair"
            icon={Wrench}
            title="Reparar Erros"
            page="repair"
            status={
              repair ? (
                problems ? (
                  <>
                    <Badge tone={important ? 'danger' : 'warn'}>
                      {problems} {problems === 1 ? 'problema' : 'problemas'}
                    </Badge>
                    <span className="text-[11px] text-faint">verificado {timeAgo(repair.scannedAt)}</span>
                  </>
                ) : (
                  <>
                    <Badge tone="ok">Nenhum erro</Badge>
                    <span className="text-[11px] text-faint">verificado {timeAgo(repair.scannedAt)}</span>
                  </>
                )
              ) : undefined
            }
            text="Erros reais do Windows — arquivos corrompidos, disco, Windows Update, entradas quebradas, telas azuis e travamentos — corrigidos com backup e Desfazer."
          />
          <ToolTile
            testId="tool-discover"
            icon={ScanSearch}
            title="Busca Profunda"
            page="discover"
            status={
              discover ? (
                <>
                  <Badge tone={findings.length ? 'accent' : 'ok'}>
                    {findings.length ? `${findings.length} achados · ${formatBytes(bytes)}` : 'Nada perdido'}
                  </Badge>
                  <span className="text-[11px] text-faint">{timeAgo(discover.scannedAt)}</span>
                </>
              ) : undefined
            }
            text="Instaladores e repacks esquecidos, zips já extraídos, sobras de programas desinstalados e jogos fora dos launchers."
          />
        </div>
      )}
    </Card>
  )
}
