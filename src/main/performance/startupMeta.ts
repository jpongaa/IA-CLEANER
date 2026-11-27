// Heurística de impacto dos itens de inicialização (por editora/nome/tipo conhecido e tamanho do executável).
import type { Impact } from '@shared/types/common'

interface Rule {
  re: RegExp
  impact: Impact
  reason: string
  essential?: boolean
}

// A ordem importa: regras mais específicas primeiro.
const RULES: Rule[] = [
  {
    re: /securityhealth|windows defender|msmpeng|windows security/i,
    impact: 'low',
    essential: true,
    reason: 'Ícone da Segurança do Windows (antivírus). Recomendado manter ativado.'
  },
  {
    re: /rtkaud|realtek|nahimic|dolby|waves ?maxx|sonic studio|audio ?service/i,
    impact: 'low',
    essential: true,
    reason: 'Serviço de áudio do driver da placa-mãe. Recomendado manter para o som e o microfone funcionarem direito.'
  },
  { re: /synaptics|elantech|etd ?ctrl|touchpad/i, impact: 'low', essential: true, reason: 'Driver do touchpad. Recomendado manter.' },
  {
    re: /\bsteam(\.exe)?\b|epicgameslauncher|epic games|\beadm\b|ea ?desktop|eadesktop|\borigin\b|ubisoft|upc\.exe|uplay|battle[.․]net|galaxyclient|gog galaxy|riotclient|riot client|rockstar ?games|amazon ?games|xboxpcapp/i,
    impact: 'high',
    reason: 'Launcher de jogos: abre vários processos e procura atualizações assim que o PC liga. Ele abre sozinho quando você clicar para jogar.'
  },
  {
    re: /discord|\bteams\b|ms-teams|skype|\bslack\b|whatsapp|telegram/i,
    impact: 'high',
    reason: 'App de conversa feito com navegador embutido (Electron): costuma usar 300–600 MB de RAM só por ficar aberto.'
  },
  {
    re: /onedrive|dropbox|googledrive|google drive|icloud|megasync|box drive/i,
    impact: 'high',
    reason: 'Sincronização com a nuvem: ao ligar o PC compara e envia arquivos, usando disco e internet.'
  },
  {
    re: /bluestacks|\bnox|ldplayer|memu|docker|vmware|virtualbox/i,
    impact: 'high',
    reason: 'Emulador ou máquina virtual: reserva bastante memória e CPU em segundo plano.'
  },
  {
    re: /overwolf|wallpaper ?engine|wallpaper(32|64)|nvidia broadcast|\bmedal\b|outplayed/i,
    impact: 'high',
    reason: 'Sobreposição/efeito em segundo plano: usa a placa de vídeo e o processador o tempo todo.'
  },
  { re: /utorrent|utweb|bittorrent|qbittorrent|vuze|deluge/i, impact: 'high', reason: 'Torrent: usa disco e internet em segundo plano.' },
  {
    re: /ccleaner|avast ?cleanup|tuneup|advanced ?systemcare|iobit|driver ?booster|smart ?defrag|glary|wise ?care|razer ?cortex|norton ?utilities|pc ?optimizer/i,
    impact: 'medium',
    reason: 'Programa "otimizador": fica rodando o tempo todo e não deixa o PC mais rápido (o Windows já faz essa manutenção sozinho).'
  },
  {
    re: /autoupdate|auto ?update|updater|update ?task|jusched|java ?update|googleupdate|softlanding|selfupdate/i,
    impact: 'low',
    reason: 'Verificador de atualizações: pequeno, mas não precisa rodar logo ao ligar o PC.'
  },
  { re: /browser[_ ]assistant/i, impact: 'medium', reason: 'Assistente do navegador: mais um processo em segundo plano.' },
  {
    re: /opera|chrome|msedge|microsoftedge|firefox|brave|vivaldi/i,
    impact: 'high',
    reason: 'Navegador sendo pré-carregado junto com o Windows: ocupa RAM mesmo sem você abrir.'
  },
  {
    re: /synapse|razer|armoury|\basus|\brog\b|\baura\b|icue|corsair|lghub|lcore|logitech|logioptions|steelseries|hyperx|ngenuity|redragon|cooler ?master|msi ?center|dragon ?center|\bnzxt|signalrgb|openrgb|gaming mouse|gaming keyboard/i,
    impact: 'medium',
    reason: 'Software de periférico/RGB: só é necessário se você usa iluminação, macros ou ajustes do mouse/teclado.'
  },
  { re: /spotify|itunes|deezer|tidal/i, impact: 'medium', reason: 'Player de música: abre em segundo plano mesmo sem você ouvir nada.' },
  {
    re: /anydesk|teamviewer|parsec|tailscale|hamachi|\bwarp\b|cloudflare|rustdesk|zerotier|remote ?desktop|sunshine|\bvpn\b|adspower/i,
    impact: 'medium',
    reason: 'Acesso remoto/VPN: mantém conexões e processos ativos o tempo todo.'
  },
  {
    re: /adobe|creative cloud|ccxprocess|acrobat/i,
    impact: 'medium',
    reason: 'Serviços da Adobe: vários processos em segundo plano para sincronizar e atualizar.'
  },
  { re: /\bzoom\b|webex/i, impact: 'medium', reason: 'App de reunião carregado em segundo plano.' },
  { re: /lightshot|greenshot|sharex|f\.lux|\bflux\b|powertoys/i, impact: 'low', reason: 'Utilitário pequeno: pesa pouco.' },
  { re: /helper|assistant|agent|launcher|notification|tray/i, impact: 'low', reason: 'Ajudante em segundo plano: pequeno.' }
]

