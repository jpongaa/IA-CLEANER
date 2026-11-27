// Listas fixas da Busca Profunda: pastas de fabricante/sistema, palavras genéricas, assinaturas de jogos, padrões
// de repacks e a lista curada de programas indesejados conhecidos (com explicação honesta em PT-BR).

/** Remove acentos, ™®© e símbolos; minúsculas; espaços simples. */
export function normName(s: string | undefined | null): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[™®©]/g, ' ')
    .toLowerCase()
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Só letras e números (para comparar nomes grudados: "chromeremotedesktophost"). */
export function compact(s: string | undefined | null): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

/** Palavras genéricas que não identificam um programa. */
export const STOP_WORDS = new Set([
  'the', 'and', 'for', 'inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'co', 'sa', 'ag', 'gmbh', 'limited', 'software', 'soft',
  'technologies', 'technology', 'tech', 'games', 'game', 'gaming', 'studio', 'studios', 'entertainment', 'interactive', 'digital', 'media',
  'systems', 'system', 'solutions', 'group', 'foundation', 'project', 'team', 'community', 'development', 'dev', 'labs', 'lab', 'apps',
  'app', 'application', 'applications', 'program', 'programs', 'files', 'file', 'data', 'common', 'shared', 'service', 'services', 'tools',
  'tool', 'utility', 'utilities', 'update', 'updater', 'updates', 'launcher', 'client', 'server', 'desktop', 'windows', 'microsoft', 'x64',
  'x86', 'win', 'win64', 'win32', 'amd64', 'bit', 'pro', 'plus', 'free', 'edition', 'version', 'setup', 'installer', 'install', 'runtime',
  'redistributable', 'driver', 'drivers', 'package', 'packages', 'manager', 'helper', 'player', 'video', 'audio', 'web', 'online', 'cloud',
  'network', 'support', 'center', 'central', 'home', 'lite', 'beta', 'new', 'global', 'local', 'user', 'users', 'config', 'cache', 'temp',
  'logs', 'log', 'backup', 'plugin', 'plugins', 'extension', 'extensions', 'module', 'modules', 'sdk', 'api', 'engine', 'framework',
  'library', 'core', 'base', 'main', 'portable', 'full', 'offline', 'stable', 'release', 'latest', 'official', 'store', 'mobile', 'pc',
  'download', 'downloads', 'repack', 'english', 'portuguese', 'multi', 'gb', 'mb', 'data', 'documents', 'settings', 'default', 'profile',
  'profiles', 'storage', 'crash', 'crashpad', 'reports', 'report', 'telemetry', 'cef', 'electron', 'browser', 'one', 'two', 'all', 'with',
  'from', 'por', 'para', 'com', 'de', 'do', 'da', 'dos', 'das', 'em', 'um', 'uma', 'beta', 'alpha', 'demo', 'build', 'tm'
])

/** Palavras significativas (>= 3 letras, fora das genéricas, não só números). */
export function tokens(s: string | undefined | null): string[] {
  return normName(s)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t))
}

/**
 * Pastas de 1º nível (Arquivos de Programas, ProgramData, AppData...) que abrigam vários produtos ou são do sistema:
 * NUNCA são "sobra" como um todo (só os produtos dentro delas são avaliados um a um).
 */
