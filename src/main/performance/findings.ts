// Regras locais (sem IA) que transformam a coleta em "motivos da lentidão", em PT-BR, + nota de saúde 0..100.
import type { Severity } from '@shared/types/common'
import type { HardwareInfo } from '@shared/types/hardware'
import type { OptimizationAction, PerfCategory, PerfFinding, PerformanceSnapshot, ProcessInfo } from '@shared/types/performance'
import type { CollectExtras } from './collect'
import { OPTIMIZER_RE } from './startupMeta'
import { laptopHibernationWarning, pagefileText } from './actions'
import { GB, gbText, joinPt, pct, plural, POWER, dateBr } from './util'

type Base = Omit<PerformanceSnapshot, 'findings' | 'score' | 'actions'>

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
const WEIGHT: Record<Severity, number> = { critical: 0.25, high: 0.12, medium: 0.06, low: 0.02, info: 0 }
const CATEGORY_RANK: PerfCategory[] = ['disk', 'memory', 'startup', 'cpu', 'power', 'thermal', 'security', 'system', 'services', 'gaming', 'drivers', 'updates', 'network']

/** Processos que são do próprio app ou do sistema e não devem virar "vilões". */
const OWN_OR_SYSTEM = /^(iacleaner-scanner\.exe|ia cleaner\.exe|electron\.exe|system|registry|secure system|memory compression|idle)$/i
const BROWSER = /opera|chrome|msedge|firefox|brave|vivaldi/i

export type GpuPowerBrake = NonNullable<CollectExtras['gpuPowerBrake']>

/**
 * Lê da análise de HARDWARE salva se alguma placa de vídeo acusou "freio de energia" (fonte/placa-mãe avisando que
 * não consegue entregar energia): GpuInfo.nvidia.throttleSeconds.powerBrake ou o destaque 'gpu-power-brake'.
 * Somente leitura; null se não houve freio (ou não há análise de hardware).
 */
export function gpuPowerBrakeFrom(hw: HardwareInfo | null | undefined): GpuPowerBrake | null {
  if (!hw) return null
  const gpus = Array.isArray(hw.gpus) ? hw.gpus : []
  const withBrake = gpus.filter((g) => (g.nvidia?.throttleSeconds?.powerBrake ?? 0) >= 1)
  if (withBrake.length) {
    const g = withBrake.reduce((a, b) => ((b.nvidia?.throttleSeconds?.powerBrake ?? 0) > (a.nvidia?.throttleSeconds?.powerBrake ?? 0) ? b : a))
    return { gpu: g.name, seconds: Math.round(g.nvidia!.throttleSeconds!.powerBrake!), checkedAt: hw.collectedAt }
  }
  const ins = (hw.insights ?? []).find((i) => /^gpu-power-brake(-\d+)?$/.test(i.id))
  if (ins) {
    const m = /-(\d+)$/.exec(ins.id)
    const g = m ? gpus.find((x) => x.nvidia?.index === Number(m[1])) : gpus.find((x) => x.nvidia) ?? gpus.find((x) => !x.isIntegrated && !x.isVirtual)
    return { gpu: g?.name ?? 'placa de vídeo', checkedAt: hw.collectedAt }
  }
  return null
}

function brakeDuration(seconds: number | undefined): string {
  if (!seconds) return ''
  if (seconds < 90) return ` por ~${seconds} s`
  if (seconds < 5400) return ` por ~${Math.round(seconds / 60)} min`
  return ` por ~${(seconds / 3600).toFixed(1).replace('.', ',')} h`
}

export function computeScore(findings: PerfFinding[]): number {
  let s = 100
  for (const f of findings) s *= 1 - WEIGHT[f.severity]
  return Math.max(0, Math.min(100, Math.round(s)))
}

export function sortFindings(list: PerfFinding[]): PerfFinding[] {
  return [...list].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || CATEGORY_RANK.indexOf(a.category) - CATEGORY_RANK.indexOf(b.category)
  )
}

const VENDORS: [RegExp, string][] = [
  [/asus|rog live|armoury/i, 'ASUS'],
  [/razer/i, 'Razer'],
  [/nvidia/i, 'NVIDIA'],
  [/logitech|logi /i, 'Logitech'],
  [/corsair/i, 'Corsair'],
  [/steelseries/i, 'SteelSeries'],
  [/micro-star|\bmsi\b/i, 'MSI'],
  [/gigabyte/i, 'Gigabyte'],
  [/adobe/i, 'Adobe'],
  [/google/i, 'Google'],
  [/realtek/i, 'Realtek'],
  [/intel/i, 'Intel'],
  [/\bamd\b|advanced micro/i, 'AMD'],
  [/valve|steam/i, 'Valve (Steam)'],
  [/epic games/i, 'Epic Games'],
  [/electronic arts|\bea\b/i, 'EA'],
  [/ubisoft/i, 'Ubisoft'],
  [/blizzard|battle/i, 'Blizzard'],
  [/gen digital|avast|avg|ccleaner|piriform|norton/i, 'Gen Digital (CCleaner/Avast)'],
  [/zoom/i, 'Zoom']
]

/** Nome curto e uniforme do fabricante ('ASUSTeK COMPUTER INC.' e 'Asustek Computer Inc.' viram 'ASUS'). */
function vendorLabel(company: string): string {
  for (const [re, label] of VENDORS) if (re.test(company)) return label
  const first = company.replace(/[.,]/g, ' ').trim().split(/\s+/)[0]
  return first || 'Outros'
}

function procLabel(p: ProcessInfo): string {
  const d = p.description && p.description.length <= 40 ? p.description : undefined
  return d ?? p.name.replace(/\.exe$/i, '')
}

