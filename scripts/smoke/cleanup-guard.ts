// Testes do guard de segurança (src/main/safety/guard.ts) e das pastas conhecidas (knownFolders.ts). TEM que passar 100%.
// Uso: npm run smoke -- cleanup-guard
// Cria apenas uma sandbox em %TEMP%\iacleaner-test-cleanup\guard (ou em %IACLEANER_TEST_DIR%\guard) com junctions para
// testar atalhos, e a remove no fim. Variáveis de ambiente (TEMP/TMP) só são trocadas DENTRO deste processo.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  checkPath,
  checkPathLexical,
  checkTargetRoot,
  getKnownAppDirs,
  isSaneTempRoot,
  normalizeWinPath,
  pathForDeletion,
  reparsePointIn,
  resetGuardCaches,
  setCleanupRoots,
  setKnownAppDirs,
  type GuardContext
} from '../../src/main/safety/guard'
import { getKnownFolders, parseRegExport, readRegistryStrings, resetKnownFoldersCache } from '../../src/main/safety/knownFolders'
import { deleteContents } from '../../src/main/cleanup/engine'
import { dataDir, setAppPaths } from '../../src/main/core/paths'
import { runPowerShellJson } from '../../src/main/core/powershell'

type Expect = 'blocked' | 'warn' | 'ok' | 'allowed'

interface Case {
  p: unknown
  expect: Expect
  ctx?: GuardContext
  roots?: string[]
  filtered?: boolean
  note?: string
}

let pass = 0
let fail = 0
const failures: string[] = []

function show(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : String(v)
}

function check(c: Case): void {
  const ctx = c.ctx ?? 'userSelected'
  const d = checkPath(c.p as string, ctx, { roots: c.roots, filtered: c.filtered })
  const ok =
    c.expect === 'allowed' ? d.allowed : c.expect === 'blocked' ? !d.allowed && d.level === 'blocked' : d.allowed && d.level === c.expect
  const line = `${ok ? 'PASS' : 'FAIL'}  [${ctx === 'cleanupTarget' ? 'alvo' : 'user'}] ${show(c.p)} -> ${d.level} (esperado ${c.expect})${c.note ? ' · ' + c.note : ''}\n        motivo: ${d.reason}`
  if (ok) pass++
  else {
    fail++
    failures.push(line)
  }
  console.log(line)
}

function assert(cond: boolean, label: string): void {
  if (cond) {
    pass++
    console.log(`PASS  ${label}`)
  } else {
    fail++
    failures.push(`FAIL  ${label}`)
    console.log(`FAIL  ${label}`)
  }
}