const VENDOR_EXACT = new Set([
  'common files', 'nvidia corporation', 'nvidia', 'amd', 'ati technologies', 'advanced micro devices', 'intel', 'intel corporation',
  'realtek', 'package cache', 'packages', 'internet explorer', 'reference assemblies', 'modifiablewindowsapps',
  'uninstall information', 'installshield installation information', 'installer', 'temp', 'tmp', 'programs', 'google', 'adobe', 'asus',
  'asustek', 'razer', 'logitech', 'jetbrains', 'apple', 'apple computer', 'oracle', 'electronic arts', 'ea', 'ea games',
  'ubisoft', 'origin games', 'epic games', 'riot games', 'rockstar games', 'gog games', 'gog galaxy', 'gog.com', 'xboxgames',
  'steamlibrary', 'blizzard entertainment', 'valve', 'autodesk', 'corsair', 'steelseries', 'micro-star international', 'gigabyte',
  'western digital', 'seagate', 'samsung', 'lenovo', 'dell', 'hp', 'hewlett-packard', 'acer', 'opera software', 'cisco',
  'application data', 'connecteddevicesplatform', 'comms', 'crashdumps', 'd3dscache', 'publishers', 'virtualstore', 'history',
  'placeholdertilelogofolder', 'squirreltemp', 'peerdistrepub', 'elevateddiagnostics', 'fontcache', 'iconcache', 'gtk-3.0', 'pki',
  'desktop', 'documents', 'start menu', 'templates', 'regid.1991-06.com.microsoft', 'ssh', 'usoshared', 'usoprivate', 'softwaredistribution',
  'packagecache', 'microsoft help', 'appdata'
])

/**
 * Caches de ferramentas e runtimes compartilhados (dotnet, npm, pip, Playwright...): não são "sobra de programa"
 * (são usados por outras ferramentas e a Limpeza cuida dos caches). Nunca entram como leftoverFolder.
 */
const TOOL_CACHE = new Set([
  'dotnet', '.dotnet', 'msbuild', 'chocolatey', 'scoop', 'nuget', '.nuget', 'npm', 'npm-cache', 'pnpm', 'pnpm-cache', 'yarn', 'node-gyp',
  'pip', 'pypa', 'uv', 'ms-playwright', 'ms-playwright-go', 'electron', 'electron-builder', 'cypress', 'go-build', 'go', 'cargo', 'rustup',
  'gradle', 'mapbox', 'fontconfig', 'certificates', 'windowspowershell', 'powershell', 'sysinternals', 'speech', 'ssl', 'dbg', 'symbols',
  'nodejs', 'node', 'git', 'python', 'java', 'jdk', 'wsl', 'vs', 'visualstudio', 'vscode', 'microsoft visual studio', 'windows kits',
  'reference assemblies', 'iis express', 'iisexpress', 'sql server', 'microsoft sql server', 'shader cache', 'shadercache', 'gpucache',
  'cache', 'caches', 'logs', 'crashpad', 'crashreports', 'squirrel', 'updater', 'tools', 'android', '.android', 'pub', 'flutter',
  'azurefunctionstools', 'jetbrains', 'unity', 'vulkan', 'nvm', 'pyenv', 'conda', 'anaconda3', 'miniconda3', 'deno', 'bun', 'composer',
  // caches de ferramentas de desenvolvimento (Go, Unreal Engine...): quem cuida é a própria ferramenta
  'gopls', 'goimports', 'staticcheck', 'golangci-lint', 'dlv', 'unrealbuildtool', 'unrealengine', 'unrealheadertool', 'epicgameslauncher'
])

export function isToolCacheName(name: string): boolean {
  return TOOL_CACHE.has(name.trim().toLowerCase())
}
const VENDOR_PREFIX = ['microsoft', 'windows', 'msecache', 'mspdb', 'intel(', 'nvidia ', 'amd ', 'realtek ']

export function isVendorRoot(name: string): boolean {
  const n = name.trim().toLowerCase()
  if (VENDOR_EXACT.has(n)) return true
  return VENDOR_PREFIX.some((p) => n.startsWith(p))
}

/** Nomes que NUNCA podem ser apagados por "sobra" ou "remover à força" (sistema, drivers, segurança, o próprio app). */
const NEVER_NAMES = [
  /^microsoft/i,
  /^windows/i,
  /^ia ?cleaner/i,
  /^iacleaner/i,
  /^(common files|internet explorer|reference assemblies|windowsapps|modifiablewindowsapps|package cache|packages|installer|installshield installation information|uninstall information)$/i,
  /^(system32|syswow64|drivers|driverstore|winsxs)$/i,
  /^(nvidia|nvidia corporation|amd|ati technologies|advanced micro devices|intel|intel corporation|realtek)$/i
]

