// Busca Profunda — textos e ícones por tipo de achado e por ação (PT-BR simples).
import {
  BookOpen,
  Disc3,
  ExternalLink,
  FileArchive,
  FolderOpen,
  FolderX,
  Gamepad2,
  HardDriveDownload,
  Hammer,
  ListX,
  PackageOpen,
  PackageX,
  PowerOff,
  Rocket,
  Settings,
  ShieldX,
  Trash2,
  Unplug,
  type LucideIcon
} from 'lucide-react'
import type { Finding, FindingActionKind, FindingKind } from '@shared/types/discover'
import type { Tone } from '../ui'

export interface KindMeta {
  /** Nome da seção */
  label: string
  /** Nome curto (cartões-resumo, filtros) */
  short: string
  icon: LucideIcon
  /** O que é e por que pode sair (mostrado no topo da seção) */
  about: string
}

export const KIND_META: Record<FindingKind, KindMeta> = {
  gameRepack: {
    label: 'Instaladores de jogos e repacks',
    short: 'Repacks de jogos',
    icon: PackageOpen,
    about:
      'Pacotes de instalação de jogos (FitGirl, DODI, ElAmigos...) e downloads do Hydra. Se o jogo já está instalado — ou se você não quer mais o jogo —, o pacote só ocupa espaço.'
  },
  downloadedInstaller: {
    label: 'Instaladores baixados',
    short: 'Instaladores',
    icon: HardDriveDownload,
    about:
      'Arquivos de instalação (.exe, .msi) que ficaram em Downloads ou na Área de Trabalho. Depois de instalar o programa, o instalador não serve mais: se precisar, dá para baixar de novo no site oficial.'
  },
  archiveExtracted: {
    label: 'Compactados já extraídos',
    short: 'Zips já extraídos',
    icon: FileArchive,
    about: 'Arquivos .zip, .rar ou .7z cuja pasta extraída já está ao lado. É o mesmo conteúdo guardado duas vezes: apagar o compactado não mexe na pasta.'
  },
  diskImage: {
    label: 'Imagens de disco',
    short: 'Imagens (.iso)',
    icon: Disc3,
    about: 'Arquivos .iso e .img (cópias de DVD ou de instaladores). Normalmente só servem para instalar uma vez.'
  },
  orphanGame: {
    label: 'Jogos fora dos launchers',
    short: 'Jogos sem launcher',
    icon: Gamepad2,
    about:
      'Jogos instalados sem Steam, Epic, EA etc. (repacks e versões portáteis). Como nenhum launcher controla esses jogos, eles costumam ser esquecidos. Confira se ainda joga antes de remover.'
  },
  altLauncher: {
    label: 'Launchers alternativos',
    short: 'Outros launchers',
    icon: Rocket,
    about: 'Programas como Hydra, Playnite, itch.io e Heroic, e o que eles baixaram ou instalaram.'
  },
  leftoverFolder: {
    label: 'Sobras de programas desinstalados',
    short: 'Sobras',
    icon: FolderX,
    about:
      'Pastas que ficaram para trás depois que um programa ou jogo foi desinstalado. O programa não existe mais; a pasta só ocupa espaço. Antes de apagar, o app confere de novo que nada instalado usa a pasta.'
  },
  brokenUninstall: {
    label: 'Desinstaladores quebrados',
    short: 'Desinstalador quebrado',
    icon: Unplug,
    about:
      'Programas que ainda aparecem na lista do Windows, mas cujo desinstalador não existe mais — por isso o "Desinstalar" dá erro. Dá para tirar só a linha da lista (com backup) ou remover o que sobrou.'
  },
  noUninstaller: {
    label: 'Programas sem desinstalador',
    short: 'Sem desinstalador',
    icon: PackageX,
    about:
      'Programas que rodam ou abrem junto com o Windows, mas não têm desinstalador registrado. É comum em programas ruins ou que vieram "de carona" com outros.'
  },
  unwanted: {
    label: 'Programas indesejados',
    short: 'Indesejados',
    icon: ShieldX,
    about:
      'Programas conhecidos por mostrar propaganda, se instalar escondidos junto com outros ou prometer "otimizar" o PC sem necessidade. O Windows já faz isso sozinho.'
  }
}

export function kindMeta(kind: FindingKind): KindMeta {
  return KIND_META[kind] ?? { label: kind, short: kind, icon: PackageOpen, about: '' }
}

