// Rótulos, cores e regras de proteção usadas pela página de Análise de Discos.
import type { DriveInfo } from '@shared/types/common'
import type { FileCategory } from '@shared/types/disk'
import type { Tone } from '../ui'

export const CATEGORY_LABEL: Record<FileCategory, string> = {
  video: 'Vídeos',
  image: 'Imagens',
  audio: 'Áudio',
  archive: 'Compactados (zip, rar...)',
  installer: 'Instaladores',
  diskImage: 'Imagens de disco (ISO)',
  virtualDisk: 'Discos virtuais (VM/WSL)',
  document: 'Documentos',
  code: 'Código e dados de dev',
  gameData: 'Jogos',
  backup: 'Backups',
  log: 'Logs e dumps',
  temp: 'Temporários e caches',
  executable: 'Programas (exe/dll)',
  system: 'Sistema',
  other: 'Outros'
}

/** Rótulo curto (para badges em tabelas). */
export const CATEGORY_SHORT: Record<FileCategory, string> = {
  video: 'Vídeo',
  image: 'Imagem',
  audio: 'Áudio',
  archive: 'Compactado',
  installer: 'Instalador',
  diskImage: 'ISO',
  virtualDisk: 'Disco virtual',
  document: 'Documento',
  code: 'Dev',
  gameData: 'Jogo',
  backup: 'Backup',
  log: 'Log',
  temp: 'Temporário',
  executable: 'Programa',
  system: 'Sistema',
  other: 'Outro'
}

export const CATEGORY_TONE: Record<FileCategory, Tone> = {
  video: 'info',
  image: 'info',
  audio: 'info',
  archive: 'accent',
  installer: 'accent',
  diskImage: 'accent',
  virtualDisk: 'warn',
  document: 'neutral',
  code: 'neutral',
  gameData: 'ai',
  backup: 'warn',
  log: 'neutral',
  temp: 'ok',
  executable: 'neutral',
  system: 'danger',
  other: 'neutral'
}

/** Explicações curtas de extensões comuns que ocupam muito espaço. */
export const EXT_HINT: Record<string, string> = {
  '': 'Arquivos sem extensão (ex.: modelos do Ollama, bancos de dados de apps)',
  '*': 'Outras extensões',
  safetensors: 'Modelo de IA (Hugging Face / Stable Diffusion)',
  gguf: 'Modelo de IA (LM Studio / Ollama)',
  ckpt: 'Modelo de IA (checkpoint)',
  pt: 'Modelo de IA (PyTorch)',
  pth: 'Modelo de IA (PyTorch)',
  onnx: 'Modelo de IA (ONNX)',
  bin: 'Binário genérico (muitas vezes modelo de IA ou dados de jogo)',
  ucas: 'Dados de jogo (Unreal Engine)',
  utoc: 'Índice de dados de jogo (Unreal Engine)',
  pak: 'Pacote de dados de jogo',
  bundle: 'Pacote de dados de jogo (Unity)',
  assets: 'Dados de jogo (Unity)',
  vpk: 'Dados de jogo (Valve)',
  nvph: 'Cache de shaders da NVIDIA (recriado sozinho)',
  ibd: 'Banco de dados MySQL/MariaDB',
  vhdx: 'Disco virtual (WSL, Docker, Hyper-V, emuladores)',
  vhd: 'Disco virtual',
  vmdk: 'Disco virtual (VMware)',
  iso: 'Imagem de disco (instalador de SO/jogo)',
  dll: 'Bibliotecas de programas e jogos',
  exe: 'Programas',
  sys: 'Arquivos do sistema (inclui pagefile/hiberfil)',
  lib: 'Bibliotecas de desenvolvimento',
  msi: 'Instaladores (muitos ficam guardados pelo Windows em C:\\Windows\\Installer)',
  mp4: 'Vídeos (gravações de jogo costumam ser enormes)',
  mov: 'Vídeos',
  mkv: 'Vídeos',
  zip: 'Arquivos compactados',
  rar: 'Arquivos compactados',
  '7z': 'Arquivos compactados',
  pdb: 'Símbolos de depuração (dev)',
  log: 'Registros (logs)',
  etl: 'Registros de rastreamento do Windows',
  dmp: 'Despejo de memória (crash dump)',
  tmp: 'Temporários',
  esd: 'Imagem de instalação do Windows',
  wim: 'Imagem de instalação do Windows',
  edb: 'Banco de dados do Windows (ex.: Pesquisa)',
  db: 'Banco de dados de apps',
  jar: 'Pacotes Java (ex.: Minecraft)',
  whl: 'Pacotes Python'
}

/** Rampa azul sequencial (passos 450→650 da paleta validada do app): maior pasta = tom mais forte. */
export const TREEMAP_BLUES = ['#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281']
export const TREEMAP_FILES = '#3a4660'
export const TREEMAP_OTHER = '#2b344a'

export const SYSTEM_FILES = new Set(['pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'dumpstack.log', 'dumpstack.log.tmp'])

export function fileName(p: string): string {
  const i = p.lastIndexOf('\\')
  return i >= 0 ? p.slice(i + 1) : p
}

export function dirName(p: string): string {
  const i = p.lastIndexOf('\\')
  if (i <= 2) return p.slice(0, 3)
  return p.slice(0, i)
}

// Proteção (dica local + guard do backend): ver ./safety
export { protectionFor, type Protection } from './safety'

export function mediaBadges(d: DriveInfo): { label: string; tone: Tone }[] {
  const out: { label: string; tone: Tone }[] = []
  if (d.mediaType === 'SSD' || d.mediaType === 'SCM') out.push({ label: /nvme/i.test(d.busType) ? 'SSD NVMe' : 'SSD', tone: 'accent' })
  else if (d.mediaType === 'HDD') out.push({ label: 'HDD', tone: 'warn' })
  if (d.busType && !/nvme/i.test(d.busType)) out.push({ label: d.busType, tone: 'neutral' })
  if (d.isSystem) out.push({ label: 'Sistema', tone: 'info' })
  if (d.driveType === 'removable') out.push({ label: 'Removível', tone: 'neutral' })
  if (d.driveType === 'network') out.push({ label: 'Rede', tone: 'neutral' })
  return out
}

export function percentOf(part: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, (part / total) * 100)) : 0
}