/** Antivírus/segurança: nunca "remover à força" (só pelo desinstalador oficial / ferramenta do fabricante). */
const SECURITY_NAMES =
  /(defender|security|antivirus|anti-virus|avast|avg|kaspersky|eset|norton|symantec|mcafee|bitdefender|malwarebytes|sophos|trend ?micro|avira|panda|webroot|comodo|emsisoft|f-secure|gdata|g data|zonealarm|reasonlabs|rav antivirus|totalav|total av|surfshark antivirus|360 total|qihoo|easyanticheat|battleye|vanguard|riot vanguard|faceit|denuvo|anticheat|anti-cheat|wellbia|xigncode|nprotect|gameguard)/i

export function isNeverTouchName(name: string): boolean {
  return NEVER_NAMES.some((re) => re.test(name.trim()))
}

export function isSecurityName(name: string): boolean {
  return SECURITY_NAMES.test(name)
}

// --------------------------------------------------------------------------------------------- pastas-contêiner e pessoais

/**
 * Pasta que REÚNE vários jogos (nunca é "um jogo"): X:\Games, X:\Jogos, X:\Repacks, "Jogos Hydra", "Meus Jogos",
 * "Epic Games", "XboxGames", "SteamLibrary"... Palavra no plural em qualquer posição, ou o nome exato no singular.
 */
export function isContainerName(name: string): boolean {
  const n = normName(name)
  if (!n) return false
  if (n === 'repack') return true
  if (/\b(games|jogos|repacks|giochi|juegos|spiele|jeux)\b/.test(n)) return true
  return /^(xboxgames|steamlibrary|steamapps|common|gamelibrary|gameslibrary)$/.test(compact(name))
}

/** Pastas pessoais (de qualquer disco): nunca são "pasta de programa". */
const PERSONAL_DIR_RE =
  /^(downloads?|baixados|transferencias|documents|documentos|meus documentos|my documents|desktop|area de trabalho|videos|meus videos|my videos|pictures|imagens|minhas imagens|my pictures|fotos|photos|music|musicas|minhas musicas|my music|onedrive|onedrive .*|google drive|meu drive|my drive|dropbox|icloud.*|mega|saved games|jogos salvos|contacts|favorites|links|searches)$/

export function isPersonalDirName(name: string): boolean {
  return PERSONAL_DIR_RE.test(normName(name))
}

/** Pastas de gravações (DVR/clipes/capturas) e de backups: dados do usuário, nunca "programa". */
export function isRecordingOrBackupName(name: string): boolean {
  const n = normName(name)
  return (
    /\b(gravacao|gravacoes|recording|recordings|capture|captures|captura|capturas|clip|clips|replay|replays|highlights?|bandicam|obs|shadowplay|dvr|fraps|medal|geforce experience|nvidia share)\b/.test(n) ||
    /\b(backup|backups|bkp|bak|copia de seguranca|copias de seguranca)\b/.test(n)
  )
}

/** Nomes genéricos de subpasta (bin, x64, app-1.2.3, GUID...): não identificam o programa. */
const GENERIC_DIR = new Set([
  'bin', 'bin64', 'bin32', 'x64', 'x86', 'win64', 'win32', 'amd64', 'arm64', 'binaries', 'common', 'current', 'app', 'apps', 'program',
  'programs', 'uninstall', 'uninst', 'setup', 'installer', 'data', 'resources', 'lib', 'libs', 'dist', 'release', 'launcher', 'client',
  'game', 'games', 'jogos', 'steamapps', 'steamlibrary', 'engine', 'plugins', 'tools', 'support', 'files', 'main', 'core', 'system',
  'update', 'updater', 'cache', 'temp', 'tmp', 'local', 'roaming', 'locallow', 'appdata'
])

