// Card educativo: por que apagar arquivos quase não deixa o PC mais rápido (e o que realmente ajuda).
import { Gauge, HardDrive, Lightbulb, MemoryStick, Rocket, Thermometer, Wrench, Ban } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button, Card } from '../ui'
import { useNav } from '../../lib/nav'

const CAUSES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Rocket, title: 'Programas na inicialização', text: 'Launchers, atualizadores e apps que abrem com o Windows e ficam rodando o tempo todo.' },
  { icon: MemoryStick, title: 'Memória RAM ocupada', text: 'Navegador com muitas abas, programas em segundo plano: o Windows passa a usar o disco como memória.' },
  { icon: HardDrive, title: 'Disco do sistema cheio', text: 'Com menos de 10–15% livre no C:, o Windows e as atualizações ficam lentos.' },
  { icon: Wrench, title: 'Drivers e Windows desatualizados', text: 'Principalmente o driver de vídeo e do chipset — impactam jogos e estabilidade.' },
  { icon: Thermometer, title: 'Temperatura alta', text: 'Poeira e pasta térmica velha fazem o processador reduzir a velocidade para não esquentar.' }
]

export function WhyCleaningCard({ systemDriveFreePercent }: { systemDriveFreePercent?: number | null }) {
  const nav = useNav()
  const lowSpace = systemDriveFreePercent !== undefined && systemDriveFreePercent !== null && systemDriveFreePercent < 15
  return (
    <Card
      icon={Lightbulb}
      title="Por que limpar arquivos quase não deixa o PC mais rápido"
      subtitle="Se você já apagou muita coisa várias vezes e o PC continuou lento, este é o motivo."
      actions={
        <Button icon={Gauge} onClick={() => nav.go('performance')}>
          Ver diagnóstico de desempenho
        </Button>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_1.15fr]">
        <div className="space-y-3 text-[13px] leading-relaxed text-muted">
          <p>
            <b className="text-text">Espaço livre não é velocidade.</b> Apagar caches libera espaço, mas o processador, a memória e o disco continuam os mesmos. E
            caches existem justamente para <i>acelerar</i>: depois de apagados, os programas recriam tudo e eles voltam a crescer em poucos dias.
          </p>
          <p>
            <b className="text-text">Quando a limpeza ajuda de verdade:</b> quando o disco do sistema está quase cheio.{' '}
            {lowSpace ? (
              <span className="text-warn">
                É o seu caso: o disco do sistema está com só {systemDriveFreePercent!.toFixed(0)}% livre, então liberar espaço nele faz diferença.
              </span>
            ) : (
              'Abaixo de 10–15% livre, o Windows perde desempenho e as atualizações começam a falhar.'
            )}
          </p>
          <p className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/5 p-3 text-[12.5px]">
            <Ban className="mt-0.5 size-4 shrink-0 text-danger" />
            <span>
              <b className="text-text">Mitos que pioram o PC:</b> apagar a pasta Prefetch (o Windows fica mais lento por dias), "limpar o registro", desativar o
              arquivo de paginação ou apagar arquivos de pastas do sistema.
            </span>
          </p>
        </div>
        <div>
          <p className="mb-2 text-[12px] font-semibold tracking-wider text-muted uppercase">O que costuma deixar o PC lento</p>
          <ul className="space-y-2">
            {CAUSES.map((c) => (
              <li key={c.title} className="flex items-start gap-3 rounded-lg border border-border bg-surface-2/60 p-2.5">
                <c.icon className="mt-0.5 size-4 shrink-0 text-accent" />
                <div>
                  <p className="text-[13px] font-medium">{c.title}</p>
                  <p className="text-[12px] text-muted">{c.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  )
}