export interface ImpactGuess {
  impact: Impact | 'unknown'
  reason: string
  essential?: boolean
}

/** Estima o impacto de um item de inicialização. */
export function guessStartupImpact(input: {
  name: string
  command: string
  publisher?: string
  description?: string
  exeBytes?: number
  missing?: boolean
}): ImpactGuess {
  const text = `${input.name} ${input.command} ${input.publisher ?? ''} ${input.description ?? ''}`
  if (input.missing) {
    // Antivírus/áudio/touchpad continuam "essenciais" mesmo sem o arquivo encontrado: o app nunca sugere desativar.
    const ess = RULES.find((r) => r.essential && r.re.test(text))
    if (ess) return { impact: 'unknown', essential: true, reason: `${ess.reason} (O arquivo não foi encontrado agora; por segurança, o app não sugere desativar.)` }
    return { impact: 'unknown', reason: 'O programa não foi encontrado (entrada antiga de algo desinstalado). Pode desativar sem problema.' }
  }
  for (const r of RULES) {
    if (r.re.test(text)) return { impact: r.impact, reason: r.reason, essential: r.essential }
  }
  const size = input.exeBytes ?? 0
  if (size >= 80 * 1024 * 1024) {
    return { impact: 'high', reason: 'Programa grande (provavelmente feito com navegador embutido): costuma usar bastante RAM.' }
  }
  if (size >= 15 * 1024 * 1024) return { impact: 'medium', reason: 'Programa de tamanho médio carregado ao ligar o PC.' }
  if (size > 0) return { impact: 'low', reason: 'Programa pequeno: pesa pouco na inicialização.' }
  return { impact: 'unknown', reason: 'Não foi possível estimar o impacto.' }
}

/** Programas de "limpeza/otimização" que rodam em segundo plano (usado nos achados). */
export const OPTIMIZER_RE =
  /ccleaner|avast ?cleanup|avg ?tuneup|tuneup|advanced ?systemcare|iobit|driver ?booster|smart ?defrag|glary|wise ?care|razer ?cortex|norton ?utilities|pc ?optimizer/i
