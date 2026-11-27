// Card educativo: por que apagar arquivos não resolveu a lentidão (com dicas do próprio PC, quando houver dados).
import clsx from 'clsx'
import { useState } from 'react'
import {
  ArrowRight,
  ChevronDown,
  HardDrive,
  Lightbulb,
  MemoryStick,
  Puzzle,
  Recycle,
  Rocket,
  Snail,
  Thermometer,
  type LucideIcon
} from 'lucide-react'
import type { DriveInfo } from '@shared/types/common'
import type { PerformanceSnapshot } from '@shared/types/performance'
import { formatPercent } from '@shared/format'
import { useNav } from '../../lib/nav'
import { Button, Card } from '../ui'
import { systemDrive, usedPercent } from './insights'

const REASONS: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Recycle, title: 'O lixo volta', text: 'Temporários e caches são recriados em poucos dias. Limpar libera espaço, mas não acelera.' },
  { icon: Rocket, title: 'Programas na inicialização', text: 'Cada um consome memória e processador desde que o Windows liga.' },
  { icon: HardDrive, title: 'Disco do sistema cheio', text: 'Com menos de 10–15% livre, falta espaço para memória virtual e atualizações.' },
  { icon: MemoryStick, title: 'RAM no limite', text: 'Quando a memória acaba, o Windows usa o disco, que é muito mais lento.' },
  { icon: Puzzle, title: 'Drivers desatualizados', text: 'Principalmente vídeo e chipset: afetam jogos, travadas e estabilidade.' },
  { icon: Thermometer, title: 'Aquecimento', text: 'Poeira e pasta térmica velha fazem o processador reduzir a velocidade.' },
  { icon: Snail, title: 'Jogos e programas no HDD', text: 'HDD é muitas vezes mais lento que SSD: carregamentos demoram e o jogo engasga.' }
]

function personalTips(snapshot: PerformanceSnapshot | null, drives: DriveInfo[] | null): string[] {
  const tips: string[] = []
  const sys = systemDrive(drives?.length ? drives : snapshot?.drives)
  if (sys && usedPercent(sys) >= 85) tips.push(`o disco ${sys.letter} está ${formatPercent(usedPercent(sys))} cheio`)
  if (snapshot) {
    const startup = (snapshot.startupItems ?? []).filter((s) => s.enabled).length
    if (startup >= 8) tips.push(`${startup} programas abrem junto com o Windows`)
    const mem = snapshot.memory
    if (mem?.totalBytes > 0 && mem.usedBytes / mem.totalBytes >= 0.8) tips.push(`a memória RAM estava ${formatPercent((mem.usedBytes / mem.totalBytes) * 100)} ocupada`)
    if (snapshot.security?.multipleAntivirus) tips.push('há mais de um antivírus ativo')
    if (snapshot.pendingReboot) tips.push('o Windows está esperando reiniciar')
  }
  const hdd = (drives ?? []).find((d) => d.mediaType === 'HDD')
  if (hdd && tips.length < 3) tips.push(`a unidade ${hdd.letter} é HDD (lenta para jogos)`)
  return tips.slice(0, 3)
}

export function WhySlowCard({ snapshot, drives }: { snapshot: PerformanceSnapshot | null; drives: DriveInfo[] | null }) {
  const { go } = useNav()
  const [open, setOpen] = useState(false)
  const tips = personalTips(snapshot, drives)
  const shown = open ? REASONS : REASONS.slice(0, 4)

  return (
    <Card title="Por que apagar arquivos não resolveu a lentidão?" icon={Lightbulb}>
      <p className="text-[13px] text-muted">
        Apagar arquivos libera espaço, mas quase nunca deixa o PC mais rápido — a não ser que o disco do sistema esteja quase cheio. O que pesa
        de verdade costuma ser:
      </p>
      <ul className="mt-3 grid gap-x-5 gap-y-2.5 sm:grid-cols-2">
        {shown.map((r) => (
          <li key={r.title} className="flex items-start gap-2.5">
            <r.icon className="mt-0.5 size-4 shrink-0 text-accent" />
            <p className="text-[13px] leading-snug">
              <b className="font-semibold">{r.title}.</b> <span className="text-muted">{r.text}</span>
            </p>
          </li>
        ))}
      </ul>
      <button
        onClick={() => setOpen((x) => !x)}
        className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
        aria-expanded={open}
      >
        {open ? 'Mostrar menos' : `Ver mais ${REASONS.length - 4} motivos`}
        <ChevronDown className={clsx('size-3.5 transition-transform', open && 'rotate-180')} />
      </button>

      <div className="mt-3 flex flex-col gap-3 rounded-lg border border-accent/25 bg-accent/5 p-3 sm:flex-row sm:items-center">
        <p className="flex-1 text-[13px]">
          {tips.length > 0 ? (
            <>
              <b>No seu PC:</b> {tips.join('; ')}. Comece por aí.
            </>
          ) : (
            <>O diagnóstico de Desempenho mostra quais desses pontos acontecem no seu PC, em ordem de impacto.</>
          )}
        </p>
        <Button size="sm" onClick={() => go('performance')}>
          Ver diagnóstico <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </Card>
  )
}