/** Subpasta de nome genérico (bin, x64, Binaries, Win64, app-1.2.3, GUID...). */
export function isGenericDirName(name: string): boolean {
  const low = name.trim().toLowerCase()
  return GENERIC_DIR.has(low) || /^(build|builds|output|out|shipping|redist|_commonredist|commonredist|directx|support)$/.test(low) || /^\{?[0-9a-f-]{8,}\}?$/i.test(low) || /^(app-)?v?\d+([._-]\d+)*[a-z]?$/i.test(low)
}

/**
 * "Nome vivo" de uma pasta de programa instalado: o nome da pasta final (ou da de cima, se a final for genérica),
 * só letras e números (ex.: "...\Electronic Arts\EA Desktop\EA Desktop" -> "eadesktop"; casa com "EADesktop").
 */
export function liveNameOf(p: string): string | undefined {
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]+/)
  for (let i = parts.length - 1; i >= Math.max(1, parts.length - 3); i--) {
    const seg = parts[i]
    const low = seg.trim().toLowerCase()
    if (!low || /^[a-z]:$/.test(low)) return undefined
    if (GENERIC_DIR.has(low) || STOP_WORDS.has(low) || /^\{?[0-9a-f-]{8,}\}?$/i.test(low) || /^(app-)?v?\d+([._-]\d+)*[a-z]?$/i.test(low)) continue
    const c = compact(seg)
    if (c.length < 4 || !/[a-z]{3}/.test(c)) continue
    return c
  }
  return undefined
}

// --------------------------------------------------------------------------------------------- jogos

/** Arquivos que indicam com segurança que a pasta é um jogo (motor/SDK de jogos). */
export const GAME_STRONG_FILES: { re: RegExp; label: string }[] = [
  { re: /^unityplayer\.dll$/i, label: 'motor Unity (UnityPlayer.dll)' },
  { re: /^gameassembly\.dll$/i, label: 'motor Unity (GameAssembly.dll)' },
  { re: /-win64-shipping\.exe$/i, label: 'motor Unreal (…-Win64-Shipping.exe)' },
  { re: /-wingdk-shipping\.exe$/i, label: 'motor Unreal (…-WinGDK-Shipping.exe)' },
  { re: /^steam_api(64)?\.dll$/i, label: 'biblioteca da Steam (steam_api)' },
  { re: /^eossdk-win(32|64)-shipping\.dll$/i, label: 'serviços online da Epic (EOSSDK)' },
  { re: /^galaxy(64)?\.dll$/i, label: 'biblioteca do GOG Galaxy' },
  { re: /^data\.win$/i, label: 'motor GameMaker (data.win)' },
  { re: /^bink2?w(32|64)\.dll$/i, label: 'vídeos Bink (usado em jogos)' },
  { re: /^nvngx_dlss\.dll$/i, label: 'NVIDIA DLSS (usado em jogos)' },
  { re: /^amd_fidelityfx_.*\.dll$/i, label: 'AMD FidelityFX (usado em jogos)' },
  { re: /^fmod(studio|64|_event)?(64)?\.dll$/i, label: 'áudio FMOD (usado em jogos)' },
  { re: /^physx(3|_64|3_x64|3common_x64)?.*\.dll$/i, label: 'física PhysX (usado em jogos)' },
  { re: /^rgss\d+[a-z]?\.dll$/i, label: 'motor RPG Maker' },
  { re: /^steam_emu\.ini$|^codex\.ini$|^onlinefix(64)?\.(dll|ini)$|^cream_api\.ini$|^steam_settings$/i, label: 'arquivos de crack/emulador da Steam' },
  { re: /\.rpa$/i, label: "motor Ren'Py (.rpa)" },
  { re: /^goggame-\d+\.(info|ico|hashdb)$/i, label: 'instalação do GOG' }
]

/** Pastas típicas de jogos (UE: Engine\Binaries; Unity: X_Data\Managed). */
export const GAME_DIR_HINTS: { re: RegExp; label: string }[] = [
  { re: /^engine$/i, label: 'pasta Engine (Unreal)' },
  { re: /_data$/i, label: 'pasta _Data (Unity)' },
  { re: /^paks$/i, label: 'pasta Paks (Unreal)' },
  { re: /^renpy$/i, label: "pasta renpy (Ren'Py)" }
]

