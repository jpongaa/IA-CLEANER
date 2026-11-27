// Dados fixos dos novos itens do catálogo (sem imports de outros módulos do domínio, para os scripts usarem).

/**
 * Atualizadores de terceiros que ficam como serviço "Automático" (lista curada e CONSERVADORA).
 * Só entram serviços cujo único papel é procurar atualização: de Automático para Manual, o programa continua
 * se atualizando (ele mesmo abre o serviço ou usa a tarefa agendada dele), só não fica carregado desde o boot.
 * NUNCA: serviços da Microsoft, drivers (NVIDIA/AMD/Intel/Realtek), antivírus, Steam Client Service,
 * EA/Battle.net/Epic/anti-cheats (necessários para jogar).
 */
export interface UpdaterDef {
  /** Nome do serviço (regex completa) */
  name: RegExp
  /** O executável precisa bater com isto (evita confundir com outro serviço de mesmo nome) */
  path: RegExp
  label: string
  vendor: string
  /** PT-BR: o que continua funcionando */
  keeps: string
}

export const UPDATERS: UpdaterDef[] = [
  { name: /^gupdate$/i, path: /\\Google\\Update\\GoogleUpdate\.exe/i, label: 'Google Update', vendor: 'Google', keeps: 'O Chrome e outros apps do Google continuam se atualizando pela tarefa agendada do próprio Google.' },
  { name: /^GoogleUpdaterService[\d.]*$/i, path: /\\Google\\GoogleUpdater\\/i, label: 'Google Updater', vendor: 'Google', keeps: 'O Chrome continua se atualizando pela tarefa agendada do Google e ao ser aberto.' },
  { name: /^GoogleUpdaterInternalService[\d.]*$/i, path: /\\Google\\GoogleUpdater\\/i, label: 'Google Updater (interno)', vendor: 'Google', keeps: 'O Chrome continua se atualizando pela tarefa agendada do Google e ao ser aberto.' },
  { name: /^brave$/i, path: /\\BraveSoftware\\Update\\/i, label: 'Brave Update', vendor: 'Brave', keeps: 'O Brave continua se atualizando pela tarefa agendada dele.' },
  { name: /^AdobeARMservice$/i, path: /\\Adobe\\ARM\\/i, label: 'Adobe Acrobat Update', vendor: 'Adobe', keeps: 'O Acrobat/Reader continua procurando atualização quando você o abre.' },
  { name: /^MozillaMaintenance$/i, path: /Mozilla Maintenance Service/i, label: 'Mozilla Maintenance (Firefox)', vendor: 'Mozilla', keeps: 'O Firefox continua se atualizando (ele chama o serviço quando precisa).' },
  { name: /^asus$/i, path: /\\ASUS\\Update\\AsusUpdate\.exe/i, label: 'ASUS Update', vendor: 'ASUS', keeps: 'Os apps da ASUS continuam funcionando; procure atualizações por eles quando quiser.' },
  { name: /^AsusUpdateCheck$/i, path: /AsusUpdateCheck\.exe/i, label: 'ASUS Update Check', vendor: 'ASUS', keeps: 'Só deixa de procurar atualizações de apps da ASUS desde o boot. Ventoinhas, RGB e drivers não são afetados.' },
  { name: /^dbupdate$/i, path: /\\Dropbox\\Update\\/i, label: 'Dropbox Update', vendor: 'Dropbox', keeps: 'O Dropbox continua sincronizando e se atualiza pela tarefa agendada dele.' }
]

/** Regex (PowerShell/.NET) com todos os nomes acima, para a coleta ler só esses serviços. */
export const UPDATER_NAME_PS_REGEX =
  '^(gupdate|GoogleUpdaterService[0-9.]*|GoogleUpdaterInternalService[0-9.]*|brave|AdobeARMservice|MozillaMaintenance|asus|AsusUpdateCheck|dbupdate)$'

export function updaterDefFor(name: string, path: string | null | undefined): UpdaterDef | undefined {
  return UPDATERS.find((u) => u.name.test(name) && (!path || u.path.test(path)))
}

/** Dicas, sugestões e apps promovidos (HKCU, sem admin). Valor 0 = desligado. */
export const CDM_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager'
export const CDM_VALUES = [
  'SystemPaneSuggestionsEnabled',
  'SubscribedContent-338388Enabled',
  'SubscribedContent-338389Enabled',
  'SubscribedContent-310093Enabled',
  'SubscribedContent-338393Enabled',
  'SubscribedContent-353694Enabled',
  'SubscribedContent-353696Enabled',
  'SoftLandingEnabled',
  'SilentInstalledAppsEnabled'
] as const

/** Provedores de DNS públicos aceitos pela ação 'dns-set:<primário>' (nada fora desta lista). */
export interface DnsProvider {
  id: string
  name: string
  v4: [string, string]
  v6: [string, string]
  about: string
}

export const DNS_PROVIDERS: DnsProvider[] = [
  { id: '1.1.1.1', name: 'Cloudflare', v4: ['1.1.1.1', '1.0.0.1'], v6: ['2606:4700:4700::1111', '2606:4700:4700::1001'], about: 'Foco em velocidade e privacidade.' },
  { id: '8.8.8.8', name: 'Google', v4: ['8.8.8.8', '8.8.4.4'], v6: ['2001:4860:4860::8888', '2001:4860:4860::8844'], about: 'O DNS público mais usado.' },
  { id: '9.9.9.9', name: 'Quad9', v4: ['9.9.9.9', '149.112.112.112'], v6: ['2620:fe::fe', '2620:fe::9'], about: 'Bloqueia sites de golpe e malware conhecidos.' }
]

export function dnsProvider(id: string): DnsProvider | undefined {
  return DNS_PROVIDERS.find((p) => p.id === id)
}

/** Nome amigável de um servidor DNS conhecido (ou undefined). */
export function knownDnsName(addr: string): string | undefined {
  const a = addr.toLowerCase()
  for (const p of DNS_PROVIDERS) if ([...p.v4, ...p.v6].some((x) => x.toLowerCase() === a)) return p.name
  if (/^208\.67\.22[02]\.22[02]$/.test(a)) return 'OpenDNS'
  if (/^94\.140\.1[45]\.1[45]$/.test(a)) return 'AdGuard'
  return undefined
}

/** Domínios populares no Brasil usados no teste de DNS. */
export const DNS_TEST_DOMAINS = [
  'google.com',
  'youtube.com',
  'instagram.com',
  'whatsapp.net',
  'netflix.com',
  'mercadolivre.com.br',
  'globo.com',
  'amazon.com.br',
  'steampowered.com',
  'discord.com',
  'twitch.tv',
  'microsoft.com'
]
