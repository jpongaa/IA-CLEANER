// Rótulos e ícones do módulo Desempenho (PT-BR).
import {
  Cpu,
  Gamepad2,
  HardDrive,
  Layers,
  MemoryStick,
  Puzzle,
  RefreshCw,
  Rocket,
  Settings2,
  ShieldCheck,
  Thermometer,
  Wifi,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { OptimizationAction, PerfCategory, PerformanceSnapshot } from '@shared/types/performance'
import type { Tone } from '../ui'

export const CATEGORY: Record<PerfCategory, { label: string; icon: LucideIcon }> = {
  disk: { label: 'Disco', icon: HardDrive },
  memory: { label: 'Memória', icon: MemoryStick },
  cpu: { label: 'Processador', icon: Cpu },
  startup: { label: 'Inicialização', icon: Rocket },
  services: { label: 'Serviços', icon: Layers },
  power: { label: 'Energia', icon: Zap },
  system: { label: 'Sistema', icon: Settings2 },
  drivers: { label: 'Drivers', icon: Puzzle },
  security: { label: 'Segurança', icon: ShieldCheck },
  thermal: { label: 'Estabilidade', icon: Thermometer },
  gaming: { label: 'Jogos', icon: Gamepad2 },
  network: { label: 'Rede', icon: Wifi },
  updates: { label: 'Atualizações', icon: RefreshCw }
}

export const ACTION_STATE: Record<OptimizationAction['state'], { label: string; tone: Tone }> = {
  applied: { label: 'Aplicado', tone: 'ok' },
  notApplied: { label: 'Não aplicado', tone: 'info' },
  unknown: { label: 'Sob demanda', tone: 'neutral' },
  notApplicable: { label: 'Não se aplica', tone: 'neutral' }
}

export function scoreInfo(score: number): { label: string; tone: Tone; color: string } {
  if (score >= 80) return { label: 'Saudável', tone: 'ok', color: 'var(--color-ok)' }
  if (score >= 60) return { label: 'Bom, com ajustes', tone: 'info', color: 'var(--color-info)' }
  if (score >= 40) return { label: 'Precisa de atenção', tone: 'warn', color: 'var(--color-warn)' }
  return { label: 'Crítico', tone: 'danger', color: 'var(--color-danger)' }
}

/** Local do item de inicialização em linguagem simples. */
export const STARTUP_LOCATION: Record<string, string> = {
  'HKCU Run': 'Registro (sua conta)',
  'HKLM Run': 'Registro (todas as contas)',
  'HKLM Run (32-bit)': 'Registro 32 bits (todas as contas)',
  'Pasta Inicializar (usuário)': 'Pasta Inicializar (sua conta)',
  'Pasta Inicializar (todos)': 'Pasta Inicializar (todas as contas)',
  'Tarefa agendada': 'Tarefa agendada'
}

export function freePercent(d: { freeBytes: number; totalBytes: number }): number {
  return d.totalBytes > 0 ? (d.freeBytes / d.totalBytes) * 100 : 0
}

export function systemDrive(s: PerformanceSnapshot) {
  return s.drives.find((d) => d.isSystem) ?? s.drives.find((d) => d.letter.toUpperCase() === 'C:')
}

/** "3 dias e 4 h", "5 h 20 min" */
export function uptimeText(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d >= 1) return `${d} ${d === 1 ? 'dia' : 'dias'} e ${h % 24} h`
  if (h >= 1) return `${h} h ${m % 60} min`
  return `${m} min`
}

/** Rótulos amigáveis para as chaves de evidência dos achados. */
export const EVIDENCE_LABEL: Record<string, string> = {
  livre: 'Livre',
  total: 'Total',
  percentualLivre: '% livre',
  tipo: 'Tipo',
  hiberfil: 'hiberfil.sys',
  disco: 'Disco',
  emUso: 'Em uso',
  percentual: '% em uso',
  memoriaComprometida: 'Comprometida',
  nominal: 'Nominal',
  partNumber: 'Modelo do pente',
  pentes: 'Pentes',
  slots: 'Slots',
  configuracao: 'Configuração',
  arquivos: 'Arquivos',
  ativos: 'Ativos',
  pesados: 'Pesados',
  naoMicrosoft: 'Não-Microsoft',
  emExecucao: 'Em execução',
  processo: 'Processo',
  cpu: 'CPU',
  caminho: 'Caminho',
  memoria: 'Memória',
  cargaCpu: 'Carga',
  plano: 'Plano',
  motivos: 'Motivos',
  ligadoHa: 'Ligado há',
  ultimoBoot: 'Último boot',
  boot: 'Tempo de boot',
  ocorrencias: 'Ocorrências',
  comTelaAzul: 'Com tela azul',
  semTelaAzul: 'Sem tela azul (código 0)',
  freioDeEnergiaGpu: 'GPU com freio de energia',
  suspeita: 'Suspeita',
  ultimo: 'Último',
  telasAzuis: 'Telas azuis',
  programa: 'Programa',
  vezes: 'Vezes',
  atual: 'Atual',
  fragmentacao: 'Fragmentação',
  ultimaAnalise: 'Última análise',
  desligadosEm: 'Desligados em',
  valor: 'Valor do registro'
}
