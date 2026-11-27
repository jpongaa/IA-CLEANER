// Aviso de análise desatualizada: algumas das maiores pastas/arquivos da última análise não existem mais
// (apagados fora do app, jogo desinstalado...). Oferece analisar de novo ou só tirar do mapa o que sumiu.
import { Clock, ScanSearch, Eraser } from 'lucide-react'
import type { ScanFreshness } from '@shared/types/disk'
import { formatBytes, formatNumber } from '@shared/format'
import { Button } from '../ui'
import { baseOf } from './folderSafety'

export function StaleScanNotice({
  fresh,
  scanning,
  forgetting,
  onRescan,
  onForget
}: {
  fresh: ScanFreshness
  scanning: boolean
  forgetting: boolean
  /** Analisa de novo as unidades afetadas */
  onRescan: (roots: string[]) => void
  /** Só tira do mapa o que sumiu (não lê o disco de novo) */
  onForget: () => void
}) {
  if (!fresh.missingCount) return null
  const roots = [...new Set(fresh.missing.map((m) => m.root))]
  const examples = fresh.missing.slice(0, 3)
  const list = fresh.missing
    .slice(0, 15)
    .map((m) => `${m.kind === 'dir' ? '[pasta] ' : ''}${m.path} — ${formatBytes(m.bytes)}`)
    .join('\n')
  return (
    <div className="flex items-start gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-[13px]" data-testid="stale-scan">
      <Clock className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="min-w-0 flex-1" title={list}>
        <p>
          <b>Algumas pastas não existem mais — analise de novo.</b>{' '}
          {fresh.missingCount === 1 ? 'Um item grande' : `${formatNumber(fresh.missingCount)} itens grandes`} desta análise ({formatBytes(fresh.missingBytes)}){' '}
          {fresh.missingCount === 1 ? 'já não está' : 'já não estão'} no disco: {examples.map((e, i) => (
            <span key={e.path}>
              {i > 0 && ', '}
              <b className="font-medium">{baseOf(e.path)}</b>
            </span>
          ))}
          {fresh.missingCount > examples.length ? ' e outros' : ''}. O mapa e os totais podem estar maiores do que o real.
        </p>
      </div>
      <Button size="sm" variant="ghost" icon={Eraser} loading={forgetting} disabled={scanning} onClick={onForget} title="Tira do mapa o que sumiu, sem analisar o disco de novo">
        Tirar do mapa
      </Button>
      <Button size="sm" variant="secondary" icon={ScanSearch} disabled={scanning || forgetting} onClick={() => onRescan(roots)} data-testid="stale-rescan">
        Analisar {roots.join(' ')} de novo
      </Button>
    </div>
  )
}
