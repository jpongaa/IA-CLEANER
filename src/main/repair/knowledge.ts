// Conhecimento usado para explicar os erros em PT-BR simples: códigos de tela azul, códigos do Windows Update.

export type CrashCause = 'driver' | 'ram' | 'gpu' | 'hardware' | 'disk' | 'system' | 'unknown'

export interface BugcheckInfo {
  name: string
  cause: CrashCause
  /** PT-BR curto */
  hint: string
}

const BUGCHECKS: Record<number, BugcheckInfo> = {
  0x0a: { name: 'IRQL_NOT_LESS_OR_EQUAL', cause: 'driver', hint: 'driver com defeito (às vezes memória RAM instável)' },
  0x19: { name: 'BAD_POOL_HEADER', cause: 'driver', hint: 'driver ou memória RAM' },
  0x1a: { name: 'MEMORY_MANAGEMENT', cause: 'ram', hint: 'memória RAM instável (XMP/overclock) ou com defeito' },
  0x1e: { name: 'KMODE_EXCEPTION_NOT_HANDLED', cause: 'driver', hint: 'driver com defeito' },
  0x3b: { name: 'SYSTEM_SERVICE_EXCEPTION', cause: 'driver', hint: 'driver ou arquivos do Windows corrompidos' },
  0x4e: { name: 'PFN_LIST_CORRUPT', cause: 'ram', hint: 'memória RAM' },
  0x50: { name: 'PAGE_FAULT_IN_NONPAGED_AREA', cause: 'ram', hint: 'memória RAM, driver ou disco' },
  0x77: { name: 'KERNEL_STACK_INPAGE_ERROR', cause: 'disk', hint: 'disco/cabo com problema' },
  0x7a: { name: 'KERNEL_DATA_INPAGE_ERROR', cause: 'disk', hint: 'disco/cabo com problema (ou RAM)' },
  0x7e: { name: 'SYSTEM_THREAD_EXCEPTION_NOT_HANDLED', cause: 'driver', hint: 'driver com defeito' },
  0x7f: { name: 'UNEXPECTED_KERNEL_MODE_TRAP', cause: 'hardware', hint: 'hardware instável (overclock, temperatura, RAM)' },
  0x9f: { name: 'DRIVER_POWER_STATE_FAILURE', cause: 'driver', hint: 'driver que não lida bem com suspensão/energia' },
  0xc2: { name: 'BAD_POOL_CALLER', cause: 'driver', hint: 'driver com defeito' },
  0xc5: { name: 'DRIVER_CORRUPTED_EXPOOL', cause: 'driver', hint: 'driver com defeito' },
  0xd1: { name: 'DRIVER_IRQL_NOT_LESS_OR_EQUAL', cause: 'driver', hint: 'driver com defeito (muito comum: rede/Wi-Fi, áudio, antivírus)' },
  0xef: { name: 'CRITICAL_PROCESS_DIED', cause: 'system', hint: 'processo vital do Windows morreu (arquivos corrompidos ou disco)' },
  0xf4: { name: 'CRITICAL_OBJECT_TERMINATION', cause: 'disk', hint: 'disco/cabo com problema' },
  0x101: { name: 'CLOCK_WATCHDOG_TIMEOUT', cause: 'hardware', hint: 'processador instável (overclock/undervolt, BIOS)' },
  0x109: { name: 'CRITICAL_STRUCTURE_CORRUPTION', cause: 'driver', hint: 'driver ou memória RAM' },
  0x116: { name: 'VIDEO_TDR_FAILURE', cause: 'gpu', hint: 'driver/placa de vídeo travou' },
  0x117: { name: 'VIDEO_TDR_TIMEOUT_DETECTED', cause: 'gpu', hint: 'driver/placa de vídeo travou' },
  0x119: { name: 'VIDEO_SCHEDULER_INTERNAL_ERROR', cause: 'gpu', hint: 'driver de vídeo' },
  0x124: { name: 'WHEA_UNCORRECTABLE_ERROR', cause: 'hardware', hint: 'erro de hardware (overclock, tensão, temperatura, RAM ou processador)' },
  0x127: { name: 'PAGE_NOT_ZERO', cause: 'ram', hint: 'memória RAM' },
  0x12b: { name: 'FAULTY_HARDWARE_CORRUPTED_PAGE', cause: 'ram', hint: 'memória RAM' },
  0x133: { name: 'DPC_WATCHDOG_VIOLATION', cause: 'driver', hint: 'driver lento (muito comum: SSD/controlador de disco ou firmware)' },
  0x139: { name: 'KERNEL_SECURITY_CHECK_FAILURE', cause: 'driver', hint: 'driver ou memória RAM' },
  0x13a: { name: 'KERNEL_MODE_HEAP_CORRUPTION', cause: 'driver', hint: 'driver com defeito' },
  0x141: { name: 'VIDEO_ENGINE_TIMEOUT_DETECTED', cause: 'gpu', hint: 'placa de vídeo travou' },
  0x154: { name: 'UNEXPECTED_STORE_EXCEPTION', cause: 'disk', hint: 'disco/SSD ou antivírus' },
  0x1e0: { name: 'ATTEMPTED_SWITCH_FROM_DPC', cause: 'driver', hint: 'driver com defeito' }
}

