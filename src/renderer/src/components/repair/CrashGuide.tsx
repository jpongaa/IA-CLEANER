// Passo a passo amigável para travamentos, telas azuis e desligamentos inesperados.
// Esses problemas quase nunca têm "um botão que resolve": a causa costuma ser hardware, energia, temperatura ou driver.
// Quando o backend manda passos PERSONALIZADOS (issue.manualSteps: placa de vídeo do inventário, notebook, "freio de
// energia" da página Hardware...), eles são usados; os guias fixos abaixo ficam só como reserva.
// O título/introdução do guia é escolhido pelo conteúdo do problema (id/título/evidências).
import clsx from 'clsx'
import { useState } from 'react'
import {
  ArrowRight,
  ChevronDown,
  Cpu,
  Footprints,
  Gamepad2,
  HardDrive,
  MemoryStick,
  NotebookPen,
  Plug,
  Power,
  Puzzle,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Thermometer,
  type LucideIcon
} from 'lucide-react'
import type { RepairIssue } from '@shared/types/repair'
import type { PageId } from '../../lib/nav'
import { ManualSteps } from './ManualSteps'

export type GuideAction = { kind: 'page'; page: PageId; label: string } | { kind: 'settings'; uri: string; label: string } | { kind: 'deepScan'; label: string }

interface Step {
  icon: LucideIcon
  title: string
  text: string
  action?: GuideAction
}

interface Guide {
  kind: 'shutdown' | 'bsod' | 'whea' | 'apps' | 'generic'
  title: string
  intro: string
  steps: Step[]
}

const TEMPS: Step = {
  icon: Thermometer,
  title: 'Confira a temperatura',
  text: 'Abra a tela Hardware e jogue um pouco olhando o processador e a placa de vídeo. Acima de ~90 °C no processador ou ~85 °C na placa de vídeo, limpe a poeira, confira se todas as ventoinhas giram e se o gabinete tem entrada e saída de ar.',
  action: { kind: 'page', page: 'hardware', label: 'Abrir Hardware' }
}
const MEMORY: Step = {
  icon: MemoryStick,
  title: 'Teste a memória RAM',
  text: 'Se você ativou XMP/DOCP/EXPO ou fez overclock na BIOS, teste alguns dias sem. Para testar a memória: digite “Diagnóstico de Memória do Windows” no menu Iniciar e escolha reiniciar agora (leva uns 15 min).'
}
const DRIVERS: Step = {
  icon: Puzzle,
  title: 'Atualize drivers e BIOS',
  text: 'Driver de vídeo e de chipset desatualizados são causas comuns. Em PCs com Ryzen, a BIOS da placa-mãe também faz diferença (baixe só do site do fabricante da placa).',
  action: { kind: 'page', page: 'drivers', label: 'Abrir Drivers' }
}
const SYSTEM_FILES: Step = {
  icon: ShieldAlert,
  title: 'Verifique os arquivos do Windows',
  text: 'Arquivos do sistema corrompidos também derrubam o PC. A verificação completa roda o SFC/DISM da Microsoft (só leitura) e mostra se há algo para reparar.',
  action: { kind: 'deepScan', label: 'Fazer verificação completa' }
}