/** .exe que não é o jogo (desinstaladores, instaladores de dependências, relatórios de erro, anti-cheat...). */
export const NOT_GAME_EXE = /^(unins\d+|uninstall.*|setup|crashreport.*|crashhandler.*|unitycrashhandler(32|64)|dxsetup|vc_?redist.*|vcredist.*|dotnet.*|ue4prereqsetup.*|ue[45]?prereq.*|easyanticheat.*|battleye.*|be(service|launcher).*|launcher|7z.*|oalinst|physx.*)\.exe$/i

/** Desinstalador do Inno Setup (usado por repacks FitGirl/DODI/ElAmigos e por instaladores de jogos do GOG). */
export const INNO_UNINSTALLER = /^unins\d{3}\.exe$/i

// --------------------------------------------------------------------------------------------- repacks / downloads

export const REPACK_NAME = /(fitgirl|fit ?girl|dodi|elamigos|el amigos|kaos ?krew|xatab|r\.g\.?\s?mechanics|mechanics|chovka|decepticon|corepack|masquerade|tinyrepacks|darck|seyter|repack|codex|skidrow|empress|tenoke|rune|flt|plaza|razor1911|darksiders|chronos|tinyiso|goldberg|online-?fix|portable)/i

/** Arquivos de dados de repack (setup-fitgirl-01.bin, fg-01.bin, data1.bin, *.doi...). */
export const REPACK_DATA_FILE = /^(fg-\d+\.bin|fg-optional-.+\.bin|fg-selective-.+\.bin|setup-fitgirl-.+\.bin|setup-.+\.bin|data\d*\.bin|.+\.doi|.+\.(bin|cab)\d*)$/i

/** Downloads incompletos (navegadores, torrents, gerenciadores). */
export const INCOMPLETE_EXT = /\.(part|partial|crdownload|download|!qb|!ut|bc!|opdownload|tmp\.download)$/i

export const INSTALLER_EXT = /\.(exe|msi|msix|msixbundle|appx|appxbundle)$/i
export const ARCHIVE_EXT = /\.(zip|rar|7z)$/i
export const DISK_IMAGE_EXT = /\.(iso|img)$/i

/** Nome de arquivo que diz "instalador". */
export const INSTALLER_NAME = /(setup|install|installer|instalador|usersetup|bootstrapper|webinstall|_inst\b|-inst\b|redist|vc_redist|vcredist|directx|dxsetup)/i

