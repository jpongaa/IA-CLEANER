// Espaço por tipo de arquivo: barras horizontais ordenadas (magnitude) + tabela das extensões que mais ocupam.
import type { DriveScanResult } from '@shared/types/disk'
import { formatBytes, formatNumber, formatPercent } from '@shared/format'
import { Badge, Card } from '../ui'
import { CATEGORY_LABEL, CATEGORY_SHORT, CATEGORY_TONE, EXT_HINT, percentOf } from './labels'

const CATEGORY_HINT: Partial<Record<string, string>> = {
  gameData: 'Arquivos dentro das bibliotecas dos launchers (Steam, Epic, Xbox...) e dados de jogos.',
  system: 'Pasta Windows, pagefile.sys, hiberfil.sys e arquivos do sistema.',
  temp: 'Pastas Temp e caches (shaders, navegador...). Use a Limpeza Inteligente.',
  executable: 'Programas e bibliotecas (.exe/.dll) — saem ao desinstalar o programa.',
  other: 'Tipos sem categoria (inclui modelos de IA, bancos de dados e arquivos sem extensão).'
}

export function TypesView({ drive }: { drive: DriveScanResult }) {
  const cats = [...drive.categories].filter((c) => c.bytes > 0).sort((a, b) => b.bytes - a.bytes)
  const max = cats[0]?.bytes ?? 0
  const total = cats.reduce((s, c) => s + c.bytes, 0)
  const exts = (drive.extensions ?? []).filter((e) => e.bytes > 0).slice(0, 25)
  const extMax = exts[0]?.bytes ?? 0

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4">
      <Card title="Por categoria" subtitle="Quanto espaço cada tipo de arquivo ocupa nesta unidade.">
        <ul className="space-y-1">
          {cats.map((c) => {
            const pct = percentOf(c.bytes, total)
            return (
              <li
                key={c.category}
                className="rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2"
                title={`${CATEGORY_LABEL[c.category]}: ${formatBytes(c.bytes)} em ${formatNumber(c.files)} arquivos (${formatPercent(pct, 1)})${
                  CATEGORY_HINT[c.category] ? '\n' + CATEGORY_HINT[c.category] : ''
                }`}
              >
                <div className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className="truncate font-medium">{CATEGORY_LABEL[c.category] ?? c.category}</span>
                  <span className="shrink-0 tabular-nums">
                    <b>{formatBytes(c.bytes)}</b> <span className="text-[12px] text-faint">· {formatPercent(pct, pct < 10 ? 1 : 0)}</span>
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full rounded-full bg-[#3987e5]" style={{ width: `${Math.max(0.6, percentOf(c.bytes, max))}%` }} />
                </div>
              </li>
            )
          })}
        </ul>
        {!cats.length && <p className="text-[13px] text-muted">Sem dados.</p>}
      </Card>

      <Card title="Extensões que mais ocupam" subtitle="Ajuda a entender o que é a parte “Outros”.">
        <div className="max-h-[520px] overflow-auto rounded-lg border border-border">
          <table className="tbl">
            <thead>
              <tr>
                <th>Extensão</th>
                <th className="w-24">Tipo</th>
                <th className="num w-20">Arquivos</th>
                <th className="num w-24">Tamanho</th>
              </tr>
            </thead>
            <tbody>
              {exts.map((e) => (
                <tr key={e.ext} title={EXT_HINT[e.ext]}>
                  <td className="max-w-0">
                    <p className="font-mono font-semibold whitespace-nowrap">{e.ext === '' ? '(sem extensão)' : e.ext === '*' ? '(outras)' : `.${e.ext}`}</p>
                    {EXT_HINT[e.ext] && <p className="truncate text-[11.5px] text-muted">{EXT_HINT[e.ext]}</p>}
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
                      <div className="h-full rounded-full bg-[#3987e5]" style={{ width: `${Math.max(1, percentOf(e.bytes, extMax))}%` }} />
                    </div>
                  </td>
                  <td>
                    <Badge tone={CATEGORY_TONE[e.category] ?? 'neutral'}>{CATEGORY_SHORT[e.category] ?? e.category}</Badge>
                  </td>
                  <td className="num text-muted">{formatNumber(e.files)}</td>
                  <td className="num font-semibold">{formatBytes(e.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!exts.length && <p className="p-4 text-[13px] text-muted">Análise antiga sem detalhes por extensão. Analise de novo para ver.</p>}
        </div>
      </Card>
    </div>
  )
}