export function bugcheckInfo(code: number): BugcheckInfo {
  return BUGCHECKS[code] ?? { name: `0x${code.toString(16).toUpperCase()}`, cause: 'unknown', hint: 'causa não catalogada (veja o Monitor de Confiabilidade)' }
}

/** "0x0000009f (0x..., ...)" ou "159" -> número do código. */
export function parseBugcheck(text: string | number | undefined | null): number | undefined {
  if (typeof text === 'number') return Number.isFinite(text) && text > 0 ? text : undefined
  if (!text) return undefined
  const m = /0x([0-9a-f]{1,8})/i.exec(text)
  if (m) {
    const n = parseInt(m[1], 16)
    return n > 0 ? n : undefined
  }
  const d = /^\s*(\d+)\s*$/.exec(text)
  return d && Number(d[1]) > 0 ? Number(d[1]) : undefined
}

export const CAUSE_STEPS: Record<CrashCause, string[]> = {
  driver: [
    'Atualize os drivers pela página Drivers (principalmente vídeo, chipset da placa-mãe, rede/Wi-Fi e áudio) — sempre do site oficial do fabricante.',
    'Desinstale programas que instalam drivers próprios e que você não usa (antivírus antigos, utilitários de RGB/overclock, emuladores, VPNs).',
    'Se começou depois de instalar algo, use a Restauração do Sistema para voltar a um ponto anterior.'
  ],
  ram: [
    'Se você ativou XMP/DOCP/EXPO ou overclock na memória, desative na BIOS e teste por alguns dias.',
    'Rode o Diagnóstico de Memória do Windows (botão abaixo; o PC reinicia para testar).',
    'Se o erro continuar, teste um pente de memória por vez para achar o defeituoso.'
  ],
  gpu: [
    'Instale o driver de vídeo mais recente do site da NVIDIA/AMD/Intel (opção de instalação limpa).',
    'Desative overclock/undervolt da placa de vídeo (MSI Afterburner etc.) e confira a temperatura na página Hardware.',
    'Confira se os cabos de energia PCIe da placa de vídeo estão bem encaixados e se a fonte tem potência suficiente.'
  ],
  hardware: [
    'Desative qualquer overclock/undervolt de processador e memória (inclusive XMP/DOCP) e teste.',
    'Atualize a BIOS e o driver de chipset da placa-mãe (site do fabricante).',
    'Confira temperaturas na página Hardware; limpe poeira e verifique a pasta térmica se estiver muito quente.'
  ],
  disk: [
    'Rode a verificação completa (com administrador) para checar o disco e o sistema de arquivos.',
    'Confira o cabo SATA/encaixe do SSD e atualize o firmware do SSD (site do fabricante).',
    'Faça backup dos seus arquivos importantes enquanto investiga.'
  ],
  system: ['Use "Reparar arquivos do Windows" (SFC/DISM) nesta página.', 'Confira a saúde do disco (verificação completa).'],
  unknown: ['Abra o Monitor de Confiabilidade para ver o histórico detalhado de cada falha.']
}