export function buildFindings(s: Base, extras: CollectExtras, actions: OptimizationAction[]): PerfFinding[] {
  const out: PerfFinding[] = []
  const usable = new Set(actions.filter((a) => a.state !== 'notApplicable').map((a) => a.id))
  const pending = new Set(actions.filter((a) => a.state !== 'notApplicable' && a.state !== 'applied').map((a) => a.id))
  const ids = (...list: string[]): string[] | undefined => {
    const r = list.filter((x) => usable.has(x))
    return r.length ? r : undefined
  }
  const add = (f: PerfFinding): void => {
    out.push({ ...f, actionIds: f.actionIds?.length ? f.actionIds : undefined })
  }

  const totalRam = s.memory.totalBytes
  const hasDiscreteGpu = (s.gpus ?? []).some((g) => !g.integrated)
  const apuOnly = Boolean(s.cpu.hasIntegratedGraphics) && !hasDiscreteGpu
  const sysDrive = s.drives.find((d) => d.isSystem) ?? s.drives.find((d) => d.letter.toUpperCase() === 'C:')

  // ---------- Disco do sistema ----------
  if (sysDrive && sysDrive.totalBytes > 0) {
    const freePct = (sysDrive.freeBytes / sysDrive.totalBytes) * 100
    const isSsd = sysDrive.mediaType === 'SSD' || sysDrive.mediaType === 'SCM'
    const target = sysDrive.totalBytes * 0.15
    const hib = s.hibernation.enabled && (s.hibernation.fileBytes ?? 0) > 2 * GB
    // Notebook: desligar a hibernação não é recomendado por padrão (no máximo reduzir, com aviso da bateria crítica).
    const hibIds = hib ? (s.isLaptop ? ['hibernation-reduce'] : ['hibernation-reduce', 'hibernation-off']) : []
    const hibWarn = hib && s.isLaptop ? ` ${laptopHibernationWarning(extras.state)}` : ''
    const steps = [
      'Use a "Limpeza Inteligente" deste app para apagar com segurança temporários, caches e restos de atualizações.',
      'O que mais ocupa espaço costuma ser jogos: mova os que você joga para outro disco pelo próprio launcher (Steam: Configurações > Armazenamento > Mover; Xbox app: Gerenciar > Arquivos > Mover; EA/Ubisoft/Epic: desinstalar e instalar no outro disco).',
      'Desinstale jogos e programas que você não usa mais em "Jogos & Programas".',
      `Meta: deixar pelo menos 15% do ${sysDrive.letter} livre (≈ ${gbText(target, 0)} neste disco).`
    ]
    if (freePct < 10 || sysDrive.freeBytes < 10 * GB) {
      add({
        id: 'system-drive-almost-full',
        category: 'disk',
        severity: 'critical',
        title: `${sysDrive.letter} quase cheio: só ${gbText(sysDrive.freeBytes)} livres (${pct(freePct, 1)})`,
        detail:
          `${isSsd ? 'SSD quase cheio perde velocidade de gravação: o controlador fica sem blocos livres para trabalhar e precisa reorganizar dados a cada escrita. ' : ''}` +
          `Além disso o Windows usa o ${sysDrive.letter} para memória virtual (pagefile), atualizações, cache e arquivos temporários. Abaixo de 10% livre tudo fica mais lento, atualizações falham e jogos podem travar ao salvar. ` +
          'Por isso apagar arquivos pequenos "não resolve": o que pesa são poucos itens grandes (jogos, hibernação, restos de atualização).' +
          hibWarn,
        evidence: {
          livre: gbText(sysDrive.freeBytes),
          total: gbText(sysDrive.totalBytes, 0),
          percentualLivre: Math.round(freePct * 10) / 10,
          tipo: `${sysDrive.mediaType} ${sysDrive.busType}`.trim(),
          ...(hib ? { hiberfil: gbText(s.hibernation.fileBytes) } : {})
        },
        actionIds: ids(...hibIds, 'dism-component-cleanup', ...(pending.has('storage-sense-on') ? ['storage-sense-on'] : [])),
        manualSteps: steps
      })
    } else if (freePct < 15 || sysDrive.freeBytes < 20 * GB) {
      add({
        id: 'system-drive-low-space',
        category: 'disk',
        severity: 'high',
        title: `${sysDrive.letter} com pouco espaço: ${gbText(sysDrive.freeBytes)} livres (${pct(freePct, 1)})`,
        detail:
          'O disco do sistema está chegando no limite. Com menos de 15% livre o Windows começa a ter dificuldade com memória virtual, atualizações e arquivos temporários, e SSDs perdem desempenho de gravação.' +
          hibWarn,
        evidence: { livre: gbText(sysDrive.freeBytes), total: gbText(sysDrive.totalBytes, 0), percentualLivre: Math.round(freePct * 10) / 10 },
        actionIds: ids(...(hib ? ['hibernation-reduce'] : []), 'dism-component-cleanup', ...(pending.has('storage-sense-on') ? ['storage-sense-on'] : [])),
        manualSteps: steps
      })
    }

    if (sysDrive.mediaType === 'HDD') {
      const otherSsd = s.drives.find((d) => !d.isSystem && (d.mediaType === 'SSD' || d.mediaType === 'SCM'))
      add({
        id: 'windows-on-hdd',
        category: 'disk',
        severity: 'critical',
        title: 'O Windows está instalado num HD mecânico',
        detail:
          `O ${sysDrive.letter} (${sysDrive.physicalDiskName ?? 'HD'}) é um disco mecânico: lê ~100–150 MB/s e leva ~10 ms para cada acesso. Um SSD é de 5 a 50 vezes mais rápido. ` +
          'Esse é o maior gargalo possível — nenhuma limpeza ou otimização compensa. É o upgrade com maior efeito na velocidade do PC.',
        evidence: { disco: sysDrive.physicalDiskName ?? '', tipo: 'HDD' },
        manualSteps: [
          otherSsd
            ? `Você já tem um SSD (${otherSsd.letter}, ${gbText(otherSsd.totalBytes, 0)}): dá para migrar/instalar o Windows nele.`
            : 'Compre um SSD (SATA ou NVMe, se a placa-mãe tiver slot M.2) de pelo menos 500 GB.',
          'Clone o sistema para o SSD (ferramentas gratuitas dos fabricantes, ex.: Samsung Data Migration, Crucial Acronis) ou instale o Windows do zero nele.',
          'Use o HD antigo só para arquivos e jogos menos usados.'
        ]
      })
    } else if (isSsd) {
      add({
        id: 'ok-system-ssd',
        category: 'disk',
        severity: 'info',
        title: `Windows num ${sysDrive.busType === 'NVMe' ? 'SSD NVMe' : 'SSD'} (${sysDrive.letter})`,
        detail: 'O disco do sistema é rápido. Desde que tenha espaço livre, ele não é o gargalo.'
      })
    }
  }

  // Outros discos quase cheios
  for (const d of s.drives) {
    if (d.isSystem || d.driveType !== 'fixed' || d.totalBytes <= 0) continue
    const freePct = (d.freeBytes / d.totalBytes) * 100
    if (freePct < 5) {
      add({
        id: `drive-almost-full:${d.letter.replace(':', '')}`,
        category: 'disk',
        severity: 'low',
        title: `${d.letter} quase cheio (${pct(freePct, 1)} livre)`,
        detail: 'Não deixa o Windows lento, mas jogos instalados aqui podem falhar ao atualizar ou salvar.',
        evidence: { livre: gbText(d.freeBytes), total: gbText(d.totalBytes, 0) }
      })
    }
  }

  // ---------- Erros de disco ----------
  const diskEvents = s.eventLogIssues.filter((e) => e.kind === 'disk')
  if (diskEvents.length) {
    const total = diskEvents.reduce((a, e) => a + e.count, 0)
    const severe = diskEvents.some((e) => [7, 11, 51, 55].includes(e.eventId) || (e.eventId === 98 && /repar|repair|corromp|corrupt/i.test(e.message)))
    const disks = new Set<string>()
    for (const e of diskEvents) {
      for (const m of e.message.matchAll(/Harddisk(\d+)/gi)) {
        const n = Number(m[1])
        const drv = s.drives.filter((d) => d.physicalDiskNumber === n).map((d) => d.letter)
        disks.add(drv.length ? `${drv.join('/')} (disco ${n})` : `disco ${n}`)
      }
    }
    add({
      id: 'disk-errors',
      category: 'disk',
      severity: severe || total >= 20 ? 'critical' : total >= 5 ? 'high' : 'medium',
      title: `Erros de disco no log do Windows (${plural(total, 'ocorrência', 'ocorrências')} em 30 dias) — o disco pode estar falhando`,
      detail:
        `O Windows registrou falhas de leitura/gravação ou reinicializações do controlador${disks.size ? ` em ${joinPt([...disks])}` : ''}. ` +
        'Disco com defeito deixa o PC travando por segundos (o Windows tenta de novo várias vezes) e pode perder dados. Isso NÃO se resolve apagando arquivos.',
      evidence: Object.fromEntries(diskEvents.slice(0, 6).map((e) => [`${e.source} ${e.eventId}`, e.count])),
      manualSteps: [
        'Faça backup agora dos arquivos importantes desse disco.',
        'Verifique a saúde S.M.A.R.T. (aba Hardware deste app ou o CrystalDiskInfo).',
        'Em disco SATA: troque o cabo SATA e a porta da placa-mãe (cabo ruim causa esses erros).',
        'Atualize o firmware do SSD pelo site do fabricante. Se os erros continuarem, troque o disco.'
      ]
    })
  } else if (!s.warnings.some((w) => /eventos de disco|inicializa..o e eventos/i.test(w))) {
    add({ id: 'ok-no-disk-errors', category: 'disk', severity: 'info', title: 'Nenhum erro de disco nos últimos 30 dias', detail: 'O log do Windows não registrou falhas de leitura/gravação.' })
  }

  // ---------- Memória ----------
  if (totalRam > 0) {
    const usedPct = (s.memory.usedBytes / totalRam) * 100
    const commitPct = s.memory.commitLimitBytes > 0 ? (s.memory.commitUsedBytes / s.memory.commitLimitBytes) * 100 : 0
    const topMem = s.topProcessesByMemory.filter((p) => !OWN_OR_SYSTEM.test(p.name)).slice(0, 4)
    if (usedPct >= 85 || commitPct >= 90) {
      add({
        id: 'memory-pressure',
        category: 'memory',
        severity: usedPct >= 92 || commitPct >= 95 ? 'high' : 'medium',
        title: `Memória RAM quase toda em uso (${pct(usedPct)})`,
        detail:
          'Quando a RAM enche, o Windows passa a guardar partes dos programas no disco (memória virtual), que é muito mais lento: tudo fica travando ao alternar entre janelas e jogos engasgam. ' +
          (topMem.length ? `Quem mais usa agora: ${joinPt(topMem.map((p) => `${procLabel(p)} (${gbText(p.memoryBytes)})`))}.` : ''),
        evidence: {
          emUso: gbText(s.memory.usedBytes),
          total: gbText(totalRam, 0),
          percentual: Math.round(usedPct),
          memoriaComprometida: `${gbText(s.memory.commitUsedBytes)} de ${gbText(s.memory.commitLimitBytes)}`
        },
        manualSteps: [
          'Feche programas que não está usando (principalmente navegadores com muitas abas).',
          'Desative na aba "Inicialização" os programas que abrem sozinhos.',
          totalRam < 15 * GB ? `Com ${gbText(totalRam, 0)} de RAM, um upgrade para 16 GB (2×8 GB) faz muita diferença.` : 'Verifique na aba "Processos" se algum programa está com uso anormal.'
        ]
      })
    } else {
      add({
        id: 'ok-memory',
        category: 'memory',
        severity: 'info',
        title: `Memória com folga: ${gbText(s.memory.usedBytes)} de ${gbText(totalRam, 0)} em uso (${pct(usedPct)})`,
        detail: 'A quantidade de RAM não está limitando o PC neste momento.'
      })
    }
    if (totalRam < 7.5 * GB) {
      add({
        id: 'low-ram',
        category: 'memory',
        severity: 'high',
        title: `Pouca memória RAM instalada (${gbText(totalRam, 0)})`,
        detail: 'O Windows 11 com navegador e um jogo usa facilmente mais de 8 GB. Com pouca RAM o PC vive usando o disco como memória, o que deixa tudo lento.',
        evidence: { total: gbText(totalRam, 0) },
        manualSteps: ['Instale mais RAM: 16 GB (2 pentes de 8 GB iguais, em dual channel) é o ideal hoje para jogos.']
      })
    }
  }

  // Velocidade da RAM (XMP/EXPO)
  const cfg = s.memory.configuredMhz
  const rated = s.memory.ratedMhz
  if (cfg && rated && cfg < rated * 0.95) {
    const amd = /AMD|Ryzen/i.test(s.cpu.name)
    add({
      id: 'ram-below-rated',
      category: 'memory',
      severity: 'high',
      title: `RAM rodando abaixo da velocidade: ${cfg} MT/s de ${rated} MT/s possíveis`,
      detail:
        `Seus pentes${s.memory.modules?.[0]?.partNumber ? ` (${s.memory.modules[0].partNumber})` : ''} são vendidos para ${rated} MT/s, mas estão rodando a ${cfg} MT/s porque o perfil XMP/EXPO está desligado na BIOS (vem desligado de fábrica). ` +
        (amd ? 'Nos processadores Ryzen a velocidade da RAM também define a velocidade da comunicação interna do processador (Infinity Fabric). ' : '') +
        (apuOnly
          ? 'Como o vídeo é integrado ao processador, a placa de vídeo usa a própria RAM: memória lenta derruba diretamente o FPS nos jogos. '
          : '') +
        'É desempenho que você já pagou e não está usando — e nenhuma limpeza resolve isso.',
      evidence: { emUso: `${cfg} MT/s`, nominal: `${rated} MT/s`, partNumber: s.memory.modules?.[0]?.partNumber ?? '' },
      manualSteps: [
        'Reinicie o PC e aperte Del (ou F2) repetidamente para entrar na BIOS/UEFI.',
        'Procure o perfil de memória: ASUS "Ai Overclock Tuner" → D.O.C.P./XMP/EXPO; MSI "A-XMP"/"EXPO"; Gigabyte "Extreme Memory Profile (X.M.P.)"; ASRock "DRAM Profile"/"XMP".',
        'Escolha "Profile 1" (Perfil 1) e salve com F10.',
        `Volte aqui e analise de novo: a velocidade em uso deve mostrar ~${rated} MT/s.`,
        'Se o PC ficar instável (tela azul ou não ligar), volte na BIOS e deixe "Auto" (ou limpe a CMOS).'
      ]
    })
  } else if (cfg && rated) {
    add({
      id: 'ok-ram-speed',
      category: 'memory',
      severity: 'info',
      title: `RAM na velocidade certa: ${cfg} MT/s`,
      detail: 'O perfil XMP/EXPO está ativo (ou os pentes já rodam na velocidade nominal).'
    })
  }

  // Canais da memória
  if (s.memory.dualChannel === false) {
    const one = s.memory.modulesInstalled === 1
    add({
      id: 'single-channel-memory',
      category: 'memory',
      severity: one && apuOnly ? 'high' : 'medium',
      title: one ? 'Só um pente de RAM: memória em single channel' : 'Pentes de RAM no mesmo canal (single channel)',
      detail:
        'Com dois pentes em canais diferentes o processador lê dos dois ao mesmo tempo (dual channel), dobrando a banda de memória. Em single channel jogos perdem de 10% a 30% de FPS' +
        (apuOnly ? ', e com vídeo integrado a perda é ainda maior.' : '.'),
      evidence: { pentes: s.memory.modulesInstalled, slots: s.memory.slotsTotal ?? '?' },
      manualSteps: one
        ? ['Compre um segundo pente igual (mesma capacidade e velocidade) e instale no slot indicado no manual da placa-mãe para dual channel (geralmente A2 e B2).']
        : ['Mova os pentes para os slots de dual channel indicados no manual da placa-mãe (geralmente A2 e B2, o 2º e o 4º slot a partir do processador).']
    })
  } else if (s.memory.dualChannel === true) {
    add({ id: 'ok-dual-channel', category: 'memory', severity: 'info', title: `Memória em dual channel (${s.memory.modulesInstalled} pentes)`, detail: 'Os pentes estão em canais diferentes: banda de memória máxima.' })
  }

  // Arquivo de paginação
  const pfTotal = s.pagefile.currentBytes ?? 0
  if (s.pagefile.systemManaged === false) {
    const small = pfTotal > 0 && pfTotal < Math.max(4 * GB, totalRam * 0.25)
    const noPf = pfTotal === 0 && (s.pagefile.files?.length ?? 0) === 0
    if (small || noPf) {
      add({
        id: 'pagefile-small',
        category: 'memory',
        severity: 'medium',
        title: noPf ? 'Memória virtual (pagefile) desativada' : `Memória virtual manual e pequena (${gbText(pfTotal)})`,
        detail:
          'Sem um arquivo de paginação adequado, quando a RAM enche os programas e jogos fecham sozinhos ou travam. Deixar o Windows gerenciar é o mais seguro.',
        evidence: { configuracao: pagefileText(s.pagefile.manualSettings ?? []) },
        actionIds: ids('pagefile-system-managed')
      })
    }
    const hddLetters = new Set(s.drives.filter((d) => d.mediaType === 'HDD').map((d) => d.letter.toUpperCase()))
    const onHdd = (s.pagefile.files ?? []).filter((f) => f.drive && hddLetters.has(f.drive))
    const sysIsSsd = sysDrive && (sysDrive.mediaType === 'SSD' || sysDrive.mediaType === 'SCM')
    if (onHdd.length && sysIsSsd) {
      add({
        id: 'pagefile-on-hdd',
        category: 'memory',
        severity: 'low',
        title: `Parte da memória virtual está no HD mecânico (${onHdd.map((f) => f.drive).join(', ')})`,
        detail:
          'O Windows divide a paginação entre os arquivos configurados. A parte que fica no HD é bem mais lenta que no SSD e pode causar engasgos quando a RAM enche. Com bastante RAM o efeito é pequeno.',
        evidence: { arquivos: (s.pagefile.files ?? []).map((f) => `${f.path} (${gbText(f.allocatedBytes)})`).join('; ') },
        actionIds: ids('pagefile-system-managed')
      })
    }
  }

  // ---------- Inicialização ----------
  const enabled = s.startupItems.filter((i) => i.enabled)
  const heavy = enabled.filter((i) => i.impact === 'high' && !i.essential)
  const medium = enabled.filter((i) => i.impact === 'medium' && !i.essential)
  const n = enabled.filter((i) => !i.essential).length
  let startupSev: Severity | null = null
  if (n > 20) startupSev = 'high'
  else if (n > 10) startupSev = 'medium'
  else if (heavy.length >= 3) startupSev = 'medium'
  else if (heavy.length >= 1) startupSev = 'low'
  if (startupSev) {
    add({
      id: 'startup-too-many',
      category: 'startup',
      severity: startupSev,
      title:
        heavy.length && n <= 10
          ? `${plural(heavy.length, 'programa pesado abre', 'programas pesados abrem')} junto com o Windows`
          : `${enabled.length} programas abrem junto com o Windows`,
      detail:
        'Cada programa da inicialização disputa disco e processador nos primeiros minutos e continua ocupando memória o dia todo, mesmo sem você usar. ' +
        (heavy.length ? `Os mais pesados: ${joinPt(heavy.map((i) => i.name))}. ` : '') +
        (medium.length ? `Também: ${joinPt(medium.map((i) => i.name), 5)}.` : ''),
      evidence: { ativos: enabled.length, pesados: heavy.length, total: s.startupItems.length },
      startupIds: [...heavy, ...medium].map((i) => i.id),
      manualSteps: [
        'Na aba "Inicialização" abaixo, desative o que você não precisa logo ao ligar o PC.',
        'Launchers de jogos (Steam, Epic, EA, Battle.net...) abrem sozinhos quando você clica no jogo: não precisam iniciar com o Windows.',
        'Desativar não desinstala nada e pode ser revertido a qualquer momento.'
      ]
    })
  } else {
    add({ id: 'ok-startup', category: 'startup', severity: 'info', title: `Inicialização enxuta (${plural(n, 'item ativo', 'itens ativos')})`, detail: 'Poucos programas abrem junto com o Windows.' })
  }

  // ---------- Serviços de terceiros ----------
  const third = s.services.nonMicrosoft
  if (third.length > 15) {
    const byCompany = new Map<string, number>()
    for (const sv of third) {
      const key = vendorLabel(sv.company ?? sv.displayName)
      byCompany.set(key, (byCompany.get(key) ?? 0) + 1)
    }
    const top = [...byCompany.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    add({
      id: 'many-third-party-services',
      category: 'services',
      severity: third.length > 25 ? 'medium' : 'low',
      title: `${third.length} serviços de outros fabricantes rodando em segundo plano`,
      detail:
        'Serviços ficam carregados o tempo todo, mesmo sem nenhuma janela aberta, e vários acordam a cada poucos segundos (atualizações, RGB, telemetria). ' +
        `Os que mais aparecem: ${joinPt(top.map(([c, k]) => `${c} (${k})`))}. Softwares de periféricos (ASUS Armoury Crate, Razer Synapse, Logitech...) costumam ser os mais pesados.`,
      evidence: { naoMicrosoft: third.length, emExecucao: s.services.running },
      manualSteps: [
        'Desinstale em "Jogos & Programas" os programas que você não usa (o serviço sai junto).',
        'Não desative serviços manualmente pelo services.msc: é fácil quebrar algo. Desinstalar é o caminho seguro.'
      ]
    })
  }

  // Programas "otimizadores"
  const optimizerNames = new Set<string>()
  for (const sv of third) if (OPTIMIZER_RE.test(`${sv.displayName} ${sv.company ?? ''} ${sv.path ?? ''}`)) optimizerNames.add(sv.displayName)
  for (const it of enabled) if (OPTIMIZER_RE.test(`${it.name} ${it.command} ${it.publisher ?? ''}`)) optimizerNames.add(it.name)
  for (const p of s.topProcessesByMemory) if (OPTIMIZER_RE.test(`${p.name} ${p.description ?? ''}`)) optimizerNames.add(procLabel(p))
  if (optimizerNames.size) {
    add({
      id: 'optimizer-software',
      category: 'services',
      severity: 'low',
      title: `Programas de "limpeza/otimização" rodando o tempo todo: ${joinPt([...optimizerNames], 3)}`,
      detail:
        'Esses programas ficam residentes, mostram alertas exagerados e não resolvem lentidão de verdade: o próprio Windows já limpa temporários e otimiza os discos. Eles mesmos ocupam memória e processador.',
      manualSteps: ['Desinstale pelo "Jogos & Programas" ou, se quiser manter, desative a inicialização e o monitoramento em segundo plano nas configurações dele.']
    })
  }

  // ---------- Processador / processos ----------
  const cpuHogs = s.topProcessesByCpu.filter((p) => !OWN_OR_SYSTEM.test(p.name) && (p.cpuPercent ?? 0) >= 25)
  for (const p of cpuHogs.slice(0, 2)) {
    add({
      id: `heavy-cpu:${p.name.toLowerCase()}`,
      category: 'cpu',
      severity: (p.cpuPercent ?? 0) >= 50 ? 'high' : 'medium',
      title: `${procLabel(p)} usando ${pct(p.cpuPercent ?? 0)} do processador`,
      detail:
        `No momento da análise, ${procLabel(p)}${p.company ? ` (${p.company})` : ''} estava consumindo boa parte do processador${(p.instances ?? 1) > 1 ? ` somando ${p.instances} processos` : ''}. ` +
        'Se isso acontece sempre, ele deixa todo o resto lento.',
      evidence: { processo: p.name, cpu: `${p.cpuPercent}%`, ...(p.path ? { caminho: p.path } : {}) },
      manualSteps: ['Se não reconhece o programa, verifique-o com o antivírus.', 'Se é algo que você usa, feche quando não precisar ou atualize-o.']
    })
  }
  if (s.cpu.loadPercent >= 85 && !cpuHogs.length) {
    add({
      id: 'cpu-high-load',
      category: 'cpu',
      severity: s.cpu.loadPercent >= 95 ? 'medium' : 'low',
      title: `Processador muito ocupado (${pct(s.cpu.loadPercent)}) no momento da análise`,
      detail:
        'Vários programas juntos estavam usando quase todo o processador durante a medição (cerca de 1,5 s). Se o PC fica lento mesmo parado, veja na aba "Processos" quem está consumindo.',
      evidence: { cargaCpu: `${s.cpu.loadPercent}%` }
    })
  }
  const memHogs = s.topProcessesByMemory.filter((p) => !OWN_OR_SYSTEM.test(p.name) && p.memoryBytes >= Math.max(3 * GB, totalRam * 0.15))
  for (const p of memHogs.slice(0, 2)) {
    const isBrowser = BROWSER.test(p.name)
    const isVm = /^vmmem/i.test(p.name)
    add({
      id: `heavy-memory:${p.name.toLowerCase()}`,
      category: 'memory',
      severity: p.memoryBytes >= totalRam * 0.3 ? 'medium' : 'low',
      title: `${procLabel(p)} está usando ${gbText(p.memoryBytes)} de RAM${(p.instances ?? 1) > 1 ? ` (${p.instances} processos)` : ''}`,
      detail: isBrowser
        ? 'Cada aba e extensão do navegador é um processo separado. Muitas abas abertas (ou extensões pesadas) consomem vários GB.'
        : isVm
          ? 'É a máquina virtual do WSL/Docker reservando memória mesmo quando você não está usando.'
          : 'Este programa está ocupando uma fatia grande da memória.',
      evidence: { processo: p.name, memoria: gbText(p.memoryBytes) },
      manualSteps: isBrowser
        ? ['Feche abas que não está usando.', 'Ative a "Economia de memória"/"suspender abas" nas configurações do navegador.', 'Remova extensões que não usa.']
        : isVm
          ? ['Feche o Docker Desktop quando não usar.', 'Limite a memória do WSL no arquivo %UserProfile%\\.wslconfig (ex.: memory=4GB).']
          : ['Feche o programa quando não precisar dele.']
    })
  }

  // ---------- Energia ----------
  const planGuid = s.powerPlan.guid.toLowerCase()
  const isSaver = planGuid === POWER.saver || /econom|saver|poupan/i.test(s.powerPlan.name)
  if (isSaver) {
    add({
      id: 'power-plan-saver',
      category: 'power',
      severity: s.isLaptop ? 'medium' : 'high',
      title: `Plano de energia "${s.powerPlan.name}" limitando o processador`,
      detail:
        'No modo economia o Windows segura a velocidade do processador para gastar menos energia: tudo responde mais devagar, principalmente jogos.' +
        (s.isLaptop ? ' Em notebook faz sentido só quando estiver na bateria.' : ''),
      evidence: { plano: s.powerPlan.name },
      actionIds: ids('power-plan-balanced', 'power-plan-high')
    })
  } else if (s.powerPlan.guid) {
    add({ id: 'ok-power-plan', category: 'power', severity: 'info', title: `Plano de energia: ${s.powerPlan.name}`, detail: 'O plano de energia não está limitando o processador.' })
  }

  // ---------- Segurança ----------
  const activeAv = s.security.activeAntivirus ?? []
  if (activeAv.length > 1) {
    add({
      id: 'multiple-antivirus',
      category: 'security',
      severity: 'high',
      title: `Mais de um antivírus ativo: ${joinPt(activeAv)}`,
      detail:
        'Dois antivírus em tempo real examinam cada arquivo duas vezes e brigam entre si: deixam o PC (e o carregamento dos jogos) bem mais lento e podem causar travamentos. Um só basta — o Microsoft Defender já é suficiente para a maioria.',
      evidence: { ativos: activeAv.join(', ') },
      manualSteps: ['Desinstale um deles em "Jogos & Programas" (use o desinstalador oficial).']
    })
  } else if (!activeAv.length && s.security.defenderRealtime === false) {
    add({
      id: 'antivirus-off',
      category: 'security',
      severity: 'high',
      title: 'Nenhuma proteção antivírus em tempo real ativa',
      detail: 'O PC está sem antivírus ativo. Além do risco, malware (como mineradores de criptomoeda) é uma causa comum de lentidão.',
      manualSteps: ['Abra "Segurança do Windows" > Proteção contra vírus e ameaças > ative a "Proteção em tempo real".']
    })
  } else if (activeAv.length === 1) {
    add({ id: 'ok-antivirus', category: 'security', severity: 'info', title: `Um antivírus ativo: ${activeAv[0]}`, detail: 'Proteção em tempo real ligada, sem conflito entre antivírus.' })
  }

  // ---------- Sistema ----------
  if (s.pendingReboot) {
    const updates = (s.pendingRebootReasons ?? []).some((r) => /update|atualiza..o de componentes/i.test(r))
    add({
      id: 'pending-reboot',
      category: 'updates',
      severity: updates ? 'medium' : 'low',
      title: 'Reinício pendente',
      detail:
        'Há instalações esperando o PC reiniciar para terminar. Enquanto isso, arquivos antigos e novos convivem e algumas atualizações ficam pela metade.',
      evidence: { motivos: (s.pendingRebootReasons ?? []).join('; ') },
      manualSteps: ['Salve seus trabalhos e use Iniciar > Energia > Reiniciar (não "Desligar").']
    })
  }
  const days = s.uptimeSeconds / 86_400
  if (days > 7) {
    add({
      id: 'long-uptime',
      category: 'system',
      severity: 'medium',
      title: `PC sem reiniciar há ${Math.floor(days)} dias`,
      detail:
        'Com o tempo, programas e drivers acumulam vazamentos de memória e processos travados. ' +
        (s.hibernation.fastStartup
          ? 'Com a "Inicialização Rápida" ligada, "Desligar" não limpa a memória: só "Reiniciar" recomeça o Windows de verdade.'
          : 'Reiniciar limpa tudo isso.'),
      evidence: { ligadoHa: `${Math.floor(days)} dias`, ultimoBoot: dateBr(s.os.lastBoot) },
      actionIds: s.hibernation.fastStartup ? ids('fast-startup-off') : undefined,
      manualSteps: ['Use Iniciar > Energia > Reiniciar pelo menos uma vez por semana.']
    })
  }
  if (s.lastBootDurationMs && s.lastBootDurationMs > 60_000) {
    add({
      id: 'slow-boot',
      category: 'startup',
      severity: s.lastBootDurationMs > 120_000 ? 'high' : 'medium',
      title: `O Windows demorou ${Math.round(s.lastBootDurationMs / 1000)} s para iniciar`,
      detail: 'O último boot medido pelo próprio Windows foi lento. Excesso de programas na inicialização e disco lento/cheio são as causas mais comuns.',
      evidence: { boot: `${Math.round(s.lastBootDurationMs / 1000)} s` }
    })
  }

  // ---------- Estabilidade (eventos) ----------
  const whea = s.eventLogIssues.filter((e) => e.kind === 'whea')
  if (whea.length) {
    const total = whea.reduce((a, e) => a + e.count, 0)
    add({
      id: 'whea-errors',
      category: 'thermal',
      severity: 'high',
      title: `Erros de hardware registrados (WHEA: ${plural(total, 'ocorrência', 'ocorrências')} em 30 dias)`,
      detail:
        'O processador/memória/PCIe relatou erros corrigidos ou fatais. Normalmente é instabilidade: overclock ou XMP agressivo, temperatura alta, fonte fraca ou BIOS desatualizada. Causa travadas e telas azuis.',
      evidence: Object.fromEntries(whea.slice(0, 4).map((e) => [`WHEA ${e.eventId}`, e.count])),
      manualSteps: [
        'Se fez overclock (CPU, GPU ou memória), volte para o padrão e veja se os erros param.',
        'Atualize a BIOS da placa-mãe pelo site do fabricante.',
        'Verifique as temperaturas (aba Hardware) e a limpeza/ventilação do gabinete.'
      ]
    })
  }
  const power = extras.unexpectedShutdowns
  if (power && power.count > 0) {
    // Kernel-Power 41 com BugcheckCode 0 = desligou "seco", sem tela azul. Se a análise de hardware também viu a
    // placa de vídeo com o "freio de energia" (fonte/placa-mãe avisando falta de energia), a FONTE é a suspeita nº 1.
    const noBug = Math.max(0, power.count - (power.withBugcheck ?? 0))
    const brake = noBug > 0 ? extras.gpuPowerBrake : null
    const psu = Boolean(brake)
    const brakeWhen = brake?.checkedAt ? ` (análise de hardware de ${dateBr(brake.checkedAt)})` : ''
    const steps = [
      'Se foi você segurando o botão porque o PC travou, isso é sinal de travamento: verifique temperaturas, drivers de vídeo e se o XMP/overclock está estável.',
      'Se cai a luz com frequência, um nobreak protege o PC e os discos.',
      'Rode a verificação de arquivos do sistema (SFC) para corrigir arquivos danificados.'
    ]
    if (psu) {
      steps.unshift(
        `Fonte (principal suspeita): confira se a potência dela é a recomendada pelo fabricante da ${brake!.gpu} e se os cabos de energia PCIe estão bem encaixados — de preferência um cabo por conector, sem adaptadores ou emendas. Se o problema continuar, teste com outra fonte (assistência técnica).`
      )
    } else if (noBug > 0 && !extras.hardwareChecked) {
      steps.push('Abra "Hardware" e analise: se a placa de vídeo mostrar "clock cortado por falta de energia", a fonte é a principal suspeita desses desligamentos.')
    }
    add({
      id: 'unexpected-shutdowns',
      category: 'thermal',
      severity: power.count >= 3 || psu ? 'high' : 'medium',
      title: `${plural(power.count, 'desligamento inesperado', 'desligamentos inesperados')} nos últimos 30 dias`,
      detail:
        'O Windows registrou que o PC desligou ou reiniciou sem passar pelo desligamento normal (Kernel-Power 41). ' +
        (power.withBugcheck
          ? `${power.withBugcheck} ${power.withBugcheck === 1 ? 'foi tela azul' : 'foram telas azuis'}. `
          : 'Nenhum registrou tela azul, o que costuma indicar queda de energia, botão de energia segurado com o PC travado, fonte fraca ou superaquecimento. ') +
        (psu
          ? `A placa de vídeo ${brake!.gpu} também acusou "freio de energia"${brakeDuration(brake!.seconds)}${brakeWhen}: a fonte ou a placa-mãe avisou que não conseguiu entregar energia. Juntando os dois sinais, a FONTE de energia é a principal suspeita desses desligamentos. `
          : '') +
        'Desligamentos bruscos podem corromper arquivos do sistema e deixar o Windows instável.',
      evidence: {
        ocorrencias: power.count,
        comTelaAzul: power.withBugcheck,
        semTelaAzul: noBug,
        ultimo: dateBr(power.last),
        ...(psu ? { freioDeEnergiaGpu: true, suspeita: 'fonte de energia' } : {})
      },
      actionIds: ids('sfc-scan'),
      manualSteps: steps
    })
  }
  const bsod = s.eventLogIssues.filter((e) => e.kind === 'bugcheck')
  if (bsod.length) {
    const total = bsod.reduce((a, e) => a + e.count, 0)
    add({
      id: 'bsod',
      category: 'thermal',
      severity: 'high',
      title: `${plural(total, 'tela azul', 'telas azuis')} nos últimos 30 dias`,
      detail: 'O Windows travou com erro grave (BSOD). Causas comuns: driver com defeito (principalmente de vídeo), memória instável (XMP), disco com problema ou superaquecimento.',
      evidence: { telasAzuis: total },
      actionIds: ids('sfc-scan'),
      manualSteps: ['Atualize o driver de vídeo e da placa-mãe (aba Drivers).', 'Se ativou o XMP/EXPO recentemente, teste voltar para "Auto".']
    })
  }
  if (!whea.length && !bsod.length && !(power && power.count)) {
    add({ id: 'ok-stability', category: 'thermal', severity: 'info', title: 'Sem telas azuis nem erros de hardware em 30 dias', detail: 'O log não mostra sinais de instabilidade de hardware.' })
  }
  const crashes = s.eventLogIssues.filter((e) => e.kind === 'appCrash' && e.count >= 10)
  for (const c of crashes.slice(0, 2)) {
    add({
      id: `app-crashes:${(c.app ?? 'app').toLowerCase()}`,
      category: 'system',
      severity: 'low',
      title: `${c.app ?? 'Um programa'} fechou com erro ${c.count} vezes em 30 dias`,
      detail: 'Travamentos repetidos do mesmo programa costumam ser versão com defeito, extensão/plugin problemático ou instalação corrompida.',
      evidence: { programa: c.app ?? '', vezes: c.count },
      manualSteps: ['Atualize o programa para a última versão.', 'Se continuar, desinstale e instale de novo (navegador: teste sem extensões).']
    })
  }

  // ---------- Jogos ----------
  if (s.gaming.gameDvrBackgroundRecording) {
    add({
      id: 'game-dvr-background',
      category: 'gaming',
      severity: 'medium',
      title: 'Gravação de jogos em segundo plano ligada',
      detail: 'O Xbox Game Bar fica gravando continuamente os últimos minutos de jogo para você poder salvar depois: isso usa a placa de vídeo e o disco o tempo todo e reduz o FPS.',
      actionIds: ids('game-dvr-off')
    })
  } else if (s.gaming.gameDvrEnabled) {
    add({
      id: 'game-dvr-enabled',
      category: 'gaming',
      severity: 'low',
      title: 'Captura de jogos do Windows (Game DVR) ativada',
      detail: 'A captura do Xbox Game Bar se conecta aos jogos para permitir gravações. Se você não grava pelo Windows (ou usa outro programa, como o da NVIDIA/AMD), pode desligar.',
      actionIds: ids('game-dvr-off')
    })
  }
  if (s.gaming.gameMode === false) {
    add({
      id: 'game-mode-off',
      category: 'gaming',
      severity: 'low',
      title: 'Modo de Jogo desativado',
      detail: 'O Modo de Jogo dá prioridade ao jogo aberto e impede o Windows Update de instalar coisas durante a partida.',
      actionIds: ids('game-mode-on')
    })
  }
  if (s.gaming.hags === false && hasDiscreteGpu) {
    add({
      id: 'hags-off',
      category: 'gaming',
      severity: 'low',
      title: 'Agendamento de GPU acelerado por hardware desligado',
      detail: 'Com placas de vídeo recentes, ligar o HAGS pode reduzir um pouco a latência e é necessário para o DLSS 3 (Frame Generation).',
      actionIds: ids('hags-on')
    })
  }

  // Hibernação grande + disco apertado
  const hibBytes = s.hibernation.fileBytes ?? 0
  if (s.hibernation.enabled && hibBytes >= 4 * GB && sysDrive && sysDrive.freeBytes / sysDrive.totalBytes < 0.15) {
    add({
      id: 'hiberfil-large',
      category: 'disk',
      severity: 'medium',
      title: `Arquivo de hibernação ocupando ${gbText(hibBytes)} no ${sysDrive.letter}`,
      detail:
        'O hiberfil.sys guarda a memória quando o PC hiberna e também é usado pela "Inicialização Rápida". Ele pode ser reduzido (mantém a Inicialização Rápida, mas o PC deixa de poder hibernar) ou removido (desliga a hibernação e a Inicialização Rápida), liberando espaço imediatamente.' +
        (s.isLaptop ? ` ${laptopHibernationWarning(extras.state)}` : ''),
      evidence: { hiberfil: gbText(hibBytes), tipo: s.hibernation.type === 'reduced' ? 'reduzido' : 'completo' },
      // Notebook: não oferece "desligar" por padrão (perde a hibernação por bateria crítica e a Inicialização Rápida).
      actionIds: ids(...(s.hibernation.type !== 'reduced' ? ['hibernation-reduce'] : []), ...(s.isLaptop ? [] : ['hibernation-off']))
    })
  }

  // Efeitos visuais (só pesa em PC fraco)
  const weakPc = totalRam > 0 && (totalRam <= 8.5 * GB || s.cpu.threads <= 4)
  if (weakPc && s.visualEffects !== 'Melhor desempenho') {
    add({
      id: 'visual-effects',
      category: 'system',
      severity: 'low',
      title: 'Efeitos visuais completos num PC modesto',
      detail: 'Animações, sombras e transparência consomem um pouco de processador, vídeo e memória. Em PCs com pouca RAM ou poucos núcleos, desligar deixa as janelas mais ágeis.',
      evidence: { atual: s.visualEffects ?? '' },
      actionIds: ids('visual-effects-performance')
    })
  }

  // HD fragmentado (nunca SSD)
  for (const d of s.drives.filter((x) => x.mediaType === 'HDD')) {
    const f = s.fragmentation?.find((x) => x.letter.toUpperCase() === d.letter.toUpperCase())
    if (f && f.percent >= 10) {
      add({
        id: `hdd-fragmented:${d.letter.replace(':', '')}`,
        category: 'disk',
        severity: f.percent >= 20 ? 'medium' : 'low',
        title: `HD ${d.letter} fragmentado (${f.percent}%)`,
        detail: 'Em HD mecânico, arquivos espalhados em pedaços obrigam a agulha a pular de um lado para o outro: jogos e programas instalados nele carregam mais devagar. (SSD não precisa e não deve ser desfragmentado.)',
        evidence: { fragmentacao: `${f.percent}%`, ultimaAnalise: dateBr(f.lastRun) },
        actionIds: ids(`optimize-drive:${d.letter.replace(':', '')}`)
      })
    }
  }
  if (extras.scheduledOptimize === false) {
    add({
      id: 'scheduled-optimize-off',
      category: 'disk',
      severity: 'low',
      title: 'Otimização automática de unidades desligada',
      detail: 'O Windows deveria rodar semanalmente o TRIM nos SSDs e a desfragmentação nos HDs. Desligada, os discos perdem desempenho com o tempo.',
      manualSteps: ['Iniciar > digite "Desfragmentar e Otimizar Unidades" > Alterar configurações > marque "Executar de acordo com um agendamento (semanal)".']
    })
  }

  // TRIM
  const hasSsd = s.drives.some((d) => d.mediaType === 'SSD' || d.mediaType === 'SCM')
  if (hasSsd && s.trim?.ntfsEnabled === false) {
    add({
      id: 'trim-disabled',
      category: 'disk',
      severity: 'high',
      title: 'TRIM desativado para os SSDs',
      detail: 'Sem TRIM, o SSD não sabe quais blocos estão livres: cada gravação fica mais lenta com o tempo e o desgaste aumenta.',
      actionIds: ids('trim-enable')
    })
  } else if (hasSsd && s.trim?.ntfsEnabled) {
    add({ id: 'ok-trim', category: 'disk', severity: 'info', title: 'TRIM ativado nos SSDs', detail: 'Os SSDs recebem o aviso de blocos livres e mantêm a velocidade de gravação.' })
  }

  // Contadores de desempenho
  if (s.perfCountersOk === false) {
    const pol = s.perfCountersDisabled
    const byPolicy = Boolean(pol && (pol.global || pol.libraries.length))
    const where = pol ? [...(pol.global ? ['global (Perflib)'] : []), ...pol.libraries].join(', ') : ''
    add({
      id: 'perf-counters-broken',
      category: 'system',
      severity: 'low',
      title: byPolicy ? 'Contadores de desempenho do Windows desligados' : 'Contadores de desempenho do Windows com defeito',
      detail: byPolicy
        ? 'Causa encontrada: os contadores estão DESLIGADOS por uma configuração do registro ("Disable Performance Counters"), algo que programas "otimizadores" costumam fazer. ' +
          'Isso não deixa o PC lento sozinho, mas faz o Monitor de Desempenho e programas de monitoramento mostrarem dados errados ou vazios. ' +
          'Só reconstruir os contadores não resolve: a correção religa essa configuração (com "desfazer"), reconstrói e confere se voltaram a funcionar.'
        : 'As classes de desempenho do WMI não existem neste PC. Isso não deixa o PC lento sozinho, mas faz o Monitor de Desempenho e programas de monitoramento mostrarem dados errados ou vazios. ' +
          'A correção reconstrói os contadores e confere se eles voltaram; se não voltarem, o app avisa (aí a causa é outra, e repetir não adianta).',
      evidence: byPolicy ? { desligadosEm: where, valor: 'Disable Performance Counters' } : undefined,
      actionIds: ids('perf-counters-rebuild')
    })
  }

  return sortFindings(out)
}