/** Partes do nome do arquivo que não identificam o produto (versão, arquitetura, "setup"...). */
export function productFromFileName(file: string): string {
  let s = file.replace(/\.[^.]+$/, '')
  s = s.replace(/\(\d+\)$/, '')
  s = s.replace(/[_\-.\s]v?\d+([._]\d+)+[a-z0-9]*/gi, ' ')
  s = s.replace(/\b(x64|x86|x32|win64|win32|windows|win|amd64|arm64|64bit|32bit|64-bit|32-bit|setup|installer|install|instalador|usersetup|user|full|offline|online|web|latest|release|stable|portable|native|bootstrapper|launcher-?setup)\b/gi, ' ')
  s = s.replace(/[_\-.]+/g, ' ')
  s = s.replace(/\b[0-9a-f]{16,}\b/gi, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

// --------------------------------------------------------------------------------------------- indesejados

export interface UnwantedEntry {
  /** Casa com o nome do programa (registro), do item de inicialização ou da pasta */
  re: RegExp
  /** Nome amigável */
  name: string
  /** Por que é indesejado (honesto, PT-BR) */
  why: string
  /** 'safe' = adware/PUP claro; 'review' = depende do uso */
  verdict: 'safe' | 'review'
  category: 'navegador' | 'otimizador' | 'driver' | 'adware' | 'barra' | 'helper' | 'antivirus' | 'ativador'
}

export const UNWANTED: UnwantedEntry[] = [
  { re: /\bwave ?browser\b|\bwavesor\b/i, name: 'Wave Browser', why: 'Navegador que costuma vir escondido em outros instaladores, muda a página inicial e a busca. Classificado como programa potencialmente indesejado (PUP) por vários antivírus.', verdict: 'safe', category: 'navegador' },
  { re: /\bonelaunch\b/i, name: 'OneLaunch', why: 'Barra/navegador que se instala junto com outros programas, abre com o Windows e mostra anúncios. Considerado PUP.', verdict: 'safe', category: 'navegador' },
  { re: /\bshift browser\b|^shift$/i, name: 'Shift Browser', why: 'Navegador distribuído em pacotes de outros programas; abre com o Windows. Muitos usuários nem lembram de ter instalado.', verdict: 'review', category: 'navegador' },
  { re: /\b(avast|avg|ccleaner|norton) (secure )?browser\b/i, name: 'Navegador empacotado de antivírus/limpador', why: 'Navegador instalado "de brinde" junto com antivírus/limpadores. Se você não usa, pode desinstalar.', verdict: 'review', category: 'navegador' },
  { re: /\bweb ?companion\b|\blavasoft\b|\badaware web companion\b/i, name: 'Web Companion (Lavasoft/Adaware)', why: 'Vem junto com outros instaladores e altera configurações do navegador. Classificado como PUP pela Microsoft.', verdict: 'safe', category: 'adware' },
  { re: /\bbytefence\b/i, name: 'ByteFence', why: 'Antivírus que normalmente entra junto com outros programas sem o usuário perceber (PUP).', verdict: 'safe', category: 'antivirus' },
  { re: /\bsegurazo\b|\bsantivirus\b|\bsanti ?virus\b/i, name: 'Segurazo / SAntivirus', why: 'Antivírus distribuído em pacotes de outros programas, difícil de remover. Classificado como PUP.', verdict: 'safe', category: 'antivirus' },
  { re: /\breasonlabs\b|\brav (endpoint|antivirus)\b|\brav vantage\b/i, name: 'RAV Antivirus / ReasonLabs', why: 'Antivírus que costuma vir "de brinde" em instaladores (ex.: uTorrent). Ter dois antivírus junto com o Windows Defender deixa o PC mais lento. Desinstale pelo desinstalador oficial.', verdict: 'review', category: 'antivirus' },
  { re: /\bdriver ?booster\b/i, name: 'IObit Driver Booster', why: 'Atualizador de drivers de terceiros: pode instalar drivers errados. Para drivers, use o Windows Update e os sites da NVIDIA/AMD/fabricante (página Drivers).', verdict: 'review', category: 'driver' },
  { re: /\bdriver ?(easy|max|support|updater|genius|reviver|talent|tonic|fix|hub pro|doctor|agent)\b|\bsmart driver (care|updater)\b|\bdriverpack\b|\bsnappy driver installer\b/i, name: 'Atualizador de drivers de terceiros', why: 'Programas "atualizadores de drivers" costumam assustar com alertas e às vezes instalam drivers errados. O Windows Update e os sites oficiais (página Drivers) resolvem isso de graça.', verdict: 'review', category: 'driver' },
  { re: /\badvanced systemcare\b|\biobit (uninstaller|smart defrag|malware fighter)\b/i, name: 'IObit (otimizador)', why: '"Otimizadores" que prometem acelerar o PC mas ficam rodando o tempo todo e mostram propaganda. O IA Cleaner já faz a limpeza com segurança.', verdict: 'review', category: 'otimizador' },
  { re: /\b(outbyte|pc repair|pc accelerate|reimage|restoro|fortect|mypc utilities|pc cleaner|pc optimizer|pc booster|speedup my pc|systweak|advanced system optimizer|wise care 365|ashampoo winoptimizer|winzip system utilities|slimcleaner|uniblue|totalav|total av|pc helpsoft|segurazo)\b/i, name: '"Otimizador" do PC', why: 'Programas de "otimização" que geralmente mostram problemas exagerados para vender licença e ficam rodando em segundo plano. Desinstale se não pagou nem usa.', verdict: 'review', category: 'otimizador' },
  { re: /\bwondershare (helper compact|nativepush|studio|update)\b|\bwshelper\b|\bwsnativepush\b/i, name: 'Ajudante da Wondershare', why: 'Componente que fica rodando com o Windows para mostrar ofertas e atualizações dos programas da Wondershare. Se você já desinstalou o programa principal, ele sobrou.', verdict: 'safe', category: 'helper' },
  { re: /\bmcafee web ?advisor\b|\bmcafee security scan\b/i, name: 'McAfee WebAdvisor', why: 'Extensão/serviço da McAfee que vem junto com outros instaladores (ex.: Adobe Reader). Não é necessário com o Windows Defender.', verdict: 'review', category: 'adware' },
  { re: /\bnorton safe web\b|\bnorton security scan\b/i, name: 'Norton Safe Web / Security Scan', why: 'Componente que vem junto com outros instaladores. Não é necessário com o Windows Defender.', verdict: 'review', category: 'adware' },
  { re: /\b(ask|conduit|babylon|mindspark|search ?protect|delta|sweetim|hao123|baidu|yahoo) ?(toolbar|search|barra)\b|\bsearch protect\b/i, name: 'Barra de ferramentas/sequestrador de busca', why: 'Barras de navegador e "protetores de busca" que trocam a página inicial e mostram anúncios. Considerados PUP.', verdict: 'safe', category: 'barra' },
  { re: /\b(pdf ?hub|manuals ?hub|easy ?pdf ?combine|pdf ?wizard|pdfsearchtab|convertpdfsearch|myway)\b/i, name: 'Adware de "PDF/manuais"', why: 'Extensões/programas que se passam por ferramentas de PDF mas mudam a busca e mostram anúncios.', verdict: 'safe', category: 'adware' },
  { re: /\bkms ?(pico|auto|tools|spico)\b|\bkmsauto\b|\bauto ?kms\b/i, name: 'Ativador pirata do Windows/Office (KMS)', why: 'Ativadores piratas frequentemente vêm com vírus e deixam tarefas/serviços escondidos. Recomenda-se remover e verificar o PC com a Segurança do Windows.', verdict: 'review', category: 'ativador' },
  { re: /\butorrent web\b|\butweb\b/i, name: 'uTorrent Web', why: 'Cliente de torrent com propaganda que costuma instalar programas "de brinde" (ex.: antivírus RAV). Se usa torrent, prefira o qBittorrent (sem anúncios).', verdict: 'review', category: 'adware' },
  { re: /\bclean ?master\b|\bcheetah\b/i, name: 'Clean Master (Cheetah Mobile)', why: 'Limpador com histórico de propaganda agressiva. O IA Cleaner já faz a limpeza com segurança.', verdict: 'review', category: 'otimizador' },
  { re: /\bhola\b.*\b(vpn|unblocker)\b/i, name: 'Hola VPN', why: 'VPN gratuita que usa a sua conexão como "saída" para outros usuários. Desinstale se não usa.', verdict: 'review', category: 'adware' }
]

/** Indesejado conhecido pelo nome (programa, item de inicialização ou pasta). */
export function matchUnwanted(...names: (string | undefined | null)[]): UnwantedEntry | undefined {
  for (const n of names) {
    if (!n) continue
    const hit = UNWANTED.find((u) => u.re.test(n))
    if (hit) return hit
  }
  return undefined
}

/** Página oficial (Microsoft) sobre aplicativos potencialmente indesejados. */
export const PUA_LEARN_MORE = 'https://learn.microsoft.com/pt-br/defender-endpoint/detect-block-potentially-unwanted-apps-microsoft-defender-antivirus'