const GUIDES: Record<Guide['kind'], Guide> = {
  shutdown: {
    kind: 'shutdown',
    title: 'Como descobrir a causa dos desligamentos',
    intro: 'O Windows registra quando o PC desliga ou reinicia sem passar pelo desligamento normal. Siga na ordem — da causa mais comum para a menos comum:',
    steps: [
      {
        icon: Power,
        title: 'Foi você ou a energia?',
        text: 'Segurar o botão de ligar, queda de luz, ou o filtro de linha/estabilizador desligando também geram esse registro. Se as datas batem com isso, pode ignorar. Um nobreak evita o problema.'
      },
      {
        icon: Plug,
        title: 'Fonte de energia',
        text: 'Se desliga sozinho em jogos pesados, a fonte é a principal suspeita: placas de vídeo potentes pedem uma fonte de qualidade com a potência recomendada pelo fabricante da placa. Confira se o cabo de energia da placa de vídeo está bem encaixado nos dois lados.'
      },
      TEMPS,
      MEMORY,
      DRIVERS,
      {
        icon: NotebookPen,
        title: 'Anote quando acontece',
        text: 'Jogando → fonte ou temperatura. Parado ou voltando da suspensão → drivers/energia. Em qualquer momento → memória. Para ver o histórico dia a dia, digite “Monitor de Confiabilidade” no menu Iniciar.'
      }
    ]
  },
  bsod: {
    kind: 'bsod',
    title: 'Como resolver as telas azuis',
    intro: 'Tela azul é o Windows parando para se proteger de um erro grave — quase sempre driver, memória ou arquivo do sistema. Siga na ordem:',
    steps: [
      {
        icon: NotebookPen,
        title: 'Veja o código do erro',
        text: 'O código (ex.: MEMORY_MANAGEMENT, IRQL_NOT_LESS_OR_EQUAL) aparece nas evidências acima quando o Windows o registrou. Ele indica o caminho: “MEMORY” → memória; nomes de arquivo .sys → driver.'
      },
      DRIVERS,
      MEMORY,
      SYSTEM_FILES,
      {
        icon: Sparkles,
        title: 'Programas instalados recentemente',
        text: 'Antivírus de terceiros, programas de RGB, overclock ou “otimizadores” instalam drivers próprios. Se as telas azuis começaram depois de instalar algo, desinstale para testar.',
        action: { kind: 'page', page: 'apps', label: 'Abrir Jogos & Programas' }
      },
      {
        icon: RefreshCw,
        title: 'Windows Update em dia',
        text: 'Muitas correções de telas azuis chegam por atualização do Windows.',
        action: { kind: 'settings', uri: 'ms-settings:windowsupdate', label: 'Abrir Windows Update' }
      }
    ]
  },
  whea: {
    kind: 'whea',
    title: 'O que fazer com erros de hardware (WHEA)',
    intro: 'O próprio processador avisou ao Windows que algo no hardware falhou (às vezes corrigido sozinho). Quase sempre é instabilidade de overclock, temperatura ou BIOS:',
    steps: [
      {
        icon: Cpu,
        title: 'Desfaça overclocks',
        text: 'Volte ao padrão: XMP/DOCP/EXPO da memória, PBO/Curve Optimizer do Ryzen e overclock da placa de vídeo (MSI Afterburner etc.). Se os erros pararem, o ajuste estava instável.'
      },
      DRIVERS,
      TEMPS,
      MEMORY,
      {
        icon: Footprints,
        title: 'Reencaixe as peças',
        text: 'Com o PC desligado e fora da tomada, reencaixe a memória e a placa de vídeo. Contato ruim gera erros de PCIe/memória.'
      }
    ]
  },
  apps: {
    kind: 'apps',
    title: 'Como parar os travamentos de programas',
    intro: 'Quando um programa fecha sozinho ou para de responder, a causa geralmente é do próprio programa. Se vários travam, o problema é do sistema:',
    steps: [
      {
        icon: RefreshCw,
        title: 'Atualize o programa',
        text: 'A maioria dos travamentos é corrigida em versões novas. Use o próprio “Verificar atualizações” do programa ou o site oficial.'
      },
      {
        icon: Sparkles,
        title: 'Navegadores (Opera, Chrome, Edge)',
        text: 'Desative todas as extensões e vá religando uma a uma. Se trava com vídeos, desligue “usar aceleração de hardware” nas configurações. Perfil muito grande também pesa: limpe o cache.'
      },
      {
        icon: Gamepad2,
        title: 'Reinstale se continuar',
        text: 'Desinstale pelo desinstalador oficial e instale de novo pelo site do fabricante.',
        action: { kind: 'page', page: 'apps', label: 'Abrir Jogos & Programas' }
      },
      {
        icon: HardDrive,
        title: 'Disco do sistema cheio trava tudo',
        text: 'Com o C: quase cheio, o Windows fica sem espaço para memória virtual e cache, e os programas travam. Mantenha pelo menos 10–15% livre.',
        action: { kind: 'page', page: 'cleanup', label: 'Abrir Limpeza Inteligente' }
      },
      { ...SYSTEM_FILES, title: 'Vários programas travam? Verifique o Windows' }
    ]
  },
  generic: {
    kind: 'generic',
    title: 'Passo a passo para investigar',
    intro: 'Esse tipo de problema não tem um botão que resolve. Estes passos encontram a causa na maioria dos casos:',
    steps: [DRIVERS, TEMPS, MEMORY, SYSTEM_FILES]
  }
}

