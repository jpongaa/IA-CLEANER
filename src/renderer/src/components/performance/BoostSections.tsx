// Abas "Recursos do Windows que gastam memória" e "Atualizadores rodando o tempo todo".
import { RefreshCw, ShieldCheck } from 'lucide-react'
import type { ActionLogEntry } from '@shared/types/common'
import type { OptimizationAction, StartupItem } from '@shared/types/performance'
import { EmptyState } from '../ui'
import { OptimizationsSection } from './OptimizationsSection'
import { StartupSection } from './StartupSection'

interface CatalogProps {
  actions: OptimizationAction[]
  log: ActionLogEntry[]
  runningId: string | null
  onApply: (a: OptimizationAction) => void
  onUndone: () => void
}

export function FeaturesSection(props: CatalogProps) {
  const pending = props.actions.filter((a) => a.state === 'notApplied').length
  return (
    <OptimizationsSection
      {...props}
      intro={
        <div className="mb-3 rounded-xl border border-border bg-surface-2 p-3.5 text-[13px] text-muted">
          O Windows deixa vários recursos rodando em segundo plano sem você pedir: Widgets com notícias, pesquisa do Iniciar consultando o Bing, propaganda e
          apps promovidos, o Edge pré-carregado mesmo para quem usa outro navegador. Cada um ocupa memória e processador o dia todo.{' '}
          {pending ? (
            <b className="text-text">{pending} ainda ligados neste PC.</b>
          ) : (
            <b className="text-ok">Tudo já está ajustado neste PC.</b>
          )}{' '}
          Tudo aqui tem "Desfazer" com o valor anterior real.
        </div>
      }
    />
  )
}

const UPDATER_STARTUP_RE = /autoupdate|auto ?update|updater|update ?task|googleupdate|jusched|update ?helper|updatecheck|driverhub|driver ?hub/i

export function UpdatersSection({
  startupItems,
  onStartupChanged,
  ...props
}: CatalogProps & { startupItems: StartupItem[]; onStartupChanged: (id: string, enabled: boolean) => void }) {
  const updaterStartup = startupItems.filter((i) => UPDATER_STARTUP_RE.test(`${i.name} ${i.command}`))
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-border bg-surface-2 p-3.5 text-[13px] text-muted">
        Vários programas instalam um "atualizador" que fica como serviço <b className="text-text">Automático</b>: carrega junto com o Windows só para
        procurar versões novas. Passar para <b className="text-text">Manual</b> não impede as atualizações — o programa chama o serviço quando precisa —, só tira o
        peso do boot. A lista é curada e conservadora: serviços da Microsoft, drivers, antivírus, Steam, EA, Battle.net, Epic e anti-cheats nunca entram.
      </div>
      {props.actions.length ? (
        <OptimizationsSection {...props} intro={null} />
      ) : (
        <EmptyState icon={ShieldCheck} title="Nenhum atualizador conhecido rodando como Automático" description="Os atualizadores da lista (Google, Adobe, Mozilla, Brave, ASUS, Dropbox) não estão instalados ou já estão em Manual." />
      )}
      <div>
        <h3 className="mb-1 flex items-center gap-2 text-[14px] font-semibold">
          <RefreshCw className="size-4 text-accent" /> Atualizadores que abrem com o Windows
        </h3>
        <p className="mb-2 text-[12px] text-muted">
          Tarefas e entradas de inicialização que só procuram atualizações. Atualizador de navegador é importante para a segurança: só desative se você atualiza
          pelo menu do navegador.
        </p>
        {updaterStartup.length ? (
          <StartupSection items={updaterStartup} onChanged={onStartupChanged} />
        ) : (
          <EmptyState title="Nenhum atualizador na inicialização" className="py-6" />
        )}
      </div>
    </div>
  )
}