/** O que a busca procura (topo da página). */
export const SEARCH_SCOPE: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: HardDriveDownload,
    title: 'Instaladores e jogos baixados',
    text: 'Setups, repacks e .iso esquecidos em Downloads, na Área de Trabalho e nas pastas de download — e se o programa/jogo está instalado ou não.'
  },
  { icon: FileArchive, title: 'Zips já extraídos', text: 'Compactados cuja pasta extraída já está ao lado (o mesmo conteúdo duas vezes).' },
  { icon: Gamepad2, title: 'Jogos fora dos launchers', text: 'Jogos do Hydra Launcher, repacks e jogos portáteis que nenhum launcher controla.' },
  { icon: FolderX, title: 'Sobras de programas desinstalados', text: 'Pastas que ficaram em Arquivos de Programas, ProgramData e AppData.' },
  { icon: Unplug, title: 'Desinstaladores quebrados', text: 'Programas na lista do Windows cujo desinstalador sumiu.' },
  { icon: PackageX, title: 'Programas sem desinstalador', text: 'Programas que abrem com o Windows e não têm como desinstalar.' },
  { icon: ShieldX, title: 'Programas indesejados', text: 'Adware, "otimizadores", barras de navegador e afins.' }
]

export interface ActionMeta {
  icon: LucideIcon
  /** Texto padrão da confirmação quando o backend não manda confirmText */
  defaultConfirm: string
}

export const ACTION_META: Record<FindingActionKind, ActionMeta> = {
  recycle: {
    icon: Trash2,
    defaultConfirm: 'Os itens abaixo vão para a Lixeira. Se mudar de ideia, dá para restaurar pela Lixeira do Windows.'
  },
  deleteLeftovers: {
    icon: FolderX,
    defaultConfirm:
      'As pastas que sobraram vão para a Lixeira. Antes, o app confere de novo que nenhum programa instalado, serviço ou processo aberto usa essas pastas.'
  },
  runUninstaller: {
    icon: PackageX,
    defaultConfirm: 'Vamos abrir o desinstalador oficial. Siga as telas dele até o fim. Depois, faça a busca de novo para conferir se o item sumiu.'
  },
  forceRemove: {
    icon: Hammer,
    defaultConfirm:
      'Remoção forçada (avançado): use só se não existe desinstalador ou se ele não funciona. Os arquivos vão para a Lixeira e um backup do registro é salvo antes.'
  },
  removeBrokenEntry: {
    icon: ListX,
    defaultConfirm:
      'Apaga só a linha deste programa da lista de programas do Windows (o desinstalador dele não existe mais). Um backup (.reg) é salvo antes. Nenhum arquivo é apagado.'
  },
  disableStartup: {
    icon: PowerOff,
    defaultConfirm: 'O programa deixa de abrir sozinho quando o Windows liga. Ele não é desinstalado e dá para reativar depois.'
  },
  openFolder: { icon: FolderOpen, defaultConfirm: '' },
  openSettings: { icon: Settings, defaultConfirm: '' },
  openLauncher: { icon: Gamepad2, defaultConfirm: '' },
  learnMore: { icon: BookOpen, defaultConfirm: '' }
}

export function actionIcon(kind: FindingActionKind): LucideIcon {
  return ACTION_META[kind]?.icon ?? ExternalLink
}

/** Tipos em que o achado é um instalador/pacote (o "instalado" se refere ao que ele instala). */
const INSTALLER_KINDS = new Set<FindingKind>(['downloadedInstaller', 'gameRepack', 'archiveExtracted', 'diskImage'])

export function installBadge(f: Finding): { label: string; tone: Tone; title: string } | null {
  if (!f.installState) return null
  const pkg = INSTALLER_KINDS.has(f.kind)
  if (f.installState === 'installed')
    return pkg
      ? { label: 'Já instalado', tone: 'ok', title: 'O programa/jogo deste instalador já está instalado: o instalador pode sair.' }
      : { label: 'Instalado', tone: 'info', title: 'Está instalado neste PC.' }
  if (f.installState === 'notInstalled')
    return pkg
      ? { label: 'Não instalado', tone: 'warn', title: 'O programa/jogo deste instalador não está instalado (nunca foi, ou já foi desinstalado).' }
      : { label: 'Não instalado', tone: 'neutral', title: 'Não está instalado neste PC.' }
  return { label: 'Instalado?', tone: 'neutral', title: 'Não deu para saber se está instalado.' }
}

export function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/** Encurta caminhos longos no meio: C:\Users\…\Downloads\arquivo.zip */
export function shortPath(p: string, max = 70): string {
  if (p.length <= max) return p
  const parts = p.split('\\')
  if (parts.length <= 3) return p.slice(0, max - 1) + '…'
  const head = parts.slice(0, 2).join('\\')
  let tail = parts[parts.length - 1]
  for (let i = parts.length - 2; i >= 2; i--) {
    const next = parts[i] + '\\' + tail
    if (head.length + next.length + 3 > max) break
    tail = next
  }
  return `${head}\\…\\${tail}`
}
