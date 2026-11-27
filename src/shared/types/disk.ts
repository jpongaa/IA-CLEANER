// Domínio: Análise de Discos (varredura de todos os HDs/SSDs, sem IA).
import type { DriveInfo } from './common'

export type FileCategory =
  | 'video'
  | 'image'
  | 'audio'
  | 'archive'
  | 'installer'
  | 'diskImage'
  | 'virtualDisk'
  | 'document'
  | 'code'
  | 'gameData'
  | 'backup'
  | 'log'
  | 'temp'
  | 'executable'
  | 'system'
  | 'other'

export interface DirNode {
  name: string
  path: string
  /** Soma do tamanho lógico dos arquivos (exclui arquivos só-na-nuvem). */
  bytes: number
  files: number
  dirs: number
  /** epoch ms do arquivo modificado mais recentemente dentro da pasta. */
  lastWrite?: number
  /** Filhos ordenados por bytes desc. Pode ser podado (ver otherBytes). */
  children?: DirNode[]
  /**
   * Bytes não representados em children: subpastas podadas (pequenas demais / além da profundidade)
   * + arquivos soltos diretamente nesta pasta (ver fileBytes). Sempre: bytes = Σ children.bytes + otherBytes.
   */
  otherBytes?: number
  /** Bytes dos arquivos diretamente nesta pasta (já incluídos em otherBytes). */
  fileBytes?: number
  /** Pasta (ou parte dela) sem permissão de leitura. */
  inaccessible?: boolean
}

export interface FileEntry {
  path: string
  bytes: number
  /** epoch ms */
  lastWrite: number
  /** epoch ms (pode não ser confiável: o Windows às vezes não atualiza) */
  lastAccess?: number
  ext: string
  category: FileCategory
}

export interface CategoryStat {
  category: FileCategory
  bytes: number
  files: number
}

export interface ExtensionStat {
  /** Extensão minúscula sem ponto; '' = sem extensão; '*' = outras (longas/não ASCII). */
  ext: string
  /** Categoria da extensão (sem considerar a pasta). */
  category: FileCategory
  bytes: number
  files: number
}

export interface DriveScanResult {
  root: string
  /** ISO */
  scannedAt: string
  durationMs: number
  totalBytes: number
  files: number
  dirs: number
  /** Arquivos do OneDrive etc. que estão só na nuvem (não ocupam disco). */
  cloudOnlyBytes: number
  inaccessibleDirs: number
  tree: DirNode
  topFiles: FileEntry[]
  /** Arquivos grandes sem modificação há muito tempo (>= 180 dias). */
  oldLargeFiles: FileEntry[]
  categories: CategoryStat[]
  engine: 'native' | 'node'
  error?: string
  // ---- extensões opcionais ----
  /** Quantidade de arquivos só-na-nuvem. */
  cloudOnlyFiles?: number
  /** Junctions/symlinks/montagens NÃO seguidos (evita contar em dobro). */
  skippedLinks?: number
  /** Até 40 exemplos de pastas sem permissão. */
  inaccessibleSamples?: string[]
  /** Tamanho do volume e espaço usado segundo o Windows (para comparar com o que foi encontrado). */
  volumeTotalBytes?: number
  volumeUsedBytes?: number
  threads?: number
  /** As ~40 extensões que mais ocupam espaço. */
  extensions?: ExtensionStat[]
}

export interface ScanOptions {
  /** Ex.: ['C:\\', 'D:\\'] */
  roots: string[]
  /** Padrão 300 */
  topFiles?: number
  /** Nós menores que isso são agregados em otherBytes. Padrão 64 MB */
  minNodeBytes?: number
  /** Profundidade máxima da árvore guardada. Padrão 8 */
  maxDepth?: number
}

export interface ScanResult {
  id: string
  /** ISO */
  startedAt: string
  /** ISO */
  finishedAt: string
  drives: DriveScanResult[]
  cancelled?: boolean
}

export interface ScanProgress {
  scanId: string
  root: string
  files: number
  dirs: number
  bytes: number
  currentPath: string
  elapsedMs: number
  /** Raiz concluída */
  rootDone?: boolean
}

export interface DuplicateFile {
  path: string
  lastWrite: number
}

export interface DuplicateGroup {
  hash: string
  /** Tamanho de cada cópia */
  bytes: number
  files: DuplicateFile[]
  /** bytes * (files.length - 1) */
  wastedBytes: number
}

export interface DuplicatesOptions {
  roots: string[]
  /** Padrão 10 MB */
  minBytes?: number
}