/** Escolhe o guia pelo conteúdo do problema. */
export function pickGuide(issue: RepairIssue): Guide {
  // Primeiro pelo id/título (o que o problema É); as evidências podem citar outras coisas
  // (ex.: "BugcheckCode 0" num desligamento, "nenhuma tela azul junto").
  const text = `${issue.id} ${issue.title}`.toLowerCase()
  const WHEA = /whea|erros? de hardware/
  const SHUTDOWN = /kernel-?power|desligament|shutdown|unexpected|reinici(ou|os) sozinho/
  const BSOD = /bsod|bugcheck|bug check|tela azul|telas azuis|minidump|stop code|c[oó]digo de parada/
  const APPS = /app|program|aplicativo|trav|crash|hang|n[aã]o responde|parou de funcionar/
  if (WHEA.test(text)) return GUIDES.whea
  if (SHUTDOWN.test(text)) return GUIDES.shutdown
  if (BSOD.test(text)) return GUIDES.bsod
  if (APPS.test(text)) return GUIDES.apps
  const ev = issue.evidence.join(' ').toLowerCase()
  if (/whea/.test(ev)) return GUIDES.whea
  if (/kernel-?power/.test(ev)) return GUIDES.shutdown
  if (/minidump|bugcheck(code)? [1-9a-fx]/.test(ev)) return GUIDES.bsod
  return GUIDES.generic
}

export function CrashGuide({ issue, defaultOpen, onAction }: { issue: RepairIssue; defaultOpen?: boolean; onAction: (a: GuideAction) => void }) {
  const guide = pickGuide(issue)
  const custom = issue.manualSteps ?? []
  if (custom.length) return <ManualSteps crash steps={custom} title={guide.title} intro={guide.intro} defaultOpen={defaultOpen} onAction={onAction} />
  return <FixedGuide guide={guide} defaultOpen={defaultOpen} onAction={onAction} />
}

function FixedGuide({ guide, defaultOpen, onAction }: { guide: Guide; defaultOpen?: boolean; onAction: (a: GuideAction) => void }) {
  const [open, setOpen] = useState(Boolean(defaultOpen))
  return (
    <div className="mt-3 rounded-lg border border-info/25 bg-info/5">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-info">
          <Footprints className="size-4" />
          {guide.title}
          <span className="font-normal text-muted">· {guide.steps.length} passos</span>
        </span>
        <ChevronDown className={clsx('size-4 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="px-3.5 pb-3.5">
          <p className="mb-2.5 text-[13px] text-muted">{guide.intro}</p>
          <ol className="space-y-2">
            {guide.steps.map((s, i) => (
              <li key={s.title} className="flex gap-3 rounded-lg border border-border/70 bg-surface/70 p-2.5">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-info/15 text-[12px] font-semibold text-info tabular-nums">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-[13px] font-semibold">
                    <s.icon className="size-3.5 text-muted" />
                    {s.title}
                  </p>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{s.text}</p>
                </div>
                {s.action && (
                  <button
                    type="button"
                    onClick={() => onAction(s.action!)}
                    className="flex shrink-0 items-center gap-1 self-center rounded-md px-2 py-1 text-[12px] font-medium whitespace-nowrap text-accent hover:bg-surface-3"
                  >
                    {s.action.label}
                    <ArrowRight className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
