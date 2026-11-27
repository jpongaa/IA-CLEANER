// Destaques locais (sem IA) calculados a partir do hardware coletado.
// Linguagem simples, PT-BR, explicando o porquê. Ordem: mais grave primeiro.
import type { Severity } from '@shared/types/common'
import type { HardwareInfo, HardwareInsight } from '@shared/types/hardware'
import { formatBytes, formatDate, formatRelative } from '@shared/format'

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
const GB = 1024 ** 3
const DAY = 86_400_000

/** 'AAAA-MM-DD' -> 'DD/MM/AAAA' sem deslocamento de fuso (new Date('AAAA-MM-DD') é UTC). */
function day(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : formatDate(iso)
}

function lettersOf(disk: HardwareInfo['storage'][number]): string {
  return disk.partitions
    .map((p) => p.letter)
    .filter(Boolean)
    .join(' ')
}

/** 75 -> '1 min', 4000 -> '1 h 7 min', 20 -> '20 s' */
function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins} min`
  return `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}`
}

/** O processador suporta Resizable BAR? (AMD Zen 2+ / Intel 10ª geração+). undefined = não reconhecido. */
function cpuSupportsRebar(info: HardwareInfo): boolean | undefined {
  const arch = info.cpu.microarchitecture
  if (!arch) return undefined
  const old = ['Zen', 'Zen+', 'Core', 'Nehalem', 'Westmere', 'Sandy Bridge', 'Ivy Bridge', 'Haswell', 'Broadwell', 'Skylake', 'Kaby Lake', 'Coffee Lake', 'Whiskey Lake', 'Cannon Lake']
  return !old.includes(arch)
}

/** Destaques de placas NVIDIA a partir do nvidia-smi (limites de energia, PCIe, Resizable BAR, tempo limitado). */
function nvidiaInsights(info: HardwareInfo, g: HardwareInfo['gpus'][number], add: (i: HardwareInsight) => void): void {
  const nv = g.nvidia
  if (!nv) return
  const short = g.name.replace(/^NVIDIA\s+/i, '')
  const laptop = info.system.isLaptop
  const id = (base: string): string => (nv.index > 0 ? `${base}-${nv.index}` : base)

  // Limite de energia reduzido por algum programa (em notebook o limite varia com o modo de energia: ignora)
  if (!laptop && nv.powerLimitW && nv.powerDefaultLimitW && nv.powerLimitW < nv.powerDefaultLimitW * 0.95 - 1) {
    add({
      id: id('gpu-power-limit-low'),
      area: 'gpu',
      severity: 'medium',
      title: `Limite de energia da placa de vídeo reduzido (${Math.round(nv.powerLimitW)} W de ${Math.round(nv.powerDefaultLimitW)} W)`,
      detail: `${short}: algum programa (MSI Afterburner, software do fabricante, modo silencioso) baixou o limite de consumo. Em jogos pesados a placa perde clock e FPS para respeitar esse limite.`,
      tip: 'Se você não reduziu de propósito (para gastar menos energia ou fazer menos barulho), volte o "Power Limit" para 100% no mesmo programa.'
    })
  }

  // Menos linhas PCIe do que a placa suporta (segundo slot, riser, placa mal encaixada)
  if (!laptop && nv.pcieWidthCurrent && nv.pcieWidthMax && nv.pcieWidthCurrent < nv.pcieWidthMax) {
    const narrow = nv.pcieWidthCurrent <= 4
    add({
      id: id('gpu-pcie-width'),
      area: 'gpu',
      severity: narrow ? 'medium' : 'low',
      title: `Placa de vídeo usando só x${nv.pcieWidthCurrent} linhas PCIe (ela suporta x${nv.pcieWidthMax})`,
      detail: narrow
        ? 'Com x4 ou x1 a comunicação com o processador fica estreita e jogos perdem bastante FPS e têm travadas. Acontece quando a placa está no segundo slot, num extensor (riser) ou mal encaixada.'
        : 'Em x8 a perda em jogos é pequena (poucos %), mas costuma indicar a placa no slot errado ou linhas divididas com um SSD M.2.',
      tip: 'Com o PC desligado, confira se a placa está no slot PCIe de cima (o mais perto do processador) e bem encaixada. Em algumas placas-mãe, usar certos slots M.2 divide as linhas — veja o manual.'
    })
  }

  // Geração PCIe limitada pela plataforma (ex.: placa PCIe 4.0 num processador PCIe 3.0)
  if (nv.pcieGenGpuMax && nv.pcieGenSystemMax && nv.pcieGenSystemMax < nv.pcieGenGpuMax) {
    const x8 = (nv.pcieWidthMax ?? 16) <= 8
    add({
      id: id('gpu-pcie-gen'),
      area: 'gpu',
      severity: x8 ? 'low' : 'info',
      title: `Placa de vídeo em PCIe ${nv.pcieGenSystemMax}.0 (ela suporta ${nv.pcieGenGpuMax}.0)`,
      detail: x8
        ? `O processador/placa-mãe só oferece PCIe ${nv.pcieGenSystemMax}.0 e a ${short} usa só 8 linhas: a perda em jogos fica em torno de 2% a 5%, maior quando a VRAM enche.`
        : `O processador/placa-mãe só oferece PCIe ${nv.pcieGenSystemMax}.0. Com 16 linhas a diferença em jogos fica abaixo de ~2% — nada a fazer.`
    })
  }

  // Resizable BAR
  const rebarGpu = /RTX\s*(30|40|50)\d{2}|RTX\s*A\d{3,4}|RTX\s*PRO|RTX\s*\d{4}\s*Ada/i.test(g.name)
  const rebarCpu = cpuSupportsRebar(info)
  if (nv.resizableBar === false && rebarGpu && rebarCpu !== false) {
    const vendor = info.motherboard.manufacturer.replace(/ COMPUTER INC\.?| Co\.?,? ?Ltd\.?| Technology.*$/i, '').trim()
    add({
      id: id('gpu-rebar-off'),
      area: 'gpu',
      severity: 'low',
      title: 'Resizable BAR desligado',
      detail: `A ${short} suporta Resizable BAR (o processador acessa toda a memória de vídeo de uma vez), mas ele está desligado. Ganho realista: de 0 a ~10% de FPS só nos jogos que a NVIDIA habilita; nos outros, nada muda.${rebarCpu === undefined ? ' Exige processador e placa-mãe compatíveis.' : ''}`,
      tip:
        info.bios.mode === 'Legacy'
          ? 'Exige o Windows em modo UEFI e o seu está em Legacy: não vale a pena mudar só por isso.'
          : `Na BIOS, ative "Above 4G Decoding" e "Re-Size BAR Support" (em placas AMD pode se chamar "Smart Access Memory"). Se a opção não existir, só uma atualização de BIOS pelo site oficial${vendor ? ` da ${vendor}` : ''} traz. Para desfazer, desligue as mesmas opções.`
    })
  } else if (nv.resizableBar === true) {
    add({
      id: id('gpu-rebar-on'),
      area: 'gpu',
      severity: 'info',
      title: 'Resizable BAR ativo',
      detail: 'O processador acessa toda a memória de vídeo de uma vez; a NVIDIA usa isso nos jogos em que ajuda.'
    })
  }

  // Tempo com clock reduzido desde que o driver carregou (normalmente desde que o PC ligou)
  const ts = nv.throttleSeconds
  if (ts?.powerBrake && ts.powerBrake >= 1) {
    add({
      id: id('gpu-power-brake'),
      area: 'gpu',
      severity: 'high',
      title: 'A placa de vídeo teve o clock cortado por falta de energia',
      detail: `Desde que o PC ligou, a ${short} ficou ~${duration(ts.powerBrake)} com o "freio de energia" acionado: a fonte ou a placa-mãe avisou que não está conseguindo entregar energia. Isso também pode causar desligamentos e reinícios sozinhos em jogos.`,
      tip: 'Confira se a fonte tem a potência recomendada pelo fabricante da placa e se os cabos de energia PCIe estão bem encaixados (de preferência um cabo por conector, sem adaptadores ou emendas).'
    })
  }
  const hot = (ts?.thermal ?? 0) + (ts?.hwThermal ?? 0)
  if (hot >= 60) {
    add({
      id: id('gpu-thermal-history'),
      area: 'gpu',
      severity: (ts?.hwThermal ?? 0) >= 10 ? 'high' : 'medium',
      title: `A placa de vídeo já reduziu o clock por calor (~${duration(hot)} desde que o PC ligou)`,
      detail: `O driver registrou a ${short} acima da temperatura máxima de operação${nv.maxOperatingTempC ? ` (${nv.maxOperatingTempC} °C)` : ''}: ela se protege baixando o clock, o que derruba o FPS e causa travadas.`,
      tip: 'Limpe a poeira das ventoinhas e do gabinete, deixe espaço para o ar entrar e sair e confira se as ventoinhas da placa giram. Placas com alguns anos podem precisar de troca da pasta/almofadas térmicas (serviço técnico).'
    })
  }
}

export function buildInsights(info: HardwareInfo, now = Date.now()): HardwareInsight[] {
  const out: HardwareInsight[] = []
  const add = (i: HardwareInsight): void => {
    out.push(i)
  }
  const isAmd = info.cpu.vendor === 'AMD'

  // ---------------- Memória ----------------
  const mem = info.memory
  const mods = mem.modules
  if (mods.length > 0) {
    const configured = Math.min(...mods.map((m) => m.configuredMhz ?? m.speedMhz ?? Infinity))
    const rated = Math.max(...mods.map((m) => Math.max(m.speedMhz ?? 0, m.advertisedMhz ?? 0)))
    const fromPart = mods.some((m) => m.advertisedMhz && m.advertisedMhz === rated)
    if (Number.isFinite(configured) && rated > 0 && configured + 100 < rated) {
      add({
        id: 'ram-below-rated',
        area: 'memory',
        severity: 'medium',
        title: `RAM rodando a ${configured} MT/s, mas os pentes suportam ${rated} MT/s`,
        detail:
          (fromPart ? `O código dos pentes (${mods[0].partNumber}) indica ${rated} MT/s. ` : '') +
          'O perfil de velocidade da memória (XMP/DOCP/EXPO) está desligado na BIOS, então a RAM roda na velocidade padrão. ' +
          (isAmd ? 'Em processadores Ryzen isso custa FPS em jogos, porque a velocidade da RAM também acelera a comunicação interna do processador.' : 'Em jogos isso pode custar alguns FPS.'),
        tip: `Entre na BIOS (tecla Del ou F2 ao ligar) e ative o perfil ${isAmd ? 'DOCP/EXPO (nome usado em placas AMD)' : 'XMP'}. Se o PC ficar instável, desative de novo. Só funciona se a placa-mãe e o processador suportarem essa velocidade.`
      })
    } else if (Number.isFinite(configured) && configured >= 2933 && rated > 0) {
      add({
        id: 'ram-speed-ok',
        area: 'memory',
        severity: 'info',
        title: `RAM na velocidade máxima dos pentes (${configured} MT/s)`,
        detail: 'O perfil de velocidade (XMP/DOCP/EXPO) já está ativo. Nada a fazer aqui.'
      })
    }

    const ch = mem.channelsGuess ?? ''
    if (mods.length === 1) {
      add({
        id: 'ram-single-channel',
        area: 'memory',
        severity: 'medium',
        title: 'Só 1 pente de RAM (single channel)',
        detail:
          'Com um único pente a memória trabalha com metade da largura de banda. Em jogos isso costuma custar de 10% a 30% de FPS — e bem mais com vídeo integrado.',
        tip: 'Use 2 pentes iguais (ex.: 2×8 GB em vez de 1×16 GB) nos slots indicados no manual da placa (geralmente A2 e B2).'
      })
    } else if (ch.startsWith('Single channel')) {
      add({
        id: 'ram-same-channel',
        area: 'memory',
        severity: 'medium',
        title: 'Os pentes de RAM parecem estar no mesmo canal',
        detail: `Slots usados: ${mods.map((m) => m.slot).join(', ')}. Assim a memória não roda em dual channel e perde desempenho.`,
        tip: 'Confira no manual da placa-mãe quais slots formam dual channel (geralmente A2 e B2) e mude os pentes de lugar com o PC desligado.'
      })
    } else if (ch.startsWith('Dual') || ch.startsWith('Quad')) {
      add({
        id: 'ram-multi-channel-ok',
        area: 'memory',
        severity: 'info',
        title: `Memória em ${ch.replace(' (provável)', '').toLowerCase()}`,
        detail: `${mods.length} pentes instalados${ch.includes('provável') ? ' (o Windows não informa o canal; deduzido pela quantidade de pentes)' : ''}.`
      })
    }

    const parts = new Set(mods.map((m) => `${m.capacityBytes}|${m.partNumber ?? ''}|${m.speedMhz ?? ''}`))
    if (parts.size > 1) {
      add({
        id: 'ram-mixed-modules',
        area: 'memory',
        severity: 'low',
        title: 'Pentes de RAM diferentes misturados',
        detail: 'Pentes de modelos/capacidades diferentes funcionam, mas todos rodam na velocidade do mais lento e podem causar instabilidade com XMP/EXPO.'
      })
    }
  }
  if (mem.totalBytes > 0 && mem.totalBytes < 7.5 * GB) {
    add({
      id: 'ram-low',
      area: 'memory',
      severity: 'high',
      title: `Pouca memória RAM (${formatBytes(mem.totalBytes, 0)})`,
      detail: 'Com menos de 8 GB o Windows usa o disco como memória o tempo todo, deixando tudo lento — principalmente jogos e navegador com muitas abas.',
      tip: 'Um upgrade para 16 GB (2×8 GB) é o que mais faz diferença nesse caso.'
    })
  } else if (mem.totalBytes > 0 && mem.totalBytes < 15 * GB) {
    add({
      id: 'ram-8gb',
      area: 'memory',
      severity: 'low',
      title: `${formatBytes(mem.totalBytes, 0)} de RAM é o mínimo para jogos atuais`,
      detail: 'Jogos recentes recomendam 16 GB. Com 8 GB, deixar navegador/Discord abertos durante o jogo pode causar travadas.'
    })
  }
  if (mem.usableBytes && mem.totalBytes - mem.usableBytes > 1 * GB) {
    add({
      id: 'ram-reserved',
      area: 'memory',
      severity: 'low',
      title: `${formatBytes(mem.totalBytes - mem.usableBytes)} da RAM estão reservados pelo hardware`,
      detail: 'Normalmente é a memória separada para o vídeo integrado do processador. O Windows não consegue usar essa parte.'
    })
  }

  // ---------------- Armazenamento ----------------
  for (const d of info.storage) {
    const letters = lettersOf(d)
    const label = letters || d.model
    const health = (d.health ?? '').toLowerCase()
    if (health && health !== 'healthy') {
      add({
        id: `disk-health-${d.number ?? d.model}`,
        area: 'storage',
        severity: 'high',
        title: `Disco ${label} com alerta de saúde (${d.health})`,
        detail: `O Windows marcou o disco ${d.model} como "${d.health}". Isso pode indicar falha próxima.`,
        tip: 'Faça backup dos arquivos importantes desse disco o quanto antes.'
      })
    }
    if (d.mediaType === 'HDD' && d.isSystemDisk) {
      add({
        id: 'disk-system-hdd',
        area: 'storage',
        severity: 'high',
        title: 'O Windows está instalado em um HD mecânico',
        detail: 'Este é um dos maiores motivos de lentidão: HDs demoram para abrir arquivos e programas. Um SSD deixa o PC várias vezes mais rápido.',
        tip: 'Migre o Windows para um SSD (mesmo um SATA barato já faz enorme diferença).'
      })
    } else if (d.mediaType === 'HDD' && letters) {
      add({
        id: `disk-hdd-${letters.replace(/[: ]/g, '')}`,
        area: 'storage',
        severity: 'low',
        title: `${letters} é um HD mecânico — lento para jogos`,
        detail: `${d.model}: HDs leem ~100–150 MB/s e demoram para achar arquivos. Jogos instalados nele carregam bem mais devagar e podem travar em mapas abertos.`,
        tip: 'Use-o para fotos, vídeos e backups; instale os jogos no SSD.'
      })
    }
    if (d.temperatureC !== undefined && d.temperatureC >= (d.mediaType === 'HDD' ? 55 : 70)) {
      add({
        id: `disk-hot-${d.number ?? d.model}`,
        area: 'storage',
        severity: 'medium',
        title: `Disco ${label} quente (${d.temperatureC} °C)`,
        detail: 'Temperatura alta reduz a vida útil e pode diminuir a velocidade (o disco se protege reduzindo o desempenho).',
        tip: 'Verifique a ventilação do gabinete; em SSD M.2, um dissipador ajuda.'
      })
    }
    if (d.wearPercent !== undefined && d.wearPercent >= 50) {
      add({
        id: `disk-wear-${d.number ?? d.model}`,
        area: 'storage',
        severity: d.wearPercent >= 80 ? 'high' : 'low',
        title: `SSD ${label} com ${d.wearPercent}% de desgaste`,
        detail: 'SSDs têm um limite de gravações. Acima de 80% é hora de planejar a troca.',
        tip: 'Mantenha backup dos arquivos importantes.'
      })
    }
    if (d.mediaType === 'HDD' && d.powerOnHours && d.powerOnHours > 35_000) {
      add({
        id: `disk-old-${d.number ?? d.model}`,
        area: 'storage',
        severity: 'low',
        title: `HD ${label} com ${Math.round(d.powerOnHours / 8760)} anos de uso ligado`,
        detail: 'HDs com muitas horas de uso têm mais chance de falhar.',
        tip: 'Não guarde a única cópia de arquivos importantes nele.'
      })
    }
  }

  // ---------------- Vídeo ----------------
  const physicalGpus = info.gpus.filter((g) => !g.isVirtual)
  for (const g of physicalGpus) {
    if (g.basicDriver) {
      add({
        id: 'gpu-basic-driver',
        area: 'gpu',
        severity: 'high',
        title: 'Placa de vídeo sem driver do fabricante',
        detail: `"${g.name}" significa que o Windows está usando um driver genérico: jogos rodam muito mal ou nem abrem.`,
        tip: 'Instale o driver oficial (NVIDIA, AMD ou Intel) — veja a página Drivers.'
      })
      continue
    }
    if (g.driverDate) {
      const t = new Date(g.driverDate).getTime()
      if (Number.isFinite(t) && now - t > 365 * DAY) {
        add({
          id: `gpu-old-driver-${g.vendor.toLowerCase()}`,
          area: 'gpu',
          severity: 'medium',
          title: `Driver de vídeo antigo (${day(g.driverDate)}, ${formatRelative(g.driverDate, now)})`,
          detail: `${g.name}: drivers novos trazem correções e otimizações para jogos lançados recentemente.`,
          tip: `Atualize pelo app oficial (${g.vendor === 'NVIDIA' ? 'NVIDIA App' : g.vendor === 'AMD' ? 'AMD Software: Adrenalin' : g.vendor === 'Intel' ? 'Intel Driver & Support Assistant' : 'site do fabricante'}) — veja a página Drivers.`
        })
      }
    }
  }
  for (const g of physicalGpus) if (g.nvidia && !g.basicDriver) nvidiaInsights(info, g, add)
  if (physicalGpus.length > 0 && physicalGpus.every((g) => g.isIntegrated)) {
    add({
      id: 'gpu-integrated-only',
      area: 'gpu',
      severity: 'info',
      title: 'Usando apenas o vídeo integrado',
      detail:
        'O vídeo integrado usa a RAM do sistema como memória de vídeo. Para ele, RAM rápida (XMP ativo) e em dual channel faz muita diferença no FPS.'
    })
  }

  // ---------------- Monitores ----------------
  for (const m of info.displays) {
    if (m.refreshRateHz && m.maxRefreshRateHz && m.maxRefreshRateHz > m.refreshRateHz + 5) {
      add({
        id: `display-refresh-${m.name}`,
        area: 'display',
        severity: 'medium',
        title: `${m.name} está em ${m.refreshRateHz} Hz, mas suporta ${m.maxRefreshRateHz} Hz`,
        detail: 'Você está deixando de ver quadros que a placa de vídeo já consegue gerar — o jogo parece menos fluido do que poderia.',
        tip: 'Configurações > Sistema > Tela > Tela avançada > "Escolher uma taxa de atualização". Use cabo DisplayPort ou HDMI compatível.'
      })
    }
  }

  // ---------------- Rede ----------------
  const wired = info.network.filter((n) => !n.isVirtual && !n.isWifi && n.connected)
  for (const n of wired) {
    const gigabit = /gbe|gigabit|2\.5g|2\.5 ?gb|5g|10g|1000/i.test(n.description)
    if (gigabit && n.linkSpeedBps && n.linkSpeedBps < 1e9) {
      add({
        id: `net-slow-link-${n.name}`,
        area: 'network',
        severity: 'medium',
        title: `Rede cabeada conectada a só ${Math.round(n.linkSpeedBps / 1e6)} Mbps`,
        detail: `${n.description} suporta 1 Gbps ou mais, mas negociou uma velocidade menor. Quase sempre é cabo ruim/antigo ou porta do roteador.`,
        tip: 'Troque o cabo por um Cat5e/Cat6 e teste outra porta do roteador.'
      })
    }
  }
  const wifi = info.network.filter((n) => !n.isVirtual && n.isWifi && n.connected)
  if (wired.length === 0 && wifi.length > 0) {
    add({
      id: 'net-wifi-only',
      area: 'network',
      severity: 'low',
      title: 'Conectado por Wi-Fi',
      detail: 'Para jogos online, o cabo de rede dá ping mais baixo e estável (sem picos de lag).',
      tip: 'Se possível, ligue o PC ao roteador por cabo.'
    })
  }

  // ---------------- Placa-mãe / BIOS ----------------
  if (info.bios.mode === 'Legacy') {
    add({
      id: 'bios-legacy',
      area: 'board',
      severity: 'medium',
      title: 'Windows instalado em modo Legacy (BIOS antiga)',
      detail: 'O modo Legacy impede recursos como Secure Boot, exigidos por alguns jogos com anti-cheat e pelo Windows 11.'
    })
  } else if (info.bios.secureBoot === false) {
    add({
      id: 'bios-secure-boot-off',
      area: 'board',
      severity: 'low',
      title: 'Secure Boot desativado',
      detail: 'Alguns jogos com anti-cheat (ex.: Valorant, Battlefield 6, Call of Duty) exigem Secure Boot ligado. Para o resto, não muda o desempenho.',
      tip: 'Se algum jogo pedir, ative na BIOS em Boot > Secure Boot (o Windows já está em modo UEFI).'
    })
  }
  if (info.bios.releaseDate) {
    const t = new Date(info.bios.releaseDate).getTime()
    if (Number.isFinite(t) && now - t > 3 * 365 * DAY) {
      add({
        id: 'bios-old',
        area: 'board',
        severity: 'low',
        title: `BIOS de ${new Date(t).getFullYear()} (${formatRelative(info.bios.releaseDate, now)})`,
        detail: 'Versões novas de BIOS corrigem bugs, melhoram a compatibilidade de memória e a segurança. Não é obrigatório atualizar.',
        tip: `Só atualize se tiver um motivo (instabilidade, processador novo). Use apenas o site oficial da ${info.motherboard.manufacturer} e não desligue o PC durante o processo.`
      })
    }
  }

  // ---------------- Processador / sistema ----------------
  if (info.cpu.virtualizationEnabled === false) {
    add({
      id: 'cpu-virtualization-off',
      area: 'cpu',
      severity: 'info',
      title: 'Virtualização desativada na BIOS',
      detail: 'Só faz diferença se você usa emuladores Android (BlueStacks etc.), WSL ou máquinas virtuais.',
      tip: `Ative ${info.cpu.vendor === 'AMD' ? 'SVM' : 'Intel VT-x'} na BIOS se precisar.`
    })
  }
  if (info.battery?.healthPercent !== undefined && info.battery.healthPercent < 70) {
    add({
      id: 'battery-worn',
      area: 'system',
      severity: 'medium',
      title: `Bateria com ${info.battery.healthPercent}% da capacidade original`,
      detail: 'Baterias desgastadas duram menos e podem fazer o notebook reduzir o desempenho fora da tomada.'
    })
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}