export async function run(): Promise<void> {
  const home = os.homedir()
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
  const roaming = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  const temp = fs.realpathSync.native(os.tmpdir())
  const sys = process.env.SystemDrive ?? 'C:'
  const testDir = process.env.IACLEANER_TEST_DIR ? path.resolve(process.env.IACLEANER_TEST_DIR) : path.join(temp, 'iacleaner-test-cleanup')

  // ---------- Sandbox com junction ----------
  const sandbox = path.join(testDir, 'guard')
  fs.rmSync(sandbox, { recursive: true, force: true })
  // Dados do app (e o .reg temporário das pastas conhecidas) dentro da sandbox
  setAppPaths({ userData: path.join(sandbox, 'userdata') })
  resetGuardCaches()
  resetKnownFoldersCache()
  const realDir = path.join(sandbox, 'alvo-real')
  const targetRoot = path.join(sandbox, 'raiz-limpeza')
  fs.mkdirSync(realDir, { recursive: true })
  fs.mkdirSync(targetRoot, { recursive: true })
  fs.writeFileSync(path.join(realDir, 'precioso.txt'), 'não apagar')
  fs.writeFileSync(path.join(targetRoot, 'lixo.tmp'), 'x')
  const junction = path.join(targetRoot, 'atalho-junction')
  fs.symlinkSync(realDir, junction, 'junction')
  const junctionRoot = path.join(sandbox, 'raiz-que-e-junction')
  fs.symlinkSync(targetRoot, junctionRoot, 'junction')

  const cases: Case[] = [
    // ----- Entradas inválidas / relativas -----
    { p: '', expect: 'blocked', note: 'vazio' },
    { p: '    ', expect: 'blocked', note: 'só espaços' },
    { p: 12345, expect: 'blocked', note: 'não é texto' },
    { p: 'relativo\\arquivo.txt', expect: 'blocked', note: 'relativo' },
    { p: '.\\arquivo.txt', expect: 'blocked', note: 'relativo com ponto' },
    { p: '..\\..\\Windows', expect: 'blocked', note: 'relativo subindo' },
    { p: 'C:arquivo.txt', expect: 'blocked', note: 'relativo à unidade' },
    { p: '\\Windows\\System32', expect: 'blocked', note: 'sem letra de unidade' },
    { p: 'C:\\pasta\\arquivo.txt:fluxo', expect: 'blocked', note: 'fluxo alternativo (ADS)' },
    { p: 'C:\\temp\\*.tmp', expect: 'blocked', note: 'curinga' },
    { p: `${home}\\Desktop\\NUL`, expect: 'blocked', note: 'nome reservado' },
    { p: 'C:\\pasta\\...\\x', expect: 'blocked', note: 'nome só de pontos' },
    { p: 'C:\\pasta\\arq\u0007.txt', expect: 'blocked', note: 'caractere de controle' },
    // ----- Raízes de unidade -----
    { p: 'C:\\', expect: 'blocked' },
    { p: 'C:', expect: 'blocked' },
    { p: 'c:/', expect: 'blocked' },
    { p: 'D:\\', expect: 'blocked' },
    { p: 'E:\\', expect: 'blocked' },
    { p: 'C:\\Windows\\..\\..\\..', expect: 'blocked', note: 'sobe além da raiz' },
    // ----- Rede / dispositivos -----
    { p: '\\\\servidor\\compartilhado\\arquivo.txt', expect: 'blocked', note: 'UNC' },
    { p: '\\\\localhost\\C$\\Windows', expect: 'blocked', note: 'compartilhamento administrativo' },
    { p: '\\\\?\\UNC\\servidor\\x\\y', expect: 'blocked', note: 'UNC longo' },
    { p: '\\\\?\\Volume{12345678-1234-1234-1234-123456789012}\\x', expect: 'blocked', note: 'volume GUID' },
    { p: '\\\\.\\PhysicalDrive0', expect: 'blocked', note: 'disco físico' },
    // ----- Windows (com truques) -----
    { p: 'C:\\Windows', expect: 'blocked' },
    { p: 'c:/windows/system32', expect: 'blocked', note: 'barras normais + minúsculas' },
    { p: 'C:\\WINDOWS\\SYSTEM32\\drivers\\etc\\hosts', expect: 'blocked' },
    { p: 'C:\\Windows\\..\\Windows', expect: 'blocked', note: '..' },
    { p: 'C:\\Windows\\System32\\..\\..\\Windows\\explorer.exe', expect: 'blocked', note: '.. duplo' },
    { p: '\\\\?\\C:\\Windows', expect: 'blocked', note: 'prefixo \\\\?\\' },
    { p: '\\\\?\\C:\\Windows\\System32\\config\\SAM', expect: 'blocked', note: 'prefixo \\\\?\\ + registro' },
    { p: '\\\\.\\C:\\Windows\\notepad.exe', expect: 'blocked', note: 'prefixo \\\\.\\' },
    { p: '\\??\\C:\\Windows\\notepad.exe', expect: 'blocked', note: 'prefixo NT \\??\\' },
    { p: '//?/C:/Windows/System32', expect: 'blocked', note: 'prefixo com barras normais' },
    { p: 'C:\\Windows.\\System32', expect: 'blocked', note: 'ponto no fim do nome' },
    { p: 'C:\\Windows   \\System32', expect: 'blocked', note: 'espaços no fim do nome' },
    { p: '"C:\\Windows\\System32"', expect: 'blocked', note: 'entre aspas' },
    { p: '  C:\\Windows\\System32  ', expect: 'blocked', note: 'espaços em volta' },
    { p: 'C:\\Windows\\\\System32', expect: 'blocked', note: 'barra dupla' },
    { p: 'C:\\Windows\\Prefetch\\APP.EXE-1234.pf', expect: 'blocked', note: 'Prefetch não é limpo' },
    { p: 'C:\\Windows\\Temp', expect: 'blocked', note: 'pasta Temp em si' },
    { p: 'C:\\Windows\\SoftwareDistribution\\DataStore\\DataStore.edb', expect: 'blocked' },
    { p: 'C:\\Windows\\Logs\\CBS\\CbsPersist_20261016.cab', expect: 'blocked', note: 'só *.log é exceção' },
    { p: 'C:\\Windows\\Installer\\abc.msi', expect: 'blocked', note: 'cache do Windows Installer' },
    { p: 'E:\\Windows\\System32\\x.dll', expect: 'blocked', note: 'Windows em outro disco' },
    // ----- Exceções dentro do Windows (permitidas) -----
    { p: 'C:\\Windows\\Temp\\arquivo.tmp', expect: 'ok' },
    { p: 'C:\\Windows\\Temp\\sub\\pasta\\log.txt', expect: 'ok' },
    { p: 'C:\\Windows\\SoftwareDistribution\\Download\\abc123\\update.cab', expect: 'ok' },
    { p: 'C:\\Windows\\LiveKernelReports\\WATCHDOG\\x.dmp', expect: 'ok' },
    { p: 'C:\\Windows\\Minidump\\102026-12345-01.dmp', expect: 'ok' },
    { p: 'C:\\Windows\\MEMORY.DMP', expect: 'ok' },
    { p: 'C:\\Windows\\Logs\\CBS\\CbsPersist_20261019172053.log', expect: 'ok' },
    // ----- Program Files / ProgramData -----
    { p: 'C:\\Program Files', expect: 'blocked' },
    { p: 'C:\\Program Files (x86)\\Steam\\steam.exe', expect: 'blocked' },
    { p: 'C:\\Program Files\\WindowsApps\\x', expect: 'blocked' },
    { p: 'D:\\Program Files\\Jogo\\game.exe', expect: 'blocked', note: 'Program Files em outro disco' },
    { p: 'C:\\ProgramData', expect: 'blocked' },
    { p: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\x.lnk', expect: 'blocked' },
    { p: 'C:\\ProgramData\\Microsoft\\Windows\\WER', expect: 'blocked', note: 'pasta WER em si' },
    { p: 'C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportArchive\\AppCrash_x\\Report.wer', expect: 'ok' },
    { p: 'C:\\ProgramData\\NVIDIA Corporation\\NV_Cache\\abc.bin', expect: 'ok' },
    { p: 'C:\\Program Files (x86)\\Steam\\steamapps\\shadercache\\252490\\fozpipelinesv6\\x.foz', expect: 'ok', note: 'exceção: shaders da Steam' },
    // ----- Usuários / perfil -----
    { p: 'C:\\Users', expect: 'blocked' },
    { p: home, expect: 'blocked', note: 'perfil' },
    { p: `C:\\Users\\${path.basename(home)}`, expect: 'blocked', note: 'perfil (literal)' },
    { p: home.toUpperCase(), expect: 'blocked', note: 'perfil em maiúsculas' },
    { p: `${home}\\`, expect: 'blocked', note: 'perfil com barra no fim' },
    { p: 'C:\\Users\\Default\\NTUSER.DAT', expect: 'blocked' },
    { p: 'C:\\Users\\Public', expect: 'blocked' },
    { p: `${home}\\NTUSER.DAT`, expect: 'blocked' },
    { p: `${home}\\Documents`, expect: 'blocked', note: 'pasta Documentos em si' },
    { p: `${home}\\Documents\\`, expect: 'blocked', note: 'Documentos com barra' },
    { p: `${home}\\Documents\\..\\Documents`, expect: 'blocked', note: 'Documentos com ..' },
    { p: `${home}\\Desktop`, expect: 'blocked' },
    { p: `${home}\\Downloads`, expect: 'blocked' },
    { p: `${home}\\Pictures`, expect: 'blocked' },
    { p: `${home}\\Videos`, expect: 'blocked' },
    { p: `${home}\\Music`, expect: 'blocked' },
    { p: `${home}\\OneDrive`, expect: 'blocked' },
    { p: `${home}\\AppData`, expect: 'blocked' },
    { p: local, expect: 'blocked', note: 'AppData\\Local' },
    { p: roaming, expect: 'blocked', note: 'AppData\\Roaming' },
    { p: `${home}\\AppData\\LocalLow`, expect: 'blocked' },
    { p: `${local}\\Temp`, expect: 'blocked', note: 'pasta Temp do usuário em si' },
    { p: `${local}\\Microsoft`, expect: 'blocked' },
    { p: `${roaming}\\Microsoft\\Windows`, expect: 'blocked' },
    { p: `${home}\\.ssh\\id_ed25519`, expect: 'blocked', note: 'chave SSH' },
    { p: 'C:\\Users\\All Users\\x.txt', expect: 'blocked', note: 'perfil especial/junction' },
    { p: `C:\\Documents and Settings\\${path.basename(home)}\\x.txt`, expect: 'blocked', note: 'junction de compatibilidade' },
    // ----- Áreas do sistema na raiz -----
    { p: 'C:\\System Volume Information', expect: 'blocked' },
    { p: 'C:\\$Recycle.Bin', expect: 'blocked' },
    { p: 'D:\\$Recycle.Bin\\S-1-5-21-1\\$R12345.mkv', expect: 'blocked', note: 'só via Esvaziar Lixeira' },
    { p: 'C:\\Recovery\\WindowsRE\\Winre.wim', expect: 'blocked' },
    { p: 'C:\\Boot\\BCD', expect: 'blocked' },
    { p: 'C:\\EFI\\Microsoft\\Boot\\bootmgfw.efi', expect: 'blocked' },
    { p: 'C:\\pagefile.sys', expect: 'blocked' },
    { p: 'D:\\pagefile.sys', expect: 'blocked' },
    { p: 'C:\\hiberfil.sys', expect: 'blocked' },
    { p: 'C:\\swapfile.sys', expect: 'blocked' },
    { p: 'C:\\bootmgr', expect: 'blocked' },
    { p: 'C:\\Windows.old', expect: 'blocked', note: 'só pelas Configurações' },
    { p: 'C:\\Windows.old\\Users\\x\\foto.jpg', expect: 'blocked' },
    { p: 'C:\\$WINDOWS.~BT\\Sources\\x', expect: 'blocked' },
    { p: 'C:\\Config.Msi\\x.rbf', expect: 'blocked' },
    // ----- Jogos -----
    { p: 'D:\\SteamLibrary', expect: 'blocked' },
    { p: 'D:\\SteamLibrary\\steamapps', expect: 'blocked' },
    { p: 'D:\\SteamLibrary\\steamapps\\common', expect: 'blocked' },
    { p: 'D:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077', expect: 'blocked', note: 'pasta do jogo: desinstalar pela Steam' },
    { p: 'D:\\SteamLibrary\\steamapps\\appmanifest_1091500.acf', expect: 'blocked' },
    { p: 'D:\\SteamLibrary\\steamapps\\common\\Cyberpunk 2077\\archive\\pc\\content\\basegame.archive', expect: 'blocked', note: 'DEL-02: arquivo de jogo instalado (Steam)' },
    { p: 'D:\\Epic Games', expect: 'blocked' },
    { p: 'D:\\Epic Games\\Fortnite', expect: 'blocked' },
    { p: 'D:\\Epic Games\\Fortnite\\FortniteGame\\Content\\Paks\\x.pak', expect: 'blocked', note: 'DEL-02: arquivo de jogo instalado (Epic)' },
    { p: 'D:\\Rockstar Games\\Grand Theft Auto V\\x64a.rpf', expect: 'blocked', note: 'DEL-02: Rockstar fora de Program Files' },
    { p: 'D:\\GOG Galaxy\\Games\\The Witcher 3\\content\\texture.cache', expect: 'blocked', note: 'DEL-02: GOG Galaxy\\Games' },
    { p: 'D:\\SteamLibrary\\steamapps\\shadercache\\1091500\\fozpipelinesv6\\x.foz', expect: 'ok', note: 'shaders da Steam continuam liberados' },
    { p: 'D:\\SteamLibrary\\steamapps\\workshop\\content\\1\\x.bin', expect: 'blocked', note: 'DEL-02: workshop = conteúdo da Steam' },
    { p: `${home}\\Documents\\Rockstar Games\\GTA V\\videos\\rendered\\clip.mp4`, expect: 'warn', note: 'pasta de jogos NO PERFIL (vídeos/saves): só aviso' },
    { p: 'C:\\XboxGames\\Halo Infinite', expect: 'blocked' },
    { p: 'D:\\Jogos Avulsos\\MeuJogo', expect: 'blocked', note: 'pasta do inventário de jogos' },
    { p: 'D:\\Jogos Avulsos\\MeuJogo\\save.dat', expect: 'blocked', note: 'DEL-02: arquivo dentro de jogo do inventário' },
    { p: 'D:\\Jogos Avulsos\\MeuJogo\\archive\\pc\\content\\basegame_4_gamedata.archive', expect: 'blocked', note: 'DEL-02: jogo do inventário em pasta própria' },
    { p: 'D:\\Programas\\Editor', expect: 'blocked', note: 'pasta de programa do inventário' },
    { p: 'D:\\Programas\\Editor\\Editor.exe', expect: 'blocked', note: 'DEL-02: .exe de programa do inventário' },
    { p: 'D:\\Programas\\Editor\\plugins\\x.dat', expect: 'blocked', note: 'DEL-02: conteúdo de programa do inventário' },
    // DEL-02: jogo/programa do inventário instalado direto na RAIZ de um disco (profundidade 1)
    { p: 'E:\\Jogo Na Raiz', expect: 'blocked', note: 'DEL-02: pasta de jogo do inventário na raiz do disco' },
    { p: 'E:\\Jogo Na Raiz\\Data\\Win32\\big.cas', expect: 'blocked', note: 'DEL-02: arquivo de jogo do inventário na raiz do disco' },
    { p: 'C:\\Programa Raiz\\app.dll', expect: 'blocked', note: 'DEL-02: programa do inventário na raiz do disco' },
    // ...mas nomes estruturais/temporários/de driver na raiz registrados por engano NÃO viram "pasta de programa"
    { p: 'D:\\Downloads\\video.mp4', expect: 'ok', note: 'D:\\Downloads no inventário é ignorado' },
    { p: 'C:\\Temp\\relatorio.txt', expect: 'ok', note: 'C:\\Temp no inventário é ignorado' },
    { p: 'C:\\AMD\\Chipset\\setup.log', expect: 'ok', note: 'C:\\AMD no inventário é ignorado (sobras de driver)' },
    { p: `${home}\\Documents\\relatorio-do-programa-fantasma.docx`, expect: 'ok', note: 'Documentos registrado como "pasta do programa" é ignorado' },
    { p: `${home}\\Downloads\\video.mp4`, expect: 'ok', note: 'idem (Downloads)' },
    // ----- R3: raízes novas da Busca extrema -----
    { p: 'C:\\ProgramData\\NVIDIA Corporation\\Downloader\\591d2fefff406d921c4c18089e5045f4\\setup.exe', ctx: 'cleanupTarget', roots: ['C:\\ProgramData\\NVIDIA Corporation\\Downloader\\591d2fefff406d921c4c18089e5045f4'], expect: 'ok', note: 'R3: instalador antigo da NVIDIA' },
    { p: 'C:\\ProgramData\\NVIDIA Corporation\\Downloader', expect: 'blocked', note: 'R3: a pasta Downloader em si' },
    { p: 'C:\\ProgramData\\NVIDIA Corporation', expect: 'blocked', note: 'R3: pasta da NVIDIA em ProgramData' },
    { p: 'C:\\ProgramData\\NVIDIA Corporation\\NvBackend\\x.dat', expect: 'blocked', note: 'R3: outras pastas da NVIDIA continuam protegidas' },
    { p: 'C:\\ProgramData\\NVIDIA Corporation\\Downloaderx\\a\\x.bin', expect: 'blocked', note: 'R3: prefixo parecido' },
    { p: 'D:\\SteamLibrary\\steamapps\\downloading\\1091500\\depot\\x.bin', ctx: 'cleanupTarget', roots: ['D:\\SteamLibrary\\steamapps\\downloading'], expect: 'ok', note: 'R3: download incompleto da Steam' },
    { p: 'D:\\SteamLibrary\\steamapps\\downloading\\1091500\\depot\\x.bin', expect: 'blocked', note: 'R3: manualmente continua bloqueado (conteúdo de jogo)' },
    { p: 'D:\\SteamLibrary\\steamapps\\downloading', expect: 'blocked', note: 'R3: a pasta downloading em si' },
    { p: 'D:\\SteamLibrary\\steamapps\\temp\\1091500\\x.tmp', ctx: 'cleanupTarget', roots: ['D:\\SteamLibrary\\steamapps\\temp'], expect: 'ok', note: 'R3: temporário da Steam' },
    { p: 'C:\\Program Files (x86)\\Steam\\steamapps\\downloading\\730\\x.bin', ctx: 'cleanupTarget', roots: ['C:\\Program Files (x86)\\Steam\\steamapps\\downloading'], expect: 'ok', note: 'R3: downloading dentro de Program Files' },
    { p: 'C:\\Program Files (x86)\\Steam\\steamapps\\downloading\\730\\x.bin', expect: 'blocked', note: 'R3: idem, manual bloqueado' },
    { p: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\x.vpk', ctx: 'cleanupTarget', roots: ['C:\\Program Files (x86)\\Steam\\steamapps\\downloading'], expect: 'blocked', note: 'R3: jogo instalado fora da raiz' },
    { p: 'C:\\Program Files (x86)\\Steam\\steamapps\\downloadingX\\x.bin', ctx: 'cleanupTarget', roots: ['C:\\Program Files (x86)\\Steam\\steamapps\\downloadingX'], expect: 'blocked', note: 'R3: nome parecido em Program Files' },
    { p: 'C:\\Program Files (x86)\\Steam\\steam.exe', ctx: 'cleanupTarget', roots: ['C:\\Program Files (x86)\\Steam\\steamapps\\downloading'], expect: 'blocked', note: 'R3: Steam em si' },
    { p: 'D:\\Epic Games\\Fortnite\\.egstore\\bps\\chunk.bin', ctx: 'cleanupTarget', roots: ['D:\\Epic Games\\Fortnite\\.egstore\\bps'], expect: 'ok', note: 'R3: preparação da Epic' },
    { p: 'D:\\Epic Games\\Fortnite\\.egstore\\bps\\chunk.bin', expect: 'blocked', note: 'R3: preparação da Epic manual = bloqueado' },
    { p: 'C:\\Program Files\\Epic Games\\Fortnite\\.egstore\\staging\\x.bin', ctx: 'cleanupTarget', roots: ['C:\\Program Files\\Epic Games\\Fortnite\\.egstore\\staging'], expect: 'ok', note: 'R3: preparação da Epic em Program Files' },
    { p: 'C:\\Program Files\\Epic Games\\Fortnite\\.egstore\\x.manifest', ctx: 'cleanupTarget', roots: ['C:\\Program Files\\Epic Games\\Fortnite\\.egstore\\staging'], expect: 'blocked', note: 'R3: manifesto da Epic nunca' },
    { p: 'D:\\Jogos\\Game\\.egstore\\x.manifest', expect: 'blocked', note: 'R3: manifesto da Epic fora de pasta de jogos' },
    { p: 'D:\\Jogos\\Game\\.egstore', expect: 'blocked', note: 'R3: pasta .egstore em si' },
    { p: `${local}\\CapCut\\User Data\\Cache\\effect\\x.bin`, ctx: 'cleanupTarget', roots: [`${local}\\CapCut\\User Data\\Cache\\effect`], expect: 'ok', note: 'R3: cache do CapCut' },
    { p: `${local}\\CapCut\\User Data\\Projects\\com.lveditor.draft\\x.json`, ctx: 'cleanupTarget', roots: [`${local}\\CapCut\\User Data\\Cache\\effect`], expect: 'blocked', note: 'R3: projetos do CapCut fora da raiz' },
    { p: 'E:\\PLAYERUNKNOWN\'S BATTLEGROUNDS\\PUBG 2025.03.28 - 23.30.38.02.DVR.mp4', expect: 'ok', note: 'R3: gravação do ShadowPlay (apagada por arquivo, vai para a Lixeira)' },
    { p: `${home}\\Videos\\Captures\\Jogo 2026-05-24 12-36-37.mp4`, expect: 'ok', note: 'R3: captura da Xbox Game Bar' },
    { p: 'C:\\Windows\\System32\\DriverStore\\FileRepository\\nvhda.inf_amd64_x\\nvhda64v.sys', expect: 'blocked', note: 'R3: DriverStore só via pnputil (nunca por arquivo)' },
    { p: 'C:\\Windows\\WinSxS\\x86_x\\a.dll', expect: 'blocked', note: 'R3: WinSxS só via DISM/Limpeza de Disco' },
    { p: 'C:\\$WINDOWS.~BT\\Sources\\Panther\\setupact.log', expect: 'blocked', note: 'R3: instalação do Windows só via Limpeza de Disco' },
    { p: 'C:\\hiberfil.sys', ctx: 'cleanupTarget', roots: ['C:\\'], expect: 'blocked', note: 'R3: hibernação só pela página Desempenho' },
    // ----- App -----
    { p: dataDir(), expect: 'blocked', note: 'dados do próprio app' },
    { p: path.join(dataDir(), 'state', 'scan.json'), expect: 'blocked' },
    { p: process.execPath, expect: 'blocked', note: 'executável em uso' },
    // ----- Permitidos (userSelected) -----
    { p: 'D:\\Filmes\\filme antigo.mkv', expect: 'ok' },
    { p: 'E:\\Backup\\fotos 2019.zip', expect: 'ok' },
    { p: `${home}\\Documents\\relatório final ção.docx`, expect: 'ok', note: 'acentos' },
    { p: `${home}\\Videos\\Gravação de tela 2025.mp4`, expect: 'ok' },
    { p: `${home}\\Downloads\\ubuntu-24.04.iso`, expect: 'ok' },
    { p: `${home.replace(/\\/g, '/').toLowerCase()}/desktop/arquivo com espaços.txt`, expect: 'ok', note: 'barras normais + espaços' },
    { p: `${home}\\Documents\\Pasta Antiga`, expect: 'ok', note: 'subpasta pessoal' },
    { p: `${temp}\\arquivo-temporario.tmp`, expect: 'ok', note: 'temp do usuário' },
    { p: 'D:\\Velharia\\Windows Antigo\\x.txt', expect: 'ok', note: '"Windows" fora da raiz' },
    // ----- Avisos (userSelected) -----
    { p: `${home}\\Downloads\\ChromeSetup.exe`, expect: 'warn', note: 'instalador baixado' },
    { p: 'D:\\Ferramentas\\app.exe', expect: 'warn' },
    { p: 'D:\\Ferramentas\\biblioteca.dll', expect: 'warn' },
    { p: 'D:\\Drivers\\driver.sys', expect: 'warn' },
    { p: `${roaming}\\AlgumApp\\config.json`, expect: 'warn', note: 'AppData' },
    { p: `${local}\\Programs\\AlgumApp\\app.exe`, expect: 'warn', note: 'AppData + exe' },
    { p: `${home}\\.nuget\\packages\\x\\1.0\\x.nupkg`, expect: 'warn', note: 'pasta oculta do perfil' },
    // ----- cleanupTarget -----
    { p: `${temp}\\x.tmp`, ctx: 'cleanupTarget', roots: [temp], expect: 'ok' },
    { p: `${temp}\\sub\\y.log`, ctx: 'cleanupTarget', roots: [temp], expect: 'ok' },
    { p: temp, ctx: 'cleanupTarget', roots: [temp], expect: 'blocked', note: 'raiz do alvo' },
    { p: `${home}\\Documents\\x.docx`, ctx: 'cleanupTarget', roots: [temp], expect: 'blocked', note: 'fora da raiz' },
    { p: `${temp}\\..\\..\\Roaming\\x`, ctx: 'cleanupTarget', roots: [temp], expect: 'blocked', note: 'escapa com ..' },
    { p: `${temp}Extra\\x`, ctx: 'cleanupTarget', roots: [temp], expect: 'blocked', note: 'prefixo parecido' },
    { p: 'C:\\Windows\\Temp\\x.tmp', ctx: 'cleanupTarget', roots: ['C:\\Windows\\Temp'], expect: 'ok' },
    { p: 'C:\\Windows\\System32\\x.dll', ctx: 'cleanupTarget', roots: ['C:\\Windows'], expect: 'blocked', note: 'raiz inválida' },
    { p: 'C:\\algo\\x', ctx: 'cleanupTarget', roots: ['C:\\'], expect: 'blocked', note: 'raiz = disco' },
    { p: `${home}\\x.txt`, ctx: 'cleanupTarget', roots: [home], expect: 'blocked', note: 'raiz = perfil' },
    { p: `${local}\\Google\\x`, ctx: 'cleanupTarget', roots: [local], expect: 'blocked', note: 'raiz = AppData\\Local' },
    { p: `${home}\\Downloads\\setup.exe`, ctx: 'cleanupTarget', roots: [`${home}\\Downloads`], filtered: true, expect: 'ok', note: 'Downloads com filtro' },
    { p: `${home}\\Downloads\\setup.exe`, ctx: 'cleanupTarget', roots: [`${home}\\Downloads`], expect: 'blocked', note: 'Downloads sem filtro' },
    { p: 'C:\\Program Files (x86)\\Steam\\steamapps\\shadercache\\1\\x', ctx: 'cleanupTarget', roots: ['C:\\Program Files (x86)\\Steam\\steamapps\\shadercache'], expect: 'ok' },
    { p: 'C:\\Program Files (x86)\\Steam\\steam.exe', ctx: 'cleanupTarget', roots: ['C:\\Program Files (x86)\\Steam'], expect: 'blocked' },
    { p: path.join(targetRoot, 'lixo.tmp'), ctx: 'cleanupTarget', roots: [targetRoot], expect: 'ok', note: 'sandbox' },
    { p: path.join(junction, 'precioso.txt'), ctx: 'cleanupTarget', roots: [targetRoot], expect: 'blocked', note: 'atravessa junction' },
    { p: path.join(junction, 'precioso.txt'), expect: 'blocked', note: 'atravessa junction (user)' },
    { p: path.join(junctionRoot, 'lixo.tmp'), ctx: 'cleanupTarget', roots: [junctionRoot], expect: 'blocked', note: 'raiz é junction' },
    { p: 'C:\\Windows\\Temp\\x', ctx: 'cleanupTarget', expect: 'blocked', note: 'sem raízes registradas' }
  ]

  // 8.3 (só se o volume gera nomes curtos)
  let shortPF: string | null = null
  try {
    if (fs.realpathSync.native(`${sys}\\PROGRA~1`).toLowerCase().startsWith(`${sys.toLowerCase()}\\program files`)) shortPF = `${sys}\\PROGRA~1`
  } catch {
    shortPF = null
  }
  if (shortPF) {
    cases.push({ p: shortPF, expect: 'blocked', note: 'nome 8.3' })
    cases.push({ p: `${shortPF}\\Common Files\\x.dll`, expect: 'blocked', note: 'nome 8.3 + arquivo' })
    cases.push({ p: `${shortPF}\\naoexiste\\x.txt`, expect: 'blocked', note: 'nome 8.3 + caminho inexistente' })
  } else {
    console.log('AVISO: este volume não gera nomes 8.3; casos PROGRA~1 pulados.')
  }

  // 'C:\', o perfil, Documentos e Downloads como "pasta do programa" (InstallLocation mal preenchido) são ignorados.
  // Profundidade 1 vale para jogo/programa ("E:\Jogo Na Raiz"), não para nomes estruturais/temporários/de driver.
  setKnownAppDirs({
    games: ['D:\\Jogos Avulsos\\MeuJogo', 'C:\\', 'E:\\Jogo Na Raiz', 'D:\\Downloads', 'C:\\Temp', 'D:\\Program Files', 'E:\\'],
    programs: ['D:\\Programas\\Editor', `${home}\\Documents`, `${home}\\Downloads`, home, 'C:\\Programa Raiz', 'C:\\AMD', 'C:\\NVIDIA', 'C:\\Users', 'D:\\$Recycle.Bin']
  })
  {
    const k = getKnownAppDirs()
    assert(
      JSON.stringify(k.games) === JSON.stringify(['d:\\jogos avulsos\\meujogo', 'e:\\jogo na raiz']) && JSON.stringify(k.programs) === JSON.stringify(['d:\\programas\\editor', 'c:\\programa raiz']),
      `setKnownAppDirs: profundidade 1 só para jogo/programa (${JSON.stringify(k)})`
    )
  }

  console.log(`\n=== ${cases.length} casos de checkPath ===`)
  for (const c of cases) check(c)

  // ---------- checkTargetRoot ----------
  console.log('\n=== checkTargetRoot ===')
  const roots: [string, boolean, boolean | undefined][] = [
    [temp, true, undefined],
    [`${local}\\Temp`, true, undefined],
    ['C:\\Windows\\Temp', true, undefined],
    ['C:\\Windows\\SoftwareDistribution\\Download', true, undefined],
    ['C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportArchive', true, undefined],
    ['C:\\Windows\\Logs\\CBS', true, true],
    ['C:\\WINDOWS\\Logs\\CBS', true, true],
    ['C:\\Windows\\Logs', false, true],
    ['C:\\AMD', true, undefined],
    [`${local}\\Google\\Chrome\\User Data\\Default\\Cache\\Cache_Data`, true, undefined],
    ['C:\\Program Files (x86)\\Steam\\steamapps\\shadercache', true, undefined],
    ['D:\\SteamLibrary\\steamapps\\shadercache', true, undefined],
    [`${home}\\Downloads`, true, true],
    [`${home}\\Downloads`, false, undefined],
    ['C:\\Windows', false, undefined],
    ['C:\\Windows\\System32', false, undefined],
    ['C:\\', false, undefined],
    ['D:\\Jogos', false, undefined],
    [home, false, undefined],
    [local, false, undefined],
    [`${home}\\Documents`, false, undefined],
    ['C:\\Program Files', false, undefined],
    ['C:\\ProgramData', false, undefined],
    ['C:\\Users', false, undefined],
    [junctionRoot, false, undefined],
    [dataDir(), false, undefined],
    // R3: raízes da Busca extrema
    ['C:\\ProgramData\\NVIDIA Corporation\\Downloader\\591d2fefff406d921c4c18089e5045f4', true, undefined],
    ['C:\\ProgramData\\NVIDIA Corporation\\Downloader', true, undefined],
    ['C:\\ProgramData\\NVIDIA Corporation', false, undefined],
    ['D:\\SteamLibrary\\steamapps\\downloading', true, undefined],
    ['D:\\SteamLibrary\\steamapps\\temp', true, undefined],
    ['C:\\Program Files (x86)\\Steam\\steamapps\\downloading', true, undefined],
    ['C:\\Program Files (x86)\\Steam\\steamapps\\temp', true, undefined],
    ['D:\\SteamLibrary\\steamapps', false, undefined],
    ['D:\\SteamLibrary\\steamapps\\common', false, undefined],
    ['C:\\Program Files (x86)\\Steam\\steamapps\\common', false, undefined],
    ['C:\\Program Files (x86)\\Steam', false, undefined],
    ['D:\\Epic Games\\Fortnite\\.egstore\\bps', true, undefined],
    ['C:\\Program Files\\Epic Games\\Fortnite\\.egstore\\staging', true, undefined],
    ['D:\\Epic Games\\Fortnite\\.egstore', false, undefined],
    ['C:\\Program Files\\Epic Games\\Fortnite', false, undefined],
    [`${local}\\CapCut\\User Data\\Cache\\effect`, true, undefined],
    [`${roaming}\\Adobe\\Common\\Media Cache Files`, true, undefined],
    [`${home}\\.gradle\\caches`, true, undefined],
    [`${home}\\.cache\\huggingface\\hub`, true, undefined],
    [`${local}\\JetBrains\\IntelliJIdea2023.2\\caches`, true, undefined],
    [`${local}\\UnrealEngine\\Common\\DerivedDataCache`, true, undefined],
    ['E:\\PLAYERUNKNOWN\'S BATTLEGROUNDS', false, undefined],
    ['C:\\Windows\\System32\\DriverStore\\FileRepository', false, undefined],
    ['C:\\Windows\\WinSxS', false, undefined],
    ['C:\\$WINDOWS.~BT', false, undefined],
    ['C:\\Windows.old', false, undefined]
  ]
  for (const [r, expected, filtered] of roots) {
    const d = checkTargetRoot(r, { filtered })
    assert(d.allowed === expected, `checkTargetRoot(${show(r)}${filtered ? ', filtrado' : ''}) = ${d.allowed ? 'permitido' : 'bloqueado'} · ${d.reason}`)
  }

  // ---------- Raízes registradas ----------
  console.log('\n=== setCleanupRoots ===')
  const rejected = setCleanupRoots([{ path: temp }, { path: 'C:\\Windows' }, { path: 'C:\\' }])
  assert(rejected.length === 2, `setCleanupRoots rejeita raízes perigosas (${rejected.join(', ')})`)
  check({ p: `${temp}\\algum.tmp`, ctx: 'cleanupTarget', expect: 'ok', note: 'raiz registrada' })
  check({ p: 'C:\\Windows\\System32\\kernel32.dll', ctx: 'cleanupTarget', expect: 'blocked', note: 'raiz rejeitada' })
  check({ p: 'C:\\algo.txt', ctx: 'cleanupTarget', expect: 'blocked', note: 'raiz C:\\ rejeitada' })

  // ---------- Verificação lexical (motor) ----------
  console.log('\n=== checkPathLexical ===')
  assert(checkPathLexical(`${temp}\\a\\b.tmp`, 'cleanupTarget', [temp]).allowed, 'lexical: dentro da raiz')
  assert(!checkPathLexical(`${temp}`, 'cleanupTarget', [temp]).allowed, 'lexical: a raiz não')
  assert(!checkPathLexical('C:\\Windows\\System32\\x', 'cleanupTarget', ['C:\\Windows']).allowed, 'lexical: Windows nunca')
  if (shortPF) assert(!checkPathLexical(`${shortPF}\\x`, 'userSelected').allowed, 'lexical: nome 8.3 força verificação no disco')
  // R2: a raiz é validada com o MESMO filtro do alvo (Downloads só vale com filtro de nomes)
  assert(checkPathLexical(`${home}\\Downloads\\setup.exe`, 'cleanupTarget', [`${home}\\Downloads`], true).allowed, 'lexical: Downloads COM filtro libera o conteúdo (alvo de instaladores)')
  assert(!checkPathLexical(`${home}\\Downloads\\setup.exe`, 'cleanupTarget', [`${home}\\Downloads`]).allowed, 'lexical: Downloads SEM filtro continua bloqueado')

  // ---------- Normalização ----------
  console.log('\n=== normalizeWinPath / pathForDeletion ===')
  const n1 = normalizeWinPath('c:/users/../Windows./System32/')
  assert(n1.ok && n1.path === 'C:\\Windows\\System32', `normaliza "c:/users/../Windows./System32/" -> ${n1.ok ? n1.path : n1.reason}`)
  const n2 = normalizeWinPath('\\\\?\\d:\\Jogos\\x.txt')
  assert(n2.ok && n2.path === 'D:\\Jogos\\x.txt', `remove \\\\?\\ -> ${n2.ok ? n2.path : n2.reason}`)
  assert(!normalizeWinPath('\\\\srv\\c$').ok, 'rejeita UNC')
  const del = pathForDeletion(path.join(targetRoot, 'lixo.tmp'))
  assert(del !== null && del.toLowerCase() === path.join(targetRoot, 'lixo.tmp').toLowerCase(), `pathForDeletion sandbox -> ${del}`)
  assert(pathForDeletion(path.join(junction, 'precioso.txt')) === null, 'pathForDeletion recusa caminho por junction')
  if (shortPF) assert((pathForDeletion(`${shortPF}\\x.txt`) ?? '').toLowerCase().includes('program files'), 'pathForDeletion expande 8.3')

  // ---------- DEL-01: TEMP/TMP mal configurados nunca viram área de limpeza ----------
  console.log('\n=== DEL-01: variável TEMP mal configurada (só neste processo) ===')
  const savedEnv = { TEMP: process.env.TEMP, TMP: process.env.TMP }
  try {
    const badTemps = [local, home, `${home}\\Documents`, `${home}\\Desktop`, roaming, `${home}\\Downloads`, `${home}\\AppData`, 'C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData', 'C:\\Users', 'C:\\', 'D:\\', 'D:\\Jogos']
    for (const t of badTemps) {
      process.env.TEMP = t
      process.env.TMP = t
      resetGuardCaches()
      const child = `${t.replace(/\\$/, '')}\\Google\\Chrome\\User Data\\Default\\Login Data`
      assert(!isSaneTempRoot(t), `TEMP=${show(t)}: não é pasta de temporários sã`)
      assert(!checkTargetRoot(t).allowed, `TEMP=${show(t)}: checkTargetRoot bloqueia a pasta`)
      assert(!checkPathLexical(child, 'cleanupTarget', [t]).allowed, `TEMP=${show(t)}: motor (lexical) não libera ${show(child)}`)
    }
    // Com TEMP quebrado, um arquivo comum em AppData continua com o aviso de AppData (não vira "temporário")
    process.env.TEMP = local
    process.env.TMP = local
    resetGuardCaches()
    check({ p: `${local}\\AlgumApp\\config.json`, expect: 'warn', note: 'TEMP=%LOCALAPPDATA%: aviso de AppData mantido' })
    check({ p: `${local}\\Temp\\velho.tmp`, ctx: 'cleanupTarget', roots: [`${local}\\Temp`], expect: 'ok', note: 'TEMP quebrado: %LOCALAPPDATA%\\Temp continua limpável' })
    // Pastas "temp" de verdade continuam aceitas (inclusive rasas e fora do perfil)
    for (const t of ['D:\\Temp', 'E:\\tmp', 'D:\\Dados\\Temp', `${local}\\Temp\\2`, 'C:\\Windows\\Temp']) {
      process.env.TEMP = t
      process.env.TMP = t
      resetGuardCaches()
      assert(isSaneTempRoot(t) && checkTargetRoot(t).allowed, `TEMP=${show(t)}: pasta de temporários aceita`)
      assert(checkPathLexical(`${t}\\sub\\x.tmp`, 'cleanupTarget', [t]).allowed, `TEMP=${show(t)}: conteúdo liberado para o motor`)
    }
    // Pasta chamada "Temp" que é o PERFIL de um usuário (C:\Users\Temp) nunca é raiz
    process.env.TEMP = 'C:\\Users\\Temp'
    process.env.TMP = 'C:\\Users\\Temp'
    resetGuardCaches()
    assert(!checkTargetRoot('C:\\Users\\Temp').allowed, 'TEMP=C:\\Users\\Temp (perfil "Temp"): bloqueado')
    // TEMP = pasta de dados do próprio app: nunca é limpa
    process.env.TEMP = dataDir()
    process.env.TMP = dataDir()
    resetGuardCaches()
    assert(!checkTargetRoot(dataDir()).allowed && !checkPathLexical(path.join(dataDir(), 'state', 'scan.json'), 'cleanupTarget', [dataDir()]).allowed, 'TEMP=dados do app: bloqueado')
  } finally {
    process.env.TEMP = savedEnv.TEMP
    process.env.TMP = savedEnv.TMP
    resetGuardCaches()
  }
  assert(isSaneTempRoot(temp) && checkTargetRoot(temp).allowed, `TEMP real restaurado (${temp}) continua aceito`)

  // ---------- DEL-07: junction para \\?\Volume{GUID}\... (o lstat não a vê como link) ----------
  console.log('\n=== DEL-07: junction para volume GUID ===')
  const vjunc = path.join(sandbox, 'vjunc')
  let volume = ''
  try {
    volume = execFileSync('mountvol', [`${path.parse(sandbox).root.replace(/\\$/, '')}`, '/L'], { encoding: 'utf8', windowsHide: true }).trim()
  } catch {
    volume = ''
  }
  if (/^\\\\\?\\Volume\{/i.test(volume)) {
    execFileSync('cmd', ['/c', 'mklink', '/J', vjunc, volume + realDir.slice(3)], { stdio: 'ignore', windowsHide: true })
    const st = fs.lstatSync(vjunc)
    console.log(`  vjunc: lstat.isSymbolicLink=${st.isSymbolicLink()} (o libuv não reconhece) isDirectory=${st.isDirectory()}`)
    check({ p: vjunc, expect: 'blocked', note: 'DEL-07: a própria junction de volume' })
    check({ p: path.join(vjunc, 'precioso.txt'), expect: 'blocked', note: 'DEL-07: arquivo através da junction de volume' })
    assert(pathForDeletion(vjunc) === null && pathForDeletion(path.join(vjunc, 'precioso.txt')) === null, 'DEL-07: pathForDeletion recusa junction de volume')
    assert(!checkTargetRoot(vjunc).allowed, 'DEL-07: checkTargetRoot recusa junction de volume')
    assert(reparsePointIn(vjunc) !== null && reparsePointIn(realDir) === null, 'DEL-07: reparsePointIn acha a junction (e não acusa a pasta real)')
    const dry = await deleteContents(vjunc, { dryRun: true, guard: () => true })
    assert(dry.files === 0 && dry.errors.length === 1 && /atalho/.test(dry.errors[0]), `DEL-07: motor recusa raiz junction de volume (${dry.errors[0]})`)
    fs.rmdirSync(vjunc) // remove só o link
    assert(fs.existsSync(path.join(realDir, 'precioso.txt')), 'DEL-07: destino da junction de volume intacto')
  } else {
    console.log('AVISO: mountvol indisponível; casos de junction de volume pulados.')
  }

  // ---------- DEL-05: pastas conhecidas em Unicode (sem "�") ----------
  console.log('\n=== DEL-05: pastas conhecidas (registro em Unicode) ===')
  const simulated =
    '\uFEFFWindows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders]\r\n' +
    '"Desktop"="C:\\\\Users\\\\Usuário\\\\OneDrive\\\\Área de Trabalho"\r\n' +
    '"Personal"="C:\\\\Users\\\\Usuário\\\\OneDrive\\\\Documentos"\r\n' +
    '"{374DE290-123F-4565-9164-39C4925E467B}"="C:\\\\Users\\\\João \\"Zé\\"\\\\Downloads"\r\n' +
    '"Expandido"=hex(2):43,00,3a,00,5c,00,c1,00,72,00,65,00,61,00,00,00\r\n' +
    '"Longo"=hex(2):43,00,3a,00,5c,00,\\\r\n  54,00,00,00\r\n' +
    '\r\n[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders\\Sub]\r\n"Desktop"="NÃO"\r\n'
  const parsed = parseRegExport(Buffer.from(simulated, 'utf16le').toString('utf16le'))
  assert(parsed.get('desktop') === 'C:\\Users\\Usuário\\OneDrive\\Área de Trabalho', `parse .reg: Desktop com acentos (${parsed.get('desktop')})`)
  assert(parsed.get('personal') === 'C:\\Users\\Usuário\\OneDrive\\Documentos', 'parse .reg: Documentos')
  assert(parsed.get('{374de290-123f-4565-9164-39c4925e467b}') === 'C:\\Users\\João "Zé"\\Downloads', 'parse .reg: aspas e acento escapados')
  assert(parsed.get('expandido') === 'C:\\Área' && parsed.get('longo') === 'C:\\T', 'parse .reg: REG_EXPAND_SZ (hex(2)), inclusive em várias linhas')
  assert(parsed.size === 5, 'parse .reg: subchaves ignoradas')
  // No PC real: nada corrompido e igual ao que o PowerShell (Unicode) lê
  resetKnownFoldersCache()
  const kf = getKnownFolders()
  assert(kf.protectedDirs.length >= 5 && kf.protectedDirs.every((d) => !d.includes('\uFFFD')), `getKnownFolders: ${kf.protectedDirs.length} pastas, nenhuma com U+FFFD`)
  assert(Boolean(kf.downloads) && fs.existsSync(kf.downloads!), `getKnownFolders: Downloads existe (${kf.downloads})`)
  const shellKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders'
  const viaReg = readRegistryStrings(shellKey)
  const viaPs = await runPowerShellJson<Record<string, string>>(
    `$k = Get-Item -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders'; $o = [ordered]@{}; foreach ($n in $k.GetValueNames()) { if ($n) { $o[$n.ToLower()] = [string]$k.GetValue($n) } }; ConvertTo-Json -InputObject $o -Compress`
  )
  const diffs = Object.entries(viaPs).filter(([k, v]) => viaReg.get(k) !== v)
  assert(diffs.length === 0 && viaReg.size === Object.keys(viaPs).length, `Shell Folders igual ao PowerShell (${viaReg.size} valores; diferenças: ${diffs.map(([k]) => k).join(', ') || 'nenhuma'})`)
  const mui = readRegistryStrings('HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache')
  const accented = [...mui.values()].filter((v) => /[^\x00-\x7f]/.test(v))
  assert([...mui.values()].every((v) => !v.includes('\uFFFD')), `MuiCache (${mui.size} valores, ${accented.length} com acentos): nenhum U+FFFD${accented[0] ? ` · ex.: "${accented[0].slice(0, 50)}"` : ''}`)
  assert(fs.readdirSync(dataDir()).every((f) => !f.startsWith('reg-export-')), 'arquivo .reg temporário removido')

  // ---------- Garantia: o alvo da junction continua intacto ----------
  assert(fs.existsSync(path.join(realDir, 'precioso.txt')), 'arquivo real atrás da junction intacto')

  // Limpeza da sandbox: remove a junction (só o link) antes de apagar o resto
  fs.unlinkSync(junction)
  fs.unlinkSync(junctionRoot)
  fs.rmSync(sandbox, { recursive: true, force: true })

  console.log(`\nRESULTADO: ${pass} passaram, ${fail} falharam (total ${pass + fail}).`)
  if (fail) {
    console.log('\nFALHAS:\n' + failures.join('\n'))
    throw new Error(`${fail} asserts do guard falharam`)
  }
}
