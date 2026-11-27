// Seções de detalhe da página Desempenho: Memória, Processos, Serviços, Sistema e Eventos.
import clsx from 'clsx'
import { Activity, AppWindow, CircleCheck, HardDrive, Info, MemoryStick, Power, ShieldCheck, TriangleAlert, Zap } from 'lucide-react'
import type { PerfEventIssue, PerformanceSnapshot, ProcessInfo } from '@shared/types/performance'
import { formatBytes, formatDate, formatNumber, formatPercent } from '@shared/format'
import { useNav } from '../../lib/nav'
import { Badge, Button, Card, EmptyState, KeyValue, ProgressBar, usageTone, type Tone } from '../ui'
import { freePercent, uptimeText } from './labels'

// ---------- Memória ----------
export function MemorySection({ s }: { s: PerformanceSnapshot }) {
  const m = s.memory
  const usedPct = m.totalBytes ? (m.usedBytes / m.totalBytes) * 100 : 0
  const commitPct = m.commitLimitBytes ? (m.commitUsedBytes / m.commitLimitBytes) * 100 : 0
  const slow = m.configuredMhz && m.ratedMhz && m.configuredMhz < m.ratedMhz * 0.95
  const channel = m.dualChannel === true ? 'Dual channel' : m.dualChannel === false ? 'Single channel' : 'Não identificado'
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <Card title="RAM em uso" icon={MemoryStick}>
          <p className="text-2xl font-semibold tabular-nums">
            {formatBytes(m.usedBytes)} <span className="text-[14px] font-normal text-muted">de {formatBytes(m.totalBytes, 0)}</span>
          </p>
          <ProgressBar className="mt-2" value={usedPct} tone={usageTone(usedPct)} />
          <p className="mt-2 text-[12px] text-muted">{formatPercent(usedPct)} usado · {formatBytes(m.availableBytes)} disponível agora.</p>
        </Card>
        <Card title="Memória comprometida" icon={Activity}>
          <p className="text-2xl font-semibold tabular-nums">
            {formatBytes(m.commitUsedBytes)} <span className="text-[14px] font-normal text-muted">de {formatBytes(m.commitLimitBytes, 0)}</span>
          </p>
          <ProgressBar className="mt-2" value={commitPct} tone={usageTone(commitPct)} />
          <p className="mt-2 text-[12px] text-muted">
            Tudo o que os programas reservaram (RAM + memória virtual no disco). Perto de 100% programas fecham sozinhos.
          </p>
        </Card>
        <Card title="Velocidade e canais" icon={Zap}>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-semibold tabular-nums">{m.configuredMhz ? `${m.configuredMhz} MT/s` : '—'}</p>
            {m.ratedMhz && m.configuredMhz ? (
              slow ? (
                <Badge tone="danger" icon={TriangleAlert}>
                  Abaixo de {m.ratedMhz}
                </Badge>
              ) : (
                <Badge tone="ok" icon={CircleCheck}>
                  Nominal
                </Badge>
              )
            ) : null}
          </div>
          <p className="mt-2 text-[13px]">
            <span className={clsx(m.dualChannel === false ? 'text-warn' : m.dualChannel === true ? 'text-ok' : 'text-muted')}>{channel}</span>
            <span className="text-muted">
              {' '}
              · {m.modulesInstalled} {m.modulesInstalled === 1 ? 'pente' : 'pentes'}
              {m.slotsTotal ? ` em ${m.slotsTotal} slots` : ''} {m.memoryType ? `· ${m.memoryType}` : ''}
            </span>
          </p>
          <p className="mt-1 text-[12px] text-muted">
            {slow
              ? 'O perfil XMP/EXPO está desligado na BIOS: a RAM roda mais devagar do que foi feita para rodar.'
              : 'A memória está rodando na velocidade para a qual foi vendida.'}
          </p>
        </Card>
      </div>
      {m.modules && m.modules.length > 0 && (
        <Card title="Pentes instalados" padded={false}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Canal</th>
                <th className="num">Capacidade</th>
                <th>Tipo</th>
                <th className="num">Em uso</th>
                <th className="num">Nominal</th>
                <th>Fabricante</th>
                <th>Modelo (part number)</th>
              </tr>
            </thead>
            <tbody>
              {m.modules.map((mod, i) => (
                <tr key={`${mod.slot}-${i}`}>
                  <td className="font-medium">{mod.slot}</td>
                  <td>{mod.channel ?? '—'}</td>
                  <td className="num">{formatBytes(mod.capacityBytes, 0)}</td>
                  <td>{mod.type ?? '—'}</td>
                  <td className={clsx('num', mod.configuredMhz && mod.ratedMhz && mod.configuredMhz < mod.ratedMhz * 0.95 && 'text-danger')}>
                    {mod.configuredMhz ? `${mod.configuredMhz} MT/s` : '—'}
                  </td>
                  <td className="num">{mod.ratedMhz ? `${mod.ratedMhz} MT/s` : '—'}</td>
                  <td>{mod.manufacturer ?? '—'}</td>
                  <td className="selectable font-mono text-[12px]">{mod.partNumber ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}

// ---------- Processos ----------
function ProcTable({ title, list, metric, total }: { title: string; list: ProcessInfo[]; metric: 'cpu' | 'mem'; total: number }) {
  return (
    <Card title={title} padded={false} icon={metric === 'cpu' ? Activity : MemoryStick}>
      {list.length === 0 ? (
        <EmptyState title="Sem dados" className="py-6" />
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Programa</th>
              <th className="num w-16">Proc.</th>
              <th className="w-44">{metric === 'cpu' ? 'Processador' : 'Memória'}</th>
            </tr>
          </thead>
          <tbody>
            {list.slice(0, 10).map((p) => {
              const value = metric === 'cpu' ? (p.cpuPercent ?? 0) : total ? (p.memoryBytes / total) * 100 : 0
              return (
                <tr key={`${p.name}-${p.pid}`}>
                  <td className="max-w-0">
                    <p className="truncate font-medium" title={p.path ?? p.name}>
                      {p.description || p.name}
                    </p>
                    <p className="truncate text-[12px] text-faint">{[p.name, p.company].filter(Boolean).join(' · ')}</p>
                  </td>
                  <td className="num text-muted">{p.instances ?? 1}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <ProgressBar size="sm" value={metric === 'cpu' ? value : Math.min(100, value * 2)} tone={value >= 25 ? 'warn' : 'accent'} />
                      <span className="w-16 shrink-0 text-right text-[12px] tabular-nums">
                        {metric === 'cpu' ? formatPercent(p.cpuPercent, 1) : formatBytes(p.memoryBytes)}
                      </span>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Card>
  )
}

export function ProcessesSection({ s }: { s: PerformanceSnapshot }) {
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-1.5 text-[13px] text-muted">
        <Info className="size-4 shrink-0 text-info" />
        Medido por cerca de 1,5 segundo no momento da análise (carga total do processador: <b className="text-text">{formatPercent(s.cpu.loadPercent)}</b>
        ). Programas com vários processos (navegadores) aparecem somados.
      </p>
      <div className="grid grid-cols-2 gap-4">
        <ProcTable title="Usando mais processador" list={s.topProcessesByCpu} metric="cpu" total={100} />
        <ProcTable title="Usando mais memória" list={s.topProcessesByMemory} metric="mem" total={s.memory.totalBytes} />
      </div>
    </div>
  )
}

// ---------- Serviços ----------
export function ServicesSection({ s }: { s: PerformanceSnapshot }) {
  const nav = useNav()
  const list = s.services.nonMicrosoft
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-surface-2 p-3.5 text-[13px]">
        <p className="text-muted">
          <b className="text-text">{s.services.running}</b> serviços rodando{s.services.total ? ` (de ${s.services.total} instalados)` : ''}, dos quais{' '}
          <b className="text-text">{s.services.nonMicrosoftRunning}</b> são de outros fabricantes. Não recomendamos desativar serviços na mão (é fácil
          quebrar algo): se não usa o programa, desinstale-o — o serviço sai junto.
        </p>
        <Button size="sm" icon={AppWindow} onClick={() => nav.go('apps')}>
          Jogos & Programas
        </Button>
      </div>
      {list.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="Nenhum serviço de terceiros em execução" />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="tbl">
            <thead>
              <tr>
                <th>Serviço</th>
                <th className="w-52">Empresa</th>
                <th className="w-28">Início</th>
              </tr>
            </thead>
            <tbody>
              {list.map((sv) => (
                <tr key={sv.name}>
                  <td className="max-w-0">
                    <p className="truncate font-medium" title={sv.path}>
                      {sv.displayName}
                    </p>
                    <p className="truncate text-[12px] text-faint" title={sv.description}>
                      {sv.description || sv.path || sv.name}
                    </p>
                  </td>
                  <td className="text-muted">{sv.company || 'Desconhecida'}</td>
                  <td className="text-muted">{sv.startType === 'Auto' ? 'Automático' : sv.startType === 'Manual' ? 'Manual' : sv.startType}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------- Sistema ----------
function yesNo(v: boolean | undefined, yes = 'Ligado', no = 'Desligado'): string {
  return v === undefined ? 'Desconhecido' : v ? yes : no
}

export function SystemSection({ s }: { s: PerformanceSnapshot }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <Card title="Windows" icon={Info}>
        <KeyValue
          items={[
            { label: 'Sistema', value: `${s.os.caption}${s.os.displayVersion ? ` (${s.os.displayVersion})` : ''}` },
            { label: 'Build', value: s.os.build || '—' },
            { label: 'Instalado em', value: formatDate(s.os.installDate) },
            { label: 'Ligado há', value: uptimeText(s.uptimeSeconds) },
            { label: 'Último boot', value: formatDate(s.os.lastBoot, true) },
            { label: 'Tempo do último boot', value: s.lastBootDurationMs ? `${formatNumber(s.lastBootDurationMs / 1000, 1)} s` : 'Não registrado' },
            { label: 'Reinício pendente', value: s.pendingReboot ? 'Sim' : 'Não' },
            ...(s.pendingReboot && s.pendingRebootReasons?.length ? [{ label: 'Motivo', value: s.pendingRebootReasons.join('; ') }] : [])
          ]}
        />
      </Card>
      <Card title="Energia e memória virtual" icon={Power}>
        <KeyValue
          items={[
            { label: 'Plano de energia', value: s.powerPlan.name },
            { label: 'Hibernação', value: s.hibernation.enabled ? `Ligada (${s.hibernation.type === 'reduced' ? 'reduzida' : 'completa'})` : 'Desligada' },
            { label: 'hiberfil.sys', value: s.hibernation.fileBytes ? formatBytes(s.hibernation.fileBytes) : '—' },
            { label: 'Inicialização Rápida', value: yesNo(s.hibernation.fastStartup, 'Ligada', 'Desligada') },
            { label: 'Memória virtual', value: s.pagefile.systemManaged ? 'Gerenciada pelo Windows' : s.pagefile.systemManaged === false ? 'Configurada manualmente' : '—' },
            {
              label: 'Arquivos de paginação',
              value: (s.pagefile.files ?? []).map((f) => `${f.path} (${formatBytes(f.allocatedBytes)})`).join(', ') || '—'
            }
          ]}
        />
      </Card>
      <Card title="Jogos e aparência" icon={Activity}>
        <KeyValue
          items={[
            { label: 'Modo de Jogo', value: yesNo(s.gaming.gameMode, 'Ativado', 'Desativado') },
            { label: 'Agendamento de GPU (HAGS)', value: s.gaming.hags === undefined ? 'Padrão do driver' : yesNo(s.gaming.hags) },
            { label: 'Captura de jogos (Game DVR)', value: yesNo(s.gaming.gameDvrEnabled, 'Ativada', 'Desligada') },
            { label: 'Gravação em segundo plano', value: yesNo(s.gaming.gameDvrBackgroundRecording, 'Gravando', 'Desligada') },
            { label: 'Efeitos visuais', value: s.visualEffects ?? '—' },
            { label: 'Placas de vídeo', value: (s.gpus ?? []).map((g) => g.name).join(', ') || '—' }
          ]}
        />
      </Card>
      <Card title="Segurança" icon={ShieldCheck}>
        <KeyValue
          items={[
            { label: 'Antivírus instalados', value: s.security.antivirusProducts.join(', ') || 'Nenhum detectado' },
            { label: 'Proteção ativa', value: (s.security.activeAntivirus ?? []).join(', ') || 'Nenhuma' },
            { label: 'Microsoft Defender (tempo real)', value: yesNo(s.security.defenderRealtime, 'Ligado', 'Desligado/passivo') },
            { label: 'Sensor de Armazenamento', value: yesNo(s.storageSense, 'Ativado', 'Desativado') },
            { label: 'TRIM (SSD)', value: s.trim?.ntfsEnabled === undefined ? '—' : s.trim.ntfsEnabled ? 'Ativado' : 'Desativado' },
            { label: 'Contadores de desempenho', value: s.perfCountersOk === false ? 'Com defeito' : 'OK' }
          ]}
        />
      </Card>
      <Card title="Discos" icon={HardDrive} className="col-span-2">
        <div className="grid grid-cols-3 gap-4">
          {s.drives.map((d) => {
            const free = freePercent(d)
            const frag = s.fragmentation?.find((f) => f.letter.toUpperCase() === d.letter.toUpperCase())
            return (
              <div key={d.letter} className="rounded-lg border border-border bg-surface-2 p-3">
                <div className="flex items-center justify-between">
                  <p className="font-semibold">
                    {d.letter} <span className="font-normal text-muted">{d.label}</span>
                  </p>
                  <Badge tone={d.mediaType === 'HDD' ? 'warn' : 'accent'}>{`${d.mediaType}${d.busType ? ` · ${d.busType}` : ''}`}</Badge>
                </div>
                <ProgressBar className="mt-2" size="sm" value={100 - free} tone={usageTone(100 - free)} />
                <p className="mt-1.5 text-[12px] text-muted">
                  {formatBytes(d.freeBytes)} livres de {formatBytes(d.totalBytes, 0)} ({formatPercent(free, 1)}){d.isSystem ? ' · sistema' : ''}
                </p>
                {frag && d.mediaType === 'HDD' && <p className="text-[12px] text-muted">Fragmentação: {frag.percent}%</p>}
                {frag?.lastRun && <p className="text-[12px] text-faint">Otimizado em {formatDate(frag.lastRun)}</p>}
              </div>
            )
          })}
        </div>
      </Card>
    </div>
  )
}

// ---------- Eventos ----------
const KIND: Record<NonNullable<PerfEventIssue['kind']>, { label: string; tone: Tone; help: string }> = {
  disk: { label: 'Disco', tone: 'danger', help: 'Falhas de leitura/gravação: o disco pode estar com defeito ou o cabo com mau contato.' },
  whea: { label: 'Hardware', tone: 'danger', help: 'Erros relatados pelo processador/memória: instabilidade, overclock ou temperatura.' },
  power: { label: 'Desligamento', tone: 'warn', help: 'O PC desligou sem o desligamento normal (queda de energia, travamento ou botão segurado).' },
  bugcheck: { label: 'Tela azul', tone: 'danger', help: 'O Windows travou com erro grave (BSOD).' },
  appCrash: { label: 'Programa fechou', tone: 'info', help: 'O programa fechou sozinho com erro.' },
  appHang: { label: 'Não respondeu', tone: 'neutral', help: 'O programa congelou e foi fechado.' }
}

export function EventsSection({ s }: { s: PerformanceSnapshot }) {
  const list = [...s.eventLogIssues].sort((a, b) => b.count - a.count)
  if (!list.length) {
    return <EmptyState icon={CircleCheck} title="Nenhum problema no log do Windows nos últimos 30 dias" description="Sem erros de disco, de hardware, telas azuis ou desligamentos inesperados." />
  }
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">Problemas registrados pelo próprio Windows nos últimos 30 dias. Passe o mouse no tipo para entender.</p>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="tbl">
          <thead>
            <tr>
              <th className="w-36">Tipo</th>
              <th>O que aconteceu</th>
              <th className="num w-20">Vezes</th>
              <th className="w-36">Última vez</th>
            </tr>
          </thead>
          <tbody>
            {list.map((e, i) => {
              const k = KIND[e.kind ?? 'appCrash']
              return (
                <tr key={`${e.source}-${e.eventId}-${e.app ?? ''}-${i}`}>
                  <td title={k.help}>
                    <Badge tone={k.tone}>{k.label}</Badge>
                  </td>
                  <td className="max-w-0">
                    <p className="selectable truncate" title={e.message}>
                      {e.message || `${e.source} (evento ${e.eventId})`}
                    </p>
                    <p className="truncate text-[12px] text-faint">
                      {e.source} · evento {e.eventId}
                    </p>
                  </td>
                  <td className="num font-semibold">{e.count}</td>
                  <td className="text-[12px] text-muted">{formatDate(e.lastSeen, true)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