// ---------------------------------------------------------------- Windows Update

export interface WuCodeInfo {
  /** PT-BR curto */
  text: string
  /** Indica componentes do Windows corrompidos (DISM/SFC ajudam) */
  corruption?: boolean
  /** Pode ser corrupção, mas tem outras causas comuns (oferece DISM/SFC sem afirmar que há corrupção) */
  maybeCorruption?: boolean
  /** Indica cache do Windows Update corrompido (resetar o WU ajuda) */
  cache?: boolean
  /** Problema de conexão */
  network?: boolean
  /** Espaço em disco */
  space?: boolean
}

const WU_CODES: Record<string, WuCodeInfo> = {
  '0x800F0922': {
    text: 'a instalação de componentes falhou — costuma ser falta de espaço na partição reservada do sistema/EFI, VPN/firewall bloqueando o servidor, ou componentes do Windows danificados',
    maybeCorruption: true,
    space: true
  },
  '0x800F081F': { text: 'arquivos de origem não encontrados — componentes do Windows danificados', corruption: true },
  '0x80073712': { text: 'o repositório de componentes do Windows está danificado', corruption: true },
  '0x800F0831': { text: 'falta um pacote anterior — componentes do Windows danificados', corruption: true },
  '0x800F0900': { text: 'erro interno do repositório de componentes', corruption: true },
  '0x800F0988': { text: 'falha na limpeza de componentes', corruption: true },
  '0x800F0984': { text: 'componente danificado', corruption: true },
  '0x80070570': { text: 'arquivo corrompido ou ilegível', corruption: true },
  '0x8007000D': { text: 'dados da atualização inválidos (cache corrompido)', cache: true },
  '0x80070002': { text: 'arquivos da atualização sumiram (cache do Windows Update corrompido)', cache: true },
  '0x80070003': { text: 'pasta da atualização não encontrada (cache do Windows Update corrompido)', cache: true },
  '0x80240034': { text: 'o download da atualização falhou (conexão instável ou cache do Windows Update corrompido)', cache: true, network: true },
  '0x80246007': { text: 'o download não terminou (BITS/cache)', cache: true },
  '0x80246008': { text: 'falha no serviço de download (BITS)', cache: true },
  '0x80248007': { text: 'dados do Windows Update inconsistentes', cache: true },
  '0x8024A105': { text: 'o agente de atualização falhou ao baixar', cache: true },
  '0x8024402C': { text: 'não conseguiu falar com o servidor (proxy/DNS/firewall)', network: true },
  '0x8024401C': { text: 'tempo esgotado falando com o servidor', network: true },
  '0x80244022': { text: 'o servidor de atualização recusou a conexão (temporário)', network: true },
  '0x80072EFD': { text: 'sem conexão com o servidor de atualização', network: true },
  '0x80072EE2': { text: 'tempo esgotado na conexão com o servidor', network: true },
  '0x80072F8F': { text: 'erro de certificado — muitas vezes o RELÓGIO do PC está errado', network: true },
  '0x80070070': { text: 'espaço insuficiente em disco', space: true },
  '0x80070643': { text: 'erro genérico de instalação (comum em .NET, firmware ou WinRE)' },
  '0x800705B4': { text: 'tempo esgotado durante a instalação' },
  '0x80070005': { text: 'acesso negado (antivírus de terceiros ou permissões alteradas)' },
  '0x80070BC9': { text: 'há um reinício pendente bloqueando a instalação' },
  '0x80240017': { text: 'a atualização não se aplica a este PC' },
  '0x8024200B': { text: 'falha durante a instalação; reiniciar e tentar de novo costuma resolver', cache: true },
  '0x80242016': { text: 'a instalação foi interrompida (reinício/desligamento no meio)' },
  '0xC1900101': { text: 'falha de driver durante a atualização de versão do Windows' }
}

export function wuCodeInfo(hr: string): WuCodeInfo {
  return WU_CODES[hr.toUpperCase().replace(/^0X/, '0x')] ?? { text: 'código sem explicação catalogada' }
}
