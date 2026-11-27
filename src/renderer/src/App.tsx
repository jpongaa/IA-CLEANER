import clsx from 'clsx'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import {
  Bot,
  Cpu,
  Gamepad2,
  ScanSearch,
  Wrench,
  Gauge,
  HardDrive,
  History,
  LayoutDashboard,
  Puzzle,
  Settings,
  ShieldCheck,
  Sparkles,
  type LucideIcon
} from 'lucide-react'
import { NavContext, type PageId } from './lib/nav'
import { api } from './lib/api'
import { ErrorBoundary, ToastProvider } from './components/ui'
import type { AppInfo } from '@shared/types/settings'
import { useAiStatus } from './components/ai/useAiStatus'
import DashboardPage from './pages/DashboardPage'
import DiskPage from './pages/DiskPage'
import CleanupPage from './pages/CleanupPage'
import AppsPage from './pages/AppsPage'
import DiscoverPage from './pages/DiscoverPage'
import RepairPage from './pages/RepairPage'
import PerformancePage from './pages/PerformancePage'
import HardwarePage from './pages/HardwarePage'
import DriversPage from './pages/DriversPage'
import AssistantPage from './pages/AssistantPage'
import HistoryPage from './pages/HistoryPage'
import SettingsPage from './pages/SettingsPage'

interface NavItem {
  id: PageId
  label: string
  icon: LucideIcon
  page: ComponentType
  group: 'main' | 'tools' | 'app'
}

const NAV: NavItem[] = [
  { id: 'dashboard', label: 'Painel', icon: LayoutDashboard, page: DashboardPage, group: 'main' },
  { id: 'performance', label: 'Desempenho', icon: Gauge, page: PerformancePage, group: 'main' },
  { id: 'repair', label: 'Reparar Erros', icon: Wrench, page: RepairPage, group: 'main' },
  { id: 'cleanup', label: 'Limpeza Inteligente', icon: Sparkles, page: CleanupPage, group: 'main' },
  { id: 'disk', label: 'Análise de Discos', icon: HardDrive, page: DiskPage, group: 'main' },
  { id: 'apps', label: 'Jogos & Programas', icon: Gamepad2, page: AppsPage, group: 'main' },
  { id: 'discover', label: 'Busca Profunda', icon: ScanSearch, page: DiscoverPage, group: 'main' },
  { id: 'hardware', label: 'Hardware', icon: Cpu, page: HardwarePage, group: 'tools' },
  { id: 'drivers', label: 'Drivers', icon: Puzzle, page: DriversPage, group: 'tools' },
  { id: 'assistant', label: 'Assistente IA', icon: Bot, page: AssistantPage, group: 'tools' },
  { id: 'history', label: 'Histórico', icon: History, page: HistoryPage, group: 'app' },
  { id: 'settings', label: 'Configurações', icon: Settings, page: SettingsPage, group: 'app' }
]

export default function App() {
  const [page, setPage] = useState<PageId>('dashboard')
  const [info, setInfo] = useState<AppInfo | null>(null)
  const { status: ai } = useAiStatus()
  const nav = useMemo(() => ({ page, go: setPage }), [page])

  useEffect(() => {
    api.system.getAppInfo().then(setInfo).catch(() => undefined)
  }, [])

  // A área de conteúdo é o mesmo elemento para todas as páginas: ao trocar de página, volta ao topo
  // (antes do paint, para a página nova não aparecer "no meio").
  const mainRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    mainRef.current?.scrollTo({ top: 0, left: 0 })
  }, [page])

  const currentNav = NAV.find((n) => n.id === page)
  const Current = currentNav?.page ?? DashboardPage

  return (
    <NavContext.Provider value={nav}>
      <ToastProvider>
        <div className="flex h-full flex-col">
          {/* Barra de título (arrastável) */}
          <div className="drag-region flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-4">
            <div className="grid size-5 place-items-center rounded-md bg-gradient-to-br from-ai to-accent">
              <Sparkles className="size-3 text-white" />
            </div>
            <span className="text-[13px] font-semibold tracking-wide">IA Cleaner</span>
            <span className="text-[11px] text-faint">v{info?.version ?? ''}</span>
          </div>

          <div className="flex min-h-0 flex-1">
            {/* Menu lateral */}
            <aside className="flex w-60 shrink-0 flex-col border-r border-border/60 bg-surface/40 px-3 py-4">
              {(['main', 'tools', 'app'] as const).map((group) => (
                <nav key={group} className="mb-4 space-y-0.5">
                  {group !== 'main' && (
                    <p className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-faint uppercase">
                      {group === 'tools' ? 'Ferramentas' : 'App'}
                    </p>
                  )}
                  {NAV.filter((n) => n.group === group).map((n) => (
                    <button
                      key={n.id}
                      onClick={() => setPage(n.id)}
                      className={clsx(
                        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors',
                        page === n.id ? 'bg-surface-3 text-text' : 'text-muted hover:bg-surface-2 hover:text-text'
                      )}
                    >
                      <n.icon className={clsx('size-4', page === n.id && (n.id === 'assistant' ? 'text-ai' : 'text-accent'))} />
                      {n.label}
                    </button>
                  ))}
                </nav>
              ))}

              <div className="mt-auto space-y-2 rounded-xl border border-border bg-surface-2 p-3 text-[12px]">
                <div className="flex items-center gap-2">
                  <Bot className={clsx('size-4', ai?.configured ? 'text-ai' : 'text-faint')} />
                  <span className={ai?.configured ? 'text-text' : 'text-muted'}>
                    {ai?.configured ? 'IA conectada' : 'IA não configurada'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <ShieldCheck className={clsx('size-4', info?.isAdmin ? 'text-ok' : 'text-faint')} />
                  <span className="text-muted">{info?.isAdmin ? 'Modo Administrador' : 'Modo usuário'}</span>
                </div>
              </div>
            </aside>

            {/* Conteúdo */}
            <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto">
              <div className="mx-auto max-w-[1400px] px-8 py-7">
                {/* Um erro de renderização derruba só esta tela (key: trocar de página recomeça do zero). */}
                <ErrorBoundary key={page} label={currentNav?.label}>
                  <Current />
                </ErrorBoundary>
              </div>
            </main>
          </div>
        </div>
      </ToastProvider>
    </NavContext.Provider>
  )
}
