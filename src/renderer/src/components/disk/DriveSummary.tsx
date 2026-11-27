import type { ReactNode } from 'react'
import { Cloud, FolderTree, History, Info, Link2, Lock, ShieldAlert, Sigma } from 'lucide-react'
import type { DriveScanResult } from '@shared/types/disk'
import { formatBytes, formatDate, formatDuration, formatNumber } from '@shared/format'
import { StatCard } from '../ui'

const GB = 1024 ** 3

function Note({ icon: Icon, tone = 'info', children, title }: { icon: typeof Info; tone?: 'info' | 'warn'; children: ReactNode; title?: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface-2/60 px-3 py-2.5 text-[12.5px] leading-relaxed" title={title}>
      <Icon className={tone === 'warn' ? 'mt-0.5 size-4 shrink-0 text-warn' : 'mt-0.5 size-4 shrink-0 text-info'} />
      <div className="text-muted">{children}</div>
    </div>
  )
}

export function DriveSummary({ drive, isSystem }: { drive: DriveScanResult; isSystem: boolean }) {
  const oldBytes = drive.oldLargeFiles.reduce((s, f) => s + f.bytes, 0)
  const biggest = drive.tree.children?.[0]
  const unexplained = drive.volumeUsedBytes !== undefined ? drive.volumeUsedBytes - drive.totalBytes : 0

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-3">
        <StatCard
          label="Espaço encontrado"
          icon={Sigma}
          value={formatBytes(drive.totalBytes)}
          hint={`${formatNumber(drive.files)} arquivos · ${formatNumber(drive.dirs)} pastas`}
        />
        <StatCard
          label="Maior pasta"
          icon={FolderTree}
          value={biggest ? formatBytes(biggest.bytes) : '—'}
          hint={<span className="block truncate" title={biggest?.path}>{biggest?.name ?? 'Nenhuma subpasta grande'}</span>}
        />
        <StatCard
          label="Antigos e grandes"
          icon={History}
          tone={oldBytes > 5 * GB ? 'warn' : 'accent'}
          value={formatBytes(oldBytes)}
          hint={`${drive.oldLargeFiles.length} arquivos ≥ 100 MB parados há 6+ meses`}
        />
        <StatCard
          label="Só na nuvem"
          icon={Cloud}
          tone="info"
          value={formatBytes(drive.cloudOnlyBytes)}
          hint={drive.cloudOnlyFiles ? `${formatNumber(drive.cloudOnlyFiles)} arquivos (não ocupam este disco)` : 'Nenhum arquivo só-na-nuvem'}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        {drive.engine === 'node' && (
          <Note icon={Info} tone="warn">
            Análise feita no <b className="text-text">modo compatível</b> (o verificador rápido não estava disponível). Arquivos que estão só na nuvem
            não puderam ser separados e podem aparecer somados.
          </Note>
        )}
        {drive.cloudOnlyBytes > 0 && (
          <Note icon={Cloud}>
            <b className="text-text">{formatBytes(drive.cloudOnlyBytes)}</b> em arquivos do OneDrive estão <b className="text-text">só na nuvem</b>: aparecem
            no Explorer, mas não ocupam espaço neste disco — por isso não entram na soma.
          </Note>
        )}
        {drive.inaccessibleDirs > 0 && (
          <Note icon={Lock} title={drive.inaccessibleSamples?.slice(0, 12).join('\n')}>
            <b className="text-text">{formatNumber(drive.inaccessibleDirs)}</b> pasta(s) não puderam ser lidas sem permissão de Administrador (ex.:{' '}
            <span className="font-mono text-[11.5px]">{shortSample(drive.inaccessibleSamples)}</span>). O tamanho delas não entra na conta.
          </Note>
        )}
        {isSystem && (
          <Note icon={ShieldAlert} tone="warn">
            A pasta <b className="text-text">Windows</b> (principalmente <span className="font-mono">WinSxS</span>) parece maior do que é: muitos arquivos são
            “hardlinks” (o mesmo arquivo em dois lugares) e são contados duas vezes. <b className="text-text">Nunca apague nada ali à mão</b> — use a
            Limpeza Inteligente, que usa as ferramentas oficiais do Windows.
          </Note>
        )}
        {unexplained > 2 * GB && (
          <Note icon={Info}>
            O Windows diz que <b className="text-text">{formatBytes(drive.volumeUsedBytes)}</b> estão em uso, mas a varredura achou{' '}
            {formatBytes(drive.totalBytes)}. Os <b className="text-text">{formatBytes(unexplained)}</b> restantes ficam em pontos de restauração (cópias de
            sombra), metadados do disco e pastas sem permissão.
          </Note>
        )}
        {unexplained < -2 * GB && (
          <Note icon={Info}>
            A soma dos arquivos passa do espaço realmente usado em <b className="text-text">{formatBytes(-unexplained)}</b>: arquivos com hardlinks ou
            compactados pelo Windows são contados pelo tamanho original.
          </Note>
        )}
        {(drive.skippedLinks ?? 0) > 0 && (
          <Note icon={Link2}>
            {formatNumber(drive.skippedLinks)} atalhos de pasta (junctions/symlinks, como “Documents and Settings”) não foram seguidos, para não contar nada em
            dobro.
          </Note>
        )}
      </div>

      <p className="text-[11px] text-faint">
        Analisado em {formatDate(drive.scannedAt, true)} · levou {formatDuration(drive.durationMs)} ·{' '}
        {drive.engine === 'native' ? `verificador rápido${drive.threads ? ` (${drive.threads} threads)` : ''}` : 'modo compatível'}
      </p>
    </div>
  )
}

function shortSample(samples: string[] | undefined): string {
  const s = samples?.find((x) => /System Volume Information/i.test(x)) ?? samples?.[0]
  if (!s) return '—'
  return s.length > 48 ? '…' + s.slice(-46) : s
}