export interface DuplicatesProgress {
  phase: 'listing' | 'hashing' | 'done'
  filesConsidered: number
  hashed: number
  totalToHash: number
  currentPath?: string
  /** Na fase hashing: 'partial' = compara início/meio/fim; 'full' = confirma o conteúdo inteiro. */
  step?: 'partial' | 'full'
  bytesHashed?: number
  bytesToHash?: number
  elapsedMs?: number
}

/** Resultado salvo da última busca de duplicados. */
export interface DuplicatesReport {
  groups: DuplicateGroup[]
  roots: string[]
  minBytes: number
  /** ISO */
  finishedAt: string
  durationMs: number
  engine: 'native' | 'node'
}

/** Estado das tarefas em segundo plano (para a página retomar o progresso ao ser reaberta). */
export interface DiskStatus {
  scan: {
    running: boolean
    scanId?: string
    roots: string[]
    /** ISO */
    startedAt?: string
    /** Último progresso de cada raiz */
    progress: ScanProgress[]
  }
  duplicates: {
    running: boolean
    roots: string[]
    progress?: DuplicatesProgress
  }
  /** Helper nativo (rápido) disponível; senão usa a varredura em Node (mais lenta). */
  nativeAvailable: boolean
}

/** Opções de forgetFiles. */
export interface ForgetOptions {
  /**
   * Tamanho e tipo já conhecidos de itens apagados que NÃO estão na árvore nem nas listas da análise
   * (ex.: pasta pequena demais para o mapa, arquivo fora dos "maiores"). Sem isso, só some o que a análise conhecia.
   */
  known?: { path: string; bytes: number; kind?: 'dir' | 'file' }[]
}

/** Item grande da última análise que não existe mais no disco. */
export interface MissingScanItem {
  path: string
  /** Raiz da unidade (ex.: 'D:\\') */
  root: string
  kind: 'dir' | 'file'
  bytes: number
}

/** Conferência rápida (somente leitura) de que as maiores pastas/arquivos da última análise ainda existem. */
export interface ScanFreshness {
  /** ISO */
  checkedAt: string
  /** Quantos caminhos foram conferidos */
  checked: number
  /** Os que não existem mais (só o de cima quando uma pasta inteira sumiu), do maior para o menor. Até 50. */
  missing: MissingScanItem[]
  /** Total de itens que sumiram (pode ser maior que missing.length) */
  missingCount: number
  /** Soma dos bytes que a análise atribuía aos itens que sumiram */
  missingBytes: number
  /** Unidades da análise que não estão acessíveis agora (desconectadas): não conferidas */
  unavailableRoots: string[]
}

export interface DiskApi {
  listDrives(): Promise<DriveInfo[]>
  /** Inicia em segundo plano. Progresso em 'disk:progress', fim em 'disk:done'. */
  startScan(opts: ScanOptions): Promise<{ scanId: string }>
  cancelScan(): Promise<void>
  getLastScan(): Promise<ScanResult | null>
  /** Progresso em 'disk:dupesProgress'. */
  findDuplicates(opts: DuplicatesOptions): Promise<DuplicateGroup[]>
  cancelDuplicates(): Promise<void>
  /** Última busca de duplicados (com data/raízes), ou null. */
  getLastDuplicates(): Promise<DuplicatesReport | null>
  /** Tarefas em andamento (varredura/duplicados) e último progresso. */
  getStatus(): Promise<DiskStatus>
  /**
   * Remove dos resultados salvos (varredura e duplicados) arquivos OU PASTAS que já não existem (apagados pelo
   * usuário, jogo/programa desinstalado...). Pasta: o nó sai da árvore e o tamanho/arquivos dela são descontados
   * de todas as pastas acima, do total da unidade e dos maiores/antigos/categorias/extensões que estavam dentro
   * dela; duplicados dentro dela também saem. Não toca no disco.
   */
  forgetFiles(paths: string[], opts?: ForgetOptions): Promise<void>
  /**
   * Confere rapidamente (somente leitura, poucos segundos) se as maiores pastas e arquivos da última análise
   * ainda existem. Usado para avisar "algumas pastas não existem mais — analise de novo".
   */
  checkScanFreshness(): Promise<ScanFreshness>
}

export const DISK_METHODS = [
  'listDrives',
  'startScan',
  'cancelScan',
  'getLastScan',
  'findDuplicates',
  'cancelDuplicates',
  'getLastDuplicates',
  'getStatus',
  'forgetFiles',
  'checkScanFreshness'
] as const satisfies readonly (keyof DiskApi)[]
