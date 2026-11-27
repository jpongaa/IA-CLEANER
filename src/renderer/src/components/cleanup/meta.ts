// Metadados visuais da Limpeza (ícones por tipo, textos) e utilitários de seleção.
import {
  AppWindow,
  Archive,
  Bug,
  CircuitBoard,
  Clapperboard,
  CodeXml,
  Container,
  Film,
  FileClock,
  FileWarning,
  FolderDown,
  Gamepad2,
  Globe,
  HardDrive,
  Image,
  Layers,
  MonitorCog,
  Package,
  RefreshCw,
  ScrollText,
  Share2,
  Trash,
  type LucideIcon
} from 'lucide-react'
import type { CleanupKind, CleanupTarget } from '@shared/types/cleanup'
import { cleanupAppName } from '@shared/types/cleanup'
import type { Verdict } from '@shared/types/common'

export const KIND_ICON: Record<CleanupKind, LucideIcon> = {
  userTemp: FileClock,
  systemTemp: FileClock,
  browserCache: Globe,
  shaderCache: Layers,
  appCache: AppWindow,
  gameLauncherCache: Gamepad2,
  windowsUpdate: RefreshCw,
  deliveryOptimization: Share2,
  crashDumps: Bug,
  errorReports: FileWarning,
  logs: ScrollText,
  thumbnails: Image,
  recycleBin: Trash,
  windowsOld: Archive,
  installerLeftovers: Package,
  devCache: CodeXml,
  downloadsInstallers: FolderDown,
  windowsComponents: MonitorCog,
  driverStore: CircuitBoard,
  gameRecordings: Clapperboard,
  virtualDisk: Container,
  mediaCache: Film,
  other: HardDrive
}

export function kindIcon(kind: CleanupKind): LucideIcon {
  return KIND_ICON[kind] ?? HardDrive
}

export const GROUPS: { verdict: Verdict; title: string; subtitle: string }[] = [
  {
    verdict: 'safe',
    title: 'Pode apagar',
    subtitle: 'Caches e sobras que o Windows e os programas recriam sozinhos. Seguro para limpar.'
  },
  {
    verdict: 'review',
    title: 'Revisar antes',
    subtitle: 'Também dá para limpar, mas tem alguma consequência (baixar de novo, perder algo da Lixeira...). Leia antes de marcar.'
  },
  {
    verdict: 'keep',
    title: 'Manter (não apague)',
    subtitle: 'Parecem lixo e ocupam espaço, mas o Windows precisa deles. O IA Cleaner nunca limpa estes itens.'
  }
]

/** O item pode ser marcado para limpeza? */
export function isSelectable(t: CleanupTarget): boolean {
  if (t.verdict === 'keep' || t.manual) return false
  if (t.sizeUnknown) return true
  return t.bytes > 0 || t.files > 0
}

/** Nomes amigáveis dos programas abertos que bloqueiam o item. */
export function blockedNames(t: CleanupTarget): string[] {
  return [...new Set((t.blockedBy ?? []).map(cleanupAppName))]
}

/** Encurta um caminho longo: "C:\Users\x\...\Cache\Cache_Data". */
export function shortPath(p: string, keep = 3): string {
  const parts = p.split('\\')
  if (parts.length <= keep + 2) return p
  return `${parts.slice(0, 2).join('\\')}\\…\\${parts.slice(-keep).join('\\')}`
}

export function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** Item da Busca extrema executado por comando oficial (Limpeza de Disco do Windows, DISM, pnputil, Docker). */
export function isOfficialCommand(t: CleanupTarget): boolean {
  return Boolean(t.extreme) && t.method === 'command' && !t.manual
}

export type ExtremeGroupId = 'system' | 'apps' | 'personal' | 'manual'

/** Grupos da seção "Itens pesados do Windows" (Busca extrema). */
export const EXTREME_GROUPS: { id: ExtremeGroupId; title: string; subtitle: string }[] = [
  {
    id: 'system',
    title: 'Limpeza oficial do Windows',
    subtitle: 'Feita pelos próprios comandos do Windows (Limpeza de Disco, DISM, pnputil). Pede administrador e pode demorar.'
  },
  {
    id: 'apps',
    title: 'Caches pesados de programas e jogos',
    subtitle: 'Só pastas de cache e downloads incompletos: projetos, saves e configurações não são tocados.'
  },
  {
    id: 'personal',
    title: 'Seus arquivos (vão para a Lixeira)',
    subtitle: 'Gravações e vídeos que se acumulam sem você perceber. Confira antes: dá para recuperar pela Lixeira.'
  },
  {
    id: 'manual',
    title: 'Você resolve no lugar certo',
    subtitle: 'O app mostra o tamanho e leva até a tela certa do Windows ou do programa; ele não mexe nisso sozinho.'
  }
]

export function extremeGroupOf(t: CleanupTarget): ExtremeGroupId {
  if (t.manual) return 'manual'
  if (t.kind === 'gameRecordings') return 'personal'
  if (t.kind === 'windowsComponents' || t.kind === 'driverStore' || (t.method === 'command' && t.requiresAdmin)) return 'system'
  return 'apps'
}
