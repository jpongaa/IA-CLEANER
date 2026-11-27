// Smoke SOMENTE LEITURA do domínio Jogos & Programas.
// Uso: npm run smoke -- apps            (--events mostra os eventos de progresso)
//      npx tsx --tsconfig tsconfig.node.json scripts/smoke/run.ts apps tracking   (só o acompanhamento de desinstalação)
// Nunca chama uninstall nem openLocation de verdade (abririam janelas/desinstaladores no PC): o acompanhamento de
// desinstalação é testado com registro/processos/launch FALSOS e arquivos num sandbox em %TEMP%\iacleaner-r3-apps-tracking.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAppsApi } from '../../src/main/apps'
import {
  appxMarker,
  buildProbeScript,
  combinePresence,
  findUninstallerProcesses,
  msiMarkers,
  packGuid,
  probeSystem,
  productCodeOf,
  resolveMarkers,
  steamappsOf,
  type Marker,
  type ProcInfo,
  type ProcWatch,
  type SystemProbeRequest,
  type SystemProbeResult
} from '../../src/main/apps/presence'
import { dataDirNames, modeFor, removeFromInventory, UninstallTracker, type TrackerDeps, type TrackerTimings } from '../../src/main/apps/track'
import type { LaunchOutcome } from '../../src/main/apps/uninstall'
import { isDirectory } from '../../src/main/apps/util'
import type { ActionLogEntry } from '../../src/shared/types/common'
import type { AppsInventory, ProgramInfo, UninstallTrack } from '../../src/shared/types/apps'
import { parseVdf, vnum, vobj, vstr } from '../../src/main/apps/vdf'
import { parseCommandLine, isAllowedUri, resolveSystemExe } from '../../src/main/apps/uninstall'
import { parseLibraryFolders } from '../../src/main/apps/steam'
import { parseGamingRoot, exeFromIcon } from '../../src/main/apps/launchers'
import { parseInstallDate, normPath } from '../../src/main/apps/util'
import { measureDir } from '../../src/main/apps/sizes'
import { findAccessBursts, isInstallerExe } from '../../src/main/apps/usage'
import { programsFromRegistry, programsFromStore } from '../../src/main/apps/programs'
import { formatBytes, formatDate, formatRelative } from '../../src/shared/format'
import type { GameInfo } from '../../src/shared/types/apps'
import { UNINSTALL_ROOTS } from '../../src/main/apps/presence'

function unitTests(): void {
  // VDF: formato novo, escapes, comentários, condicionais, chaves duplicadas, arquivo truncado
  const vdf = parseVdf(`"libraryfolders"
{
  // comentário
  "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" "apps" { "570" "123" } }
  "1" { "path" "D:\\\\SteamLibrary" [$WIN32] }
  "1" { "label" "dup" }
  unquoted value
  "broken" { "x" "1"`)
  assert.equal(vstr(vdf, 'libraryfolders', '0', 'path'), 'C:\\Program Files (x86)\\Steam')
  assert.equal(vnum(vdf, 'LIBRARYFOLDERS', '0', 'apps', '570'), 123)
  assert.equal(vstr(vdf, 'libraryfolders', '1', 'path'), 'D:\\SteamLibrary')
  assert.equal(vstr(vdf, 'libraryfolders', '1', 'label'), 'dup')
  assert.equal(vstr(vdf, 'libraryfolders', 'unquoted'), 'value')
  assert.equal(vstr(vobj(vdf, 'libraryfolders', 'broken'), 'x'), '1')
  // barra invertida não escapada é preservada
  assert.equal(vstr(parseVdf('"a" "C:\\Games\\x"'), 'a'), 'C:\\Games\\x')
  // formato antigo de libraryfolders
  assert.deepEqual(parseLibraryFolders('"LibraryFolders" { "TimeNextStatsReport" "1" "ContentStatsID" "2" "1" "E:\\\\Steam" }'), ['E:\\Steam'])

  // UninstallString
  const fake = (p: string): boolean => p === 'C:\\Program Files\\Foo Bar\\uninst.exe'
  assert.deepEqual(parseCommandLine('MsiExec.exe /I{5ECE0190-5997-4944-9F16-839A4326D404}'), { file: 'MsiExec.exe', args: '/X{5ECE0190-5997-4944-9F16-839A4326D404}' })
  assert.deepEqual(parseCommandLine('MsiExec.exe /X{ABC-1}'), { file: 'MsiExec.exe', args: '/X{ABC-1}' })
  assert.deepEqual(parseCommandLine('"C:\\Program Files (x86)\\Steam\\steam.exe" steam://uninstall/570'), {
    file: 'C:\\Program Files (x86)\\Steam\\steam.exe',
    args: 'steam://uninstall/570'
  })
  assert.deepEqual(parseCommandLine('C:\\Program Files\\Foo Bar\\uninst.exe /arg "x y"', fake), { file: 'C:\\Program Files\\Foo Bar\\uninst.exe', args: '/arg "x y"' })
  assert.deepEqual(parseCommandLine('"C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe" --lang=ptBR --uid=hs_beta --displayname="Hearthstone"'), {
    file: 'C:\\ProgramData\\Battle.net\\Agent\\Blizzard Uninstaller.exe',
    args: '--lang=ptBR --uid=hs_beta --displayname="Hearthstone"'
  })
  assert.equal(parseCommandLine('C:\\x\\unins000.exe').file, 'C:\\x\\unins000.exe')
  assert.ok(isAllowedUri('steam://uninstall/1') && isAllowedUri('ms-settings:appsfeatures') && !isAllowedUri('https://x') && !isAllowedUri('file:///c:/'))
  // URIs: formato exato (ids vindos de .acf/registro não levam espaços, '&', '..' ao launcher)
  assert.ok(isAllowedUri('uplay://uninstall/635') && isAllowedUri('com.epicgames.launcher://store'))
  for (const bad of ['steam://uninstall/10 & calc', 'steam://uninstall/30/../../run/9', 'steam://run/570', 'uplay://uninstall/../x', 'ms-settings:appsfeatures&x']) {
    assert.ok(!isAllowedUri(bad), bad)
  }
  // Pastas com colchetes/acentos/aspas: o executável sai literal (UNINST-WD-BRACKETS-03)
  const brk = (p: string): boolean => p === 'C:\\Jogos\\Mod [v2] (x64)\\unins000.exe'
  assert.deepEqual(parseCommandLine('C:\\Jogos\\Mod [v2] (x64)\\unins000.exe /LOG', brk), { file: 'C:\\Jogos\\Mod [v2] (x64)\\unins000.exe', args: '/LOG' })
  assert.deepEqual(parseCommandLine(`"C:\\Jogos\\O'Brien $x [1]\\unins000.exe" /x`), { file: "C:\\Jogos\\O'Brien $x [1]\\unins000.exe", args: '/x' })
  // msiexec/rundll32... "nus" vão para System32 (nunca PATH/pasta atual); outros nomes nus são recusados
  assert.match(resolveSystemExe('MsiExec.exe') ?? '', /\\System32\\msiexec\.exe$/i)
  assert.match(resolveSystemExe('powershell') ?? '', /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
  assert.equal(resolveSystemExe('notepad.exe'), undefined)

  // Diversos
  assert.equal(parseInstallDate('20240131'), '2024-01-31')
  assert.equal(parseInstallDate('4/27/2025'), '2025-04-27')
  assert.equal(parseInstallDate('27/04/2025'), '2025-04-27')
  assert.equal(parseInstallDate('lixo'), undefined)
  assert.equal(exeFromIcon('"C:\\Games\\X\\x.exe",0'), 'C:\\Games\\X\\x.exe')
  assert.equal(exeFromIcon('C:\\Windows\\Installer\\{A}\\icon.ico'), undefined)
  const gr = Buffer.concat([Buffer.from('RGBX', 'latin1'), Buffer.from([1, 0, 0, 0]), Buffer.from('XboxGames\0', 'utf16le')])
  assert.deepEqual(parseGamingRoot(gr), ['XboxGames'])
  assert.equal(normPath('c:/Program Files//X/'), 'c:\\program files\\x')

  // "último acesso": instaladores não contam; rajadas de leitura em massa são descartadas
  assert.ok(isInstallerExe('C:\\ProgramData\\Package Cache\\{A}\\vcredist_x64.exe'))
  assert.ok(isInstallerExe('C:\\Program Files (x86)\\X\\unins000.exe'))
  assert.ok(isInstallerExe('C:\\Program Files\\ASUS\\X\\ASUS-DriverHub-Installer.exe'))
  assert.ok(!isInstallerExe('C:\\Program Files\\Unity\\Editor\\Unity.exe'))
  const base = Date.UTC(2026, 9, 20, 21, 11)
  const times = [...Array.from({ length: 12 }, (_, i) => base + i * 20_000), base - 30 * 86_400_000, base - 3 * 86_400_000, base + 5 * 3_600_000]
  const burst = findAccessBursts(times)
  assert.equal(burst.size, 12)
  assert.ok(!burst.has(12) && !burst.has(13) && !burst.has(14))
  assert.equal(findAccessBursts([base, base + 1000, base + 2000]).size, 0)

  // Store: com atalhos do Menu Iniciar só entram os visíveis; sem eles, entram os da Store que não são infraestrutura
  const pk = (name: string, display?: string) => ({ name, pfn: `${name}_x`, signature: 'Store', display })
  assert.deepEqual(programsFromStore([pk('A.App', 'App A'), pk('B.Hidden')]).map((p) => p.name), ['App A'])
  assert.deepEqual(programsFromStore([pk('Spotify.Music'), pk('Microsoft.VCLibs.140')]).map((p) => p.id), ['store:Spotify.Music_x'])
  // Programas do registro: atualizações KB, componentes de sistema e entradas-filhas não entram
  const reg = (key: string, extra: Record<string, unknown>) => ({ hive: 'HKLM' as const, key, name: key, uninstall: 'x.exe', ...extra })
  assert.deepEqual(
    programsFromRegistry([reg('Prog', {}), reg('Update for X (KB5001234)', {}), reg('Sys', { system: 1 }), reg('Child', { parent: 'Prog' })]).map((p) => p.name),
    ['Prog']
  )
  console.log('testes unitários: OK')
}

// ================================================================ acompanhamento de desinstalação (sandbox)

const SANDBOX = path.join(os.tmpdir(), 'iacleaner-r3-apps-tracking')
const GB = 1024 ** 3
const MB = 1024 ** 2

function resetSandbox(): void {
  // Só a nossa pasta em %TEMP%
  assert.ok(SANDBOX.startsWith(os.tmpdir()) && SANDBOX.endsWith('iacleaner-r3-apps-tracking'))
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
}

function put(file: string, bytes = 16): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, Buffer.alloc(bytes, 7))
}

const uninstKey = (root: 'HKLM' | 'HKCU', key: string): string => `${root}|${UNINSTALL_ROOTS.find(([r]) => r === root)![1]}\\${key}`.toLowerCase()

/** Mundo FALSO: registro, pacotes da Store, processos e o "abrir desinstalador" são simulados; arquivos são do sandbox. */
class FakeWorld {
  clock = 1_900_000_000_000
  reg = new Set<string>()
  appx = new Set<string>()
  procs: ProcInfo[] = []
  launches: { value: string; kind: string; elevate: boolean }[] = []
  outcomes = new Map<string, LaunchOutcome>()
  forgotten: string[][] = []
  logs: Omit<ActionLogEntry, 'id' | 'timestamp'>[] = []
  events: UninstallTrack[] = []
  probes: SystemProbeRequest[] = []
  probeFails = false
  readonly tracksFile = path.join(SANDBOX, 'userData', 'apps', 'uninstall-tracks.json')
  readonly epicDir = path.join(SANDBOX, 'Epic', 'Manifests')

  constructor(public inv: AppsInventory) {}

  deps(): TrackerDeps {
    return {
      now: () => this.clock,
      sleep: async (ms) => {
        this.clock += ms
      },
      launch: async (m, o) => {
        this.launches.push({ value: m.value, kind: m.kind, elevate: o.elevate === true })
        return this.outcomes.get(m.value) ?? { started: true }
      },
      probeSystem: async (req) => {
        this.probes.push(req)
        if (this.probeFails) throw new Error('PowerShell indisponível (simulado)')
        return {
          reg: req.reg.map((q) => this.reg.has(`${q.root}|${q.path}`.toLowerCase())),
          appx: req.appx.map((a) => this.appx.has(a.pfn.toLowerCase())),
          processes: req.processes ? this.procs.map((p) => ({ ...p })) : null
        }
      },
      fileExists: async (p) => existsSync(p),
      exeDirPresent: async (p) => existsSync(p) && (await isDirectory(p)),
      dirExists: (p) => isDirectory(p),
      measure: async (p) => (await measureDir(p, { deadline: Date.now() + 10_000 })).bytes,
      resolveMarkers: (item, inv) => resolveMarkers(item, inv, { epicManifestsDir: this.epicDir }),
      getInventory: async () => this.inv,
      saveInventory: async (inv) => {
        this.inv = inv
      },
      forget: async (paths) => {
        this.forgotten.push(paths)
      },
      log: async (e) => {
        this.logs.push(e)
      },
      emit: (t) => {
        this.events.push(t)
      },
      loadTracks: async () => (existsSync(this.tracksFile) ? JSON.parse(readFileSync(this.tracksFile, 'utf8')) : []),
      saveTracks: async (list) => {
        mkdirSync(path.dirname(this.tracksFile), { recursive: true })
        writeFileSync(this.tracksFile, JSON.stringify(list), 'utf8')
      }
    }
  }
}

const P = {
  steamLib: () => path.join(SANDBOX, 'SteamLib'),
  steamGame: () => path.join(SANDBOX, 'SteamLib', 'steamapps', 'common', 'JogoTeste'),
  steamManifest: () => path.join(SANDBOX, 'SteamLib', 'steamapps', 'appmanifest_111.acf'),
  epicGame: () => path.join(SANDBOX, 'EpicGames', 'FakeEpic'),
  xboxGame: () => path.join(SANDBOX, 'XboxGames', 'Fake Xbox'),
  nsis: () => path.join(SANDBOX, 'Programs', 'NsisApp'),
  msi: () => path.join(SANDBOX, 'Programs', 'MsiApp'),
  shared: () => path.join(SANDBOX, 'Programs', 'Shared'),
  reboot: () => path.join(SANDBOX, 'Programs', 'RebootApp')
}
const MSI_GUID = '{A1B2C3D4-E5F6-4711-8899-AABBCCDDEEFF}'
const cmd = {
  steamProg: '"C:\\Program Files (x86)\\Steam\\steam.exe" steam://uninstall/111',
  nsis: () => `"${path.join(P.nsis(), 'uninst.exe')}"`,
  msi: `MsiExec.exe /I${MSI_GUID}`,
  shared: () => `"${path.join(P.shared(), 'unins000.exe')}"`,
  reboot: () => `"${path.join(P.reboot(), 'uninstall.exe')}"`,
  cancel: '"C:\\Program Files\\CancelApp\\uninstall.exe"',
  fail: '"C:\\Program Files\\FailApp\\uninstall.exe"',
  elev: '"C:\\Users\\x\\AppData\\Local\\ElevApp\\uninstall.exe"'
}

function regProgram(id: string, name: string, value: string, extra: Partial<ProgramInfo> = {}): ProgramInfo {
  const machine = id.startsWith('reg:HKLM')
  return {
    id,
    name,
    source: 'registry',
    scope: machine ? 'machine' : 'user',
    uninstall: { kind: 'command', value, label: 'Abrir desinstalador oficial', requiresAdmin: machine },
    ...extra
  }
}

function buildSandboxWorld(): FakeWorld {
  resetSandbox()
  put(P.steamManifest(), 300)
  put(path.join(P.steamGame(), 'game.exe'), 4096)
  put(path.join(P.steamGame(), 'data.pak'), 64 * 1024)
  put(path.join(P.steamGame(), 'saves', 'config.ini'), 1234)
  put(path.join(P.epicGame(), 'FakeEpic.exe'), 2048)
  mkdirSync(path.join(SANDBOX, 'Epic', 'Manifests'), { recursive: true })
  writeFileSync(path.join(SANDBOX, 'Epic', 'Manifests', 'ABC123.item'), JSON.stringify({ AppName: 'FakeEpic', InstallLocation: P.epicGame() }))
  put(path.join(SANDBOX, 'Epic', 'Manifests', 'OTHER.item'), 10) // inválido: ignorado
  put(path.join(P.xboxGame(), 'Content', 'MicrosoftGame.Config'), 500)
  put(path.join(P.nsis(), 'app.exe'), 8192)
  put(path.join(P.nsis(), 'uninst.exe'), 1024)
  put(path.join(P.msi(), 'msiapp.exe'), 4096)
  put(path.join(P.shared(), 'app.exe'), 100)
  put(path.join(P.shared(), 'Other', 'other.exe'), 100)
  put(path.join(P.reboot(), 'reboot.exe'), 100)
  // pasta de dados com o nome exato da chave, num "ProgramData" do sandbox (process.env.ProgramData é trocado no teste)
  put(path.join(SANDBOX, 'ProgramData', 'RebootApp', 'cache', 'big.bin'), 5000)

  const inv: AppsInventory = {
    collectedAt: new Date(1_900_000_000_000 - 3_600_000).toISOString(),
    durationMs: 10_000,
    launchers: [{ launcher: 'steam', installed: true, path: 'C:\\Steam', libraries: [P.steamLib()] }],
    leftovers: [],
    games: [
      {
        id: 'steam:111',
        launcher: 'steam',
        name: 'Jogo Steam Teste',
        installPath: P.steamGame(),
        drive: 'C:',
        bytes: 5 * GB,
        bytesSource: 'launcher',
        exists: true,
        programId: 'reg:HKLM:Steam App 111',
        uninstall: { kind: 'uri', value: 'steam://uninstall/111', label: 'Desinstalar pela Steam' }
      },
      {
        id: 'epic:FakeEpic',
        launcher: 'epic',
        name: 'Jogo Epic Teste',
        installPath: P.epicGame(),
        drive: 'C:',
        bytes: 2 * GB,
        bytesSource: 'launcher',
        exists: true,
        uninstall: { kind: 'launcher', value: 'C:\\Fake\\EpicGamesLauncher.exe', label: 'Desinstalar pela Epic Games', instructions: 'Biblioteca → … → Desinstalar.' }
      },
      {
        id: 'xbox:Fake.XboxGame',
        launcher: 'xbox',
        name: 'Jogo Xbox Teste',
        installPath: P.xboxGame(),
        drive: 'C:',
        bytes: 1 * GB,
        bytesSource: 'measured',
        exists: true,
        programId: 'store:Fake.XboxGame_8wekyb3d8bbwe',
        uninstall: { kind: 'settings', value: 'ms-settings:appsfeatures', label: 'Desinstalar pelas Configurações do Windows' }
      }
    ],
    programs: [
      regProgram('reg:HKLM:Steam App 111', 'Jogo Steam Teste', cmd.steamProg, { isGame: true, gameId: 'steam:111' }),
      regProgram('reg:HKCU:NsisApp', 'Programa NSIS Teste', cmd.nsis(), { installPath: P.nsis(), bytes: 300 * MB, bytesSource: 'registry' }),
      regProgram(`reg:HKLM:${MSI_GUID}`, 'Programa MSI Teste', cmd.msi, { installPath: P.msi(), bytes: 100 * MB, bytesSource: 'registry' }),
      regProgram('reg:HKCU:SharedApp', 'Programa Pasta Compartilhada', cmd.shared(), { installPath: P.shared(), bytes: 10 * MB }),
      regProgram('reg:HKCU:OtherApp', 'Outro Programa', '"C:\\x\\u.exe"', { installPath: path.join(P.shared(), 'Other') }),
      regProgram('reg:HKCU:RebootApp', 'Programa Que Pede Reinício', cmd.reboot(), { installPath: P.reboot(), bytes: 50 * MB }),
      regProgram('reg:HKLM:CancelApp', 'Programa UAC Cancelado', cmd.cancel),
      regProgram('reg:HKLM:FailApp', 'Programa Sem Desinstalador', cmd.fail),
      regProgram('reg:HKCU:ElevApp', 'Programa Que Exige Admin', cmd.elev),
      {
        id: 'store:Fake.StoreApp_abcdefgh12345',
        name: 'App da Store Teste',
        source: 'store',
        scope: 'user',
        uninstall: { kind: 'settings', value: 'ms-settings:appsfeatures', label: 'Desinstalar pelas Configurações do Windows' }
      },
      { id: 'store:Fake.XboxGame_8wekyb3d8bbwe', name: 'Jogo Xbox Teste', source: 'store', scope: 'user', isGame: true, gameId: 'xbox:Fake.XboxGame' }
    ]
  }
  const w = new FakeWorld(inv)
  for (const [root, key] of [
    ['HKLM', 'Steam App 111'],
    ['HKCU', 'NsisApp'],
    ['HKLM', MSI_GUID],
    ['HKCU', 'SharedApp'],
    ['HKCU', 'OtherApp'],
    ['HKCU', 'RebootApp'],
    ['HKLM', 'CancelApp'],
    ['HKLM', 'FailApp'],
    ['HKCU', 'ElevApp']
  ] as const)
    w.reg.add(uninstKey(root, key))
  for (const m of msiMarkers(MSI_GUID)) if (m.type === 'reg' && m.root === 'HKLM') w.reg.add(`${m.root}|${m.path}`.toLowerCase())
  w.appx.add('fake.storeapp_abcdefgh12345')
  w.appx.add('fake.xboxgame_8wekyb3d8bbwe')
  return w
}

const FAST: Partial<TrackerTimings> = {} // tempos padrão (3 s / 10 s / 20 s / 45 min) com relógio falso

function trackingUnitTests(): void {
  // GUID compactado do Windows Installer (valor conhecido do Office: {90120000-0011-0000-0000-0000000FF1CE})
  assert.equal(packGuid('{90120000-0011-0000-0000-0000000FF1CE}'), '00002109110000000000000000F01FEC')
  assert.equal(packGuid('nada'), undefined)
  assert.equal(productCodeOf('{90120000-0011-0000-0000-0000000ff1ce}', 'MsiExec.exe /X{90120000-0011-0000-0000-0000000FF1CE}'), '{90120000-0011-0000-0000-0000000FF1CE}')
  assert.equal(productCodeOf('NsisApp', '"C:\\x\\uninst.exe"'), undefined)
  assert.deepEqual(appxMarker('Microsoft.WindowsCalculator_8wekyb3d8bbwe'), { type: 'appx', name: 'Microsoft.WindowsCalculator', pfn: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe' })
  assert.equal(appxMarker('lixo'), undefined)
  assert.equal(steamappsOf('D:\\SteamLibrary\\steamapps\\common\\Jogo X'), 'D:\\SteamLibrary\\steamapps')
  assert.equal(combinePresence([false, null]), null)
  assert.equal(combinePresence([false, true]), true)
  assert.equal(combinePresence([false, false]), false)
  assert.equal(combinePresence([]), null)
  // modo: launchers que só repassam o pedido = esperar; desinstalador de verdade = acompanhar o processo
  const m = (value: string, kind: 'command' | 'uri' | 'settings' | 'launcher' = 'command') => modeFor({ kind, value, label: '' })
  assert.equal(m('"C:\\Program Files (x86)\\Steam\\steam.exe" steam://uninstall/570'), 'wait')
  assert.equal(m('"C:\\Riot Games\\Riot Client\\RiotClientServices.exe" --uninstall-product=valorant --uninstall-patchline=live'), 'wait')
  assert.equal(m('"C:\\Jogos\\X\\unins000.exe"'), 'process')
  assert.equal(m('MsiExec.exe /X{90120000-0011-0000-0000-0000000FF1CE}'), 'process')
  assert.equal(m('RunDll32 C:\\PROGRA~1\\NVIDIA~1\\Installer2\\InstallerCore\\NVI2.DLL,UninstallPackage ChatRTX'), 'process')
  assert.equal(m('steam://uninstall/1', 'uri'), 'wait')
  assert.equal(m('ms-settings:appsfeatures', 'settings'), 'wait')
  // o script de sondagem leva os dados como JSON literal (aspas simples dobradas), nunca como código
  const s = buildProbeScript({ reg: [{ root: 'HKCU', path: "Software\\X\\O'Brien $(calc)" }], appx: [], processes: false })
  assert.ok(s.includes("O''Brien $(calc)"))

  // processos: raiz, filhos (NSIS se copia para %TEMP% e sai), PID reaproveitado, navegador aberto pelo desinstalador
  const t0 = 1_000_000
  const w: ProcWatch = { startedAt: t0, rootPid: 100, rootExe: 'C:\\X\\uninst.exe', known: [] }
  const p = (pid: number, ppid: number, name: string, created: number, extra: Partial<ProcInfo> = {}): ProcInfo => ({ pid, ppid, name, created, ...extra })
  assert.deepEqual(findUninstallerProcesses(w, [p(100, 4, 'uninst.exe', t0 + 100)]).map((x) => x.pid), [100])
  // raiz saiu; filho Au_.exe continua
  assert.deepEqual(findUninstallerProcesses(w, [p(101, 100, 'Au_.exe', t0 + 900)]).map((x) => x.pid), [101])
  // neto (cópia em %TEMP% abre outro processo) e navegador "sentimos sua falta" (não conta)
  assert.deepEqual(
    findUninstallerProcesses(w, [p(101, 100, 'Au_.exe', t0 + 900), p(102, 101, 'helper.exe', t0 + 2000), p(103, 101, 'msedge.exe', t0 + 2100)]).map((x) => x.pid),
    [101, 102]
  )
  // PID 100 reaproveitado por outro programa (criado depois): nem ele nem os filhos dele contam
  assert.deepEqual(findUninstallerProcesses(w, [p(100, 7, 'game.exe', t0 + 60_000), p(150, 100, 'child.exe', t0 + 61_000)]).map((x) => x.pid), [])
  // desinstalador Inno/NSIS em %TEMP% sem ligação de pai (criado depois do início) conta; um antigo não
  assert.deepEqual(
    findUninstallerProcesses({ startedAt: t0, known: [] }, [p(300, 1, '_iu14D2N.tmp', t0 + 500), p(301, 1, 'unins000.exe', t0 - 3_600_000)]).map((x) => x.pid),
    [300]
  )
  // msiexec: só o do produto (o serviço "msiexec /V" fica aberto minutos e não pode segurar o "continua instalado")
  const wm: ProcWatch = { startedAt: t0, productCode: '{A1B2C3D4-E5F6-4711-8899-AABBCCDDEEFF}', known: [] }
  assert.deepEqual(
    findUninstallerProcesses(wm, [
      p(400, 600, 'msiexec.exe', t0 + 100, { cmd: 'C:\\Windows\\system32\\msiexec.exe /V' }),
      p(401, 600, 'msiexec.exe', t0 + 200, { cmd: 'MsiExec.exe -Embedding 1234 {a1b2c3d4-e5f6-4711-8899-aabbccddeeff}' })
    ]).map((x) => x.pid),
    [401]
  )

  // inventário: tira o jogo e a entrada de programa ligada, não mexe no original
  const inv = { collectedAt: '', games: [{ id: 'g', programId: 'p' }], programs: [{ id: 'p', gameId: 'g' }, { id: 'q' }], launchers: [] } as unknown as AppsInventory
  const out = removeFromInventory(inv, ['g'])
  assert.deepEqual([out.games.length, out.programs.map((x) => x.id)], [0, ['q']])
  assert.equal(inv.games.length, 1)
  assert.equal(removeFromInventory(inv, ['zzz']), inv)
  // pastas de dados candidatas a sobra: nome exato da chave/programa; GUIDs e nomes genéricos não
  assert.deepEqual(dataDirNames('BlueStacks', 'BlueStacks_nxt'), ['BlueStacks_nxt', 'BlueStacks'])
  assert.deepEqual(dataDirNames('NVIDIA ChatRTX 0.4', '{B2FE1952-0186-46C3-BAEC-A80AA35AC5B8}_ChatRTX'), ['NVIDIA ChatRTX 0.4', 'NVIDIA ChatRTX'])
  assert.deepEqual(dataDirNames('Hydra', '5c15b0c3-fe4f-5c4b-8f22-d37bfd0a3904'), ['Hydra'])
  assert.deepEqual(dataDirNames('Steam', 'Steam'), [])
  assert.deepEqual(dataDirNames('NVIDIA', 'x'), [])
  assert.deepEqual(dataDirNames('Meu App v2.1.0 (x64)', 'MeuApp_is1'), ['MeuApp', 'Meu App v2.1.0 (x64)', 'Meu App'])
  console.log('acompanhamento — testes unitários: OK')
}

async function trackingScenarioTests(): Promise<void> {
  const prevProgramData = process.env.ProgramData
  process.env.ProgramData = path.join(SANDBOX, 'ProgramData')
  try {
    await trackingScenarios()
  } finally {
    process.env.ProgramData = prevProgramData
  }
}

async function trackingScenarios(): Promise<void> {
  const w = buildSandboxWorld()
  const tr = new UninstallTracker(w.deps(), FAST)
  const tick = async (ms: number): Promise<void> => {
    w.clock += ms
    await tr.tick()
  }
  const rec = (id: string) => tr.inspect(id)!

  // ---------------- A) Steam (URI): waiting -> removed, sobras, inventário, Histórico
  const a = await tr.start('steam:111')
  assert.ok(a.started && a.trackId)
  assert.equal(rec(a.trackId!).status, 'waiting')
  assert.match(a.message, /Steam/)
  assert.deepEqual(w.launches.at(-1), { value: 'steam://uninstall/111', kind: 'uri', elevate: false })
  assert.deepEqual(rec(a.trackId!).markers, [{ type: 'file', path: P.steamManifest() }], 'Steam: só o manifesto conta (a chave "Steam App" pode sobrar)')
  await tick(3_000)
  assert.equal(rec(a.trackId!).status, 'waiting')
  rmSync(P.steamManifest())
  rmSync(path.join(P.steamGame(), 'game.exe'))
  rmSync(path.join(P.steamGame(), 'data.pak'))
  await tick(3_000)
  assert.equal(rec(a.trackId!).status, 'waiting', 'uma conferência só não confirma')
  await tick(1_500)
  const ta = rec(a.trackId!)
  assert.equal(ta.status, 'removed')
  assert.ok(!w.inv.games.some((g) => g.id === 'steam:111') && !w.inv.programs.some((p) => p.id === 'reg:HKLM:Steam App 111'), 'saiu do inventário (jogo + entrada ligada)')
  assert.deepEqual(ta.leftovers, [{ path: P.steamGame(), bytes: 1234 }])
  assert.equal(ta.bytesFreed, 5 * GB - 1234)
  assert.ok(w.inv.leftovers?.some((l) => l.id === `leftover:steam:${P.steamGame()}` && l.bytes === 1234), 'sobra da Steam entra no inventário')
  assert.ok(w.logs.some((l) => l.action === 'uninstall_confirmed' && l.bytesFreed === 5 * GB - 1234 && l.domain === 'apps'))
  assert.equal(w.events.at(-1)?.status, 'removed')
  assert.match(w.events.at(-1)!.message, /foi desinstalado e liberou .*Sobrou uma pasta/)
  assert.equal(w.forgotten.length, 0, 'a pasta ainda existe (sobra): nada a esquecer')
  console.log(`  A) Steam: waiting → removed · sobras ${formatBytes(1234)} · ${w.events.length} eventos · "${ta.message}"`)

  // ---------------- B) NSIS: running (raiz -> Au_.exe) -> stillInstalled -> admin -> removed
  w.outcomes.set(cmd.nsis(), { started: true, pid: 4100 })
  w.procs = [{ pid: 4100, ppid: 900, name: 'uninst.exe', created: w.clock + 50 }]
  const b = await tr.start('reg:HKCU:NsisApp')
  assert.equal(rec(b.trackId!).status, 'running')
  assert.equal(rec(b.trackId!).elevated, undefined)
  await tick(700)
  assert.equal(rec(b.trackId!).status, 'running')
  // já aberto: não abre outro
  const dup = await tr.start('reg:HKCU:NsisApp')
  assert.ok(!dup.started && dup.trackId === b.trackId && /já está aberto/.test(dup.message))
  assert.equal(w.launches.filter((l) => l.value === cmd.nsis()).length, 1)
  w.procs = [{ pid: 4101, ppid: 4100, name: 'Au_.exe', created: w.clock + 10 }]
  await tick(3_000)
  assert.equal(rec(b.trackId!).status, 'running')
  assert.equal(rec(b.trackId!).lastRunningAt, w.clock)
  w.procs = [{ pid: 4102, ppid: 4101, name: 'msedge.exe', created: w.clock + 10 }] // só a página "sentimos sua falta"
  await tick(3_000)
  await tick(3_000)
  assert.equal(rec(b.trackId!).status, 'running', 'ainda dentro dos 20 s de tolerância')
  await tick(15_000)
  const tb = rec(b.trackId!)
  assert.equal(tb.status, 'stillInstalled')
  assert.equal(tb.canRetryElevated, true)
  assert.match(tb.message, /continua instalado.*administrador/)
  const rb = await tr.recheck(b.trackId!)
  assert.equal(rb?.status, 'stillInstalled')
  assert.match(rb!.message, /^Conferimos de novo agora/)
  // Tentar de novo como administrador
  w.outcomes.set(cmd.nsis(), { started: true, pid: 4200, elevated: true })
  w.procs = [{ pid: 4200, ppid: 901, name: 'uninst.exe', created: w.clock + 30 }]
  const b2 = await tr.start('reg:HKCU:NsisApp', { elevated: true })
  assert.deepEqual(w.launches.at(-1), { value: cmd.nsis(), kind: 'command', elevate: true })
  assert.equal(rec(b2.trackId!).elevated, true)
  assert.equal((await tr.list()).filter((t) => t.itemId === 'reg:HKCU:NsisApp').length, 1, 'um cartão por item')
  await tick(700)
  w.reg.delete(uninstKey('HKCU', 'NsisApp'))
  rmSync(P.nsis(), { recursive: true, force: true })
  await tick(3_000)
  await tick(1_500)
  assert.equal(rec(b2.trackId!).status, 'running')
  assert.match(rec(b2.trackId!).message, /Quase lá/)
  w.procs = []
  await tick(1_500)
  const tb2 = rec(b2.trackId!)
  assert.equal(tb2.status, 'removed')
  assert.equal(tb2.bytesFreed, 300 * MB)
  assert.equal(tb2.leftovers, undefined)
  assert.deepEqual(w.forgotten.at(-1), [P.nsis()], 'Análise de Discos esquece a pasta que sumiu')
  assert.ok(!w.inv.programs.some((p) => p.id === 'reg:HKCU:NsisApp'))
  console.log(`  B) NSIS: running → stillInstalled (canRetryElevated) → admin → "Quase lá" → removed · esquecido ${P.nsis()}`)

  // ---------------- C) MSI: chave de desinstalação + registro do Windows Installer; msiexec do produto
  w.outcomes.set(cmd.msi, { started: true, pid: 4300, elevated: true })
  w.procs = [{ pid: 4300, ppid: 902, name: 'msiexec.exe', created: w.clock + 20, cmd: `msiexec.exe /X${MSI_GUID}` }]
  const c = await tr.start(`reg:HKLM:${MSI_GUID}`)
  const tc = rec(c.trackId!)
  assert.equal(tc.elevated, true)
  assert.equal(tc.watch?.productCode, MSI_GUID)
  assert.ok(tc.markers.some((m: Marker) => m.type === 'reg' && /Installer\\Products\\4D3C2B1A6F5E1174/i.test(m.path)), 'marcador do Windows Installer')
  await tick(700)
  // o cliente sai; o serviço (/V) fica; um msiexec "-Embedding ... {GUID}" trabalha
  w.procs = [
    { pid: 4301, ppid: 600, name: 'msiexec.exe', created: w.clock + 5, cmd: 'C:\\Windows\\system32\\msiexec.exe /V' },
    { pid: 4302, ppid: 600, name: 'msiexec.exe', created: w.clock + 6, cmd: `C:\\Windows\\syswow64\\MsiExec.exe -Embedding 99 ${MSI_GUID}` }
  ]
  w.reg.delete(uninstKey('HKLM', MSI_GUID)) // só a chave de desinstalação saiu: o Installer ainda tem o produto
  await tick(3_000)
  await tick(3_000)
  assert.equal(tc.status, 'running')
  assert.equal(tc.absentChecks, 0, 'registro do MSI ainda existe = instalado')
  for (const m of msiMarkers(MSI_GUID)) if (m.type === 'reg') w.reg.delete(`${m.root}|${m.path}`.toLowerCase())
  w.procs = [{ pid: 4301, ppid: 600, name: 'msiexec.exe', created: w.clock - 4_000, cmd: 'C:\\Windows\\system32\\msiexec.exe /V' }]
  await tick(3_000)
  await tick(1_500)
  assert.equal(tc.status, 'removed', 'o serviço msiexec /V não segura a conclusão')
  console.log('  C) MSI: só remove quando a chave E o registro do Windows Installer somem · msiexec /V ignorado')

  // ---------------- D/E) UAC cancelado, falha ao abrir, erro de elevação
  w.outcomes.set(cmd.cancel, { started: false, cancelled: true, error: 'Você cancelou a permissão de administrador. Nada foi alterado.', elevated: true })
  const d = await tr.start('reg:HKLM:CancelApp')
  assert.ok(!d.started && d.trackId)
  assert.equal(rec(d.trackId!).status, 'cancelled')
  w.outcomes.set(cmd.fail, { started: false, error: 'O desinstalador não existe mais (C:\\Program Files\\FailApp\\uninstall.exe). Tente pelas Configurações do Windows → Aplicativos.' })
  const e = await tr.start('reg:HKLM:FailApp')
  assert.equal(rec(e.trackId!).status, 'failed')
  assert.equal(rec(e.trackId!).canRetryElevated, undefined)
  w.outcomes.set(cmd.elev, { started: false, error: 'A operação solicitada requer elevação.' })
  const e2 = await tr.start('reg:HKCU:ElevApp')
  assert.equal(rec(e2.trackId!).status, 'failed')
  assert.equal(rec(e2.trackId!).canRetryElevated, true)
  console.log('  D/E) UAC cancelado → cancelled · desinstalador ausente → failed · "requer elevação" → failed + canRetryElevated')

  // ---------------- F) Store (Configurações): waiting -> timeout (45 min) -> "Conferir de novo" -> removed
  const f = await tr.start('store:Fake.StoreApp_abcdefgh12345')
  assert.equal(rec(f.trackId!).status, 'waiting')
  assert.match(f.message, /Configurações/)
  w.probeFails = true // PowerShell falhando não pode virar "removido"
  await tick(3_000)
  assert.equal(rec(f.trackId!).status, 'waiting')
  w.probeFails = false
  // 2 min a cada 3 s, depois a cada 10 s
  let ticks = 0
  while (rec(f.trackId!).status === 'waiting' && ticks < 1_000) {
    await tick(rec(f.trackId!).nextCheckAt - w.clock)
    ticks++
  }
  assert.equal(rec(f.trackId!).status, 'timeout')
  assert.ok(ticks > 280 && ticks < 330, `rodadas até 45 min: ${ticks}`)
  w.appx.delete('fake.storeapp_abcdefgh12345')
  const rf = await tr.recheck(f.trackId!)
  assert.equal(rf?.status, 'removed')
  console.log(`  F) Store: waiting → timeout após ${ticks} rodadas (3 s → 10 s) → "Conferir de novo" → removed`)

  // ---------------- G) Epic (manifesto .item) e H) Xbox (Content + pacote)
  const g = await tr.start('epic:FakeEpic')
  assert.deepEqual(rec(g.trackId!).markers, [{ type: 'file', path: path.join(w.epicDir, 'ABC123.item') }])
  assert.match(g.message, /Epic Games.*Biblioteca/)
  rmSync(path.join(w.epicDir, 'ABC123.item'))
  rmSync(P.epicGame(), { recursive: true, force: true })
  await tick(3_000)
  await tick(1_500)
  assert.equal(rec(g.trackId!).status, 'removed')
  assert.deepEqual(w.forgotten.at(-1), [P.epicGame()])
  const h = await tr.start('xbox:Fake.XboxGame')
  const hm = rec(h.trackId!).markers.map((m) => m.type).sort()
  assert.deepEqual(hm, ['appx', 'file'])
  rmSync(path.join(P.xboxGame(), 'Content'), { recursive: true, force: true })
  await tick(3_000)
  await tick(3_000)
  assert.equal(rec(h.trackId!).status, 'waiting', 'pacote ainda registrado')
  w.appx.delete('fake.xboxgame_8wekyb3d8bbwe')
  await tick(3_000)
  await tick(1_500)
  assert.equal(rec(h.trackId!).status, 'removed')
  assert.ok(!w.inv.programs.some((p) => p.id === 'store:Fake.XboxGame_8wekyb3d8bbwe'), 'entrada da Store ligada ao jogo também sai')
  console.log('  G/H) Epic (manifesto) e Xbox (Content + pacote) → removed')

  // ---------------- I) Persistência + "ao abrir o app": running (app fechou) e stillInstalled (pediu reinício)
  w.outcomes.set(cmd.reboot(), { started: true, pid: 4600 })
  w.procs = [{ pid: 4600, ppid: 903, name: 'uninstall.exe', created: w.clock + 10 }]
  const i1 = await tr.start('reg:HKCU:RebootApp')
  await tick(700)
  w.procs = []
  await tick(3_000)
  await tick(18_000)
  assert.equal(rec(i1.trackId!).status, 'stillInstalled')
  w.outcomes.set(cmd.shared(), { started: true, pid: 4500 })
  w.procs = [{ pid: 4500, ppid: 904, name: 'unins000.exe', created: w.clock + 10 }]
  const i2 = await tr.start('reg:HKCU:SharedApp')
  await tick(700)
  assert.equal(rec(i2.trackId!).status, 'running')
  tr.stop()
  // App fechado. Enquanto isso: o desinstalador terminou; o PC reiniciou e terminou de remover o outro.
  w.reg.delete(uninstKey('HKCU', 'SharedApp'))
  rmSync(path.join(P.shared(), 'app.exe'))
  w.reg.delete(uninstKey('HKCU', 'RebootApp'))
  w.procs = []
  w.clock += 10 * 60_000
  const saved = JSON.parse(readFileSync(w.tracksFile, 'utf8')) as { trackId: string; status: string }[]
  assert.ok(saved.some((t) => t.trackId === i2.trackId && t.status === 'running') && saved.some((t) => t.trackId === i1.trackId && t.status === 'stillInstalled'))
  const tr2 = new UninstallTracker(w.deps(), FAST)
  const listed = await tr2.list()
  assert.equal(listed.find((t) => t.trackId === i2.trackId)?.status, 'running')
  assert.equal(listed.find((t) => t.trackId === a.trackId)?.status, 'removed', 'histórico das últimas 24 h persiste')
  const evBefore = w.events.length
  await tr2.resume()
  await tr2.resume() // só uma vez
  assert.equal(tr2.inspect(i2.trackId!)?.status, 'removed')
  assert.equal(tr2.inspect(i2.trackId!)?.leftovers, undefined, 'pasta compartilhada com outro programa instalado não é sobra')
  assert.equal(tr2.inspect(i1.trackId!)?.status, 'removed', '"continua instalado" que saiu depois do reinício')
  // sobras: a pasta do programa + a pasta de dados com o nome exato da chave (ProgramData\RebootApp)
  assert.deepEqual(tr2.inspect(i1.trackId!)?.leftovers, [
    { path: P.reboot(), bytes: 100 },
    { path: path.join(SANDBOX, 'ProgramData', 'RebootApp'), bytes: 5000 }
  ])
  assert.equal(tr2.inspect(i1.trackId!)?.bytesFreed, 50 * MB - 5100)
  assert.ok(w.events.length - evBefore >= 2)
  console.log(`  I) persistência (${saved.length} acompanhamentos no arquivo) + conferência ao abrir: running→removed, stillInstalled→removed`)

  // ---------------- J) coleta lida antes da remoção não ressuscita o item; 24 h; dispensar
  const stale = { ...w.inv, collectedAt: new Date(w.clock - 3 * 3_600_000).toISOString(), durationMs: 5_000, programs: [...w.inv.programs, regProgram('reg:HKCU:NsisApp', 'Programa NSIS Teste', cmd.nsis())] }
  assert.ok(!tr2.filterRemoved(stale).programs.some((p) => p.id === 'reg:HKCU:NsisApp'))
  const fresh = { ...stale, collectedAt: new Date(w.clock + 60_000).toISOString() }
  assert.equal(tr2.filterRemoved(fresh), fresh)
  await tr2.dismiss(a.trackId!)
  assert.ok(!(await tr2.list()).some((t) => t.trackId === a.trackId))
  w.clock += 25 * 3_600_000
  assert.equal((await tr2.list()).length, 0, 'acompanhamentos com mais de 24 h somem')
  console.log('  J) coleta antiga filtrada · dispensar · limpeza de 24 h')
  console.log(`acompanhamento — cenários com registro/processos simulados: OK (${w.launches.length} aberturas FALSAS, ${w.probes.length} sondagens FALSAS)`)
}

/** Sondagem REAL, somente leitura: registro, Store e processos (inclui um filho de verdade que sobrevive ao pai). */
async function trackingRealProbeTests(): Promise<void> {
  const t0 = Date.now()
  const real = await probeSystem({
    reg: [
      { root: 'HKLM', path: 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall' },
      { root: 'HKCU', path: 'Software\\IACleanerChaveQueNaoExiste\\X' }
    ],
    appx: [{ name: 'Microsoft.WindowsCalculator', pfn: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe' }],
    processes: true
  })
  const ms = Date.now() - t0
  assert.deepEqual(real.reg, [true, false])
  assert.ok(real.processes && real.processes.length > 20)
  const me = real.processes!.find((p) => p.pid === process.pid)
  assert.ok(me && me.ppid > 0 && me.created && Math.abs(me.created - (Date.now() - process.uptime() * 1000)) < 60_000, 'processo atual com pai e hora de criação')
  console.log(`  sondagem real: ${ms} ms · ${real.processes!.length} processos · Calculadora instalada=${real.appx[0]}`)

  // Árvore de processos real e inofensiva: um PowerShell abre "ping localhost" e sai na hora (como o NSIS/Inno,
  // cujo original sai e deixa a cópia rodando). O acompanhamento precisa enxergar o ping como "desinstalador".
  const world = buildSandboxWorld()
  const regKey = uninstKey('HKCU', 'NsisApp')
  let pingSeen = false
  const deps: TrackerDeps = {
    ...world.deps(),
    now: () => Date.now(),
    sleep: (msx) => new Promise((r) => setTimeout(r, msx)),
    launch: async () => {
      const ps = spawn(
        path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', "Start-Process -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','5','127.0.0.1'"],
        { windowsHide: true, stdio: 'ignore' }
      )
      return { started: true, pid: ps.pid }
    },
    probeSystem: async (req) => {
      const r: SystemProbeResult = await probeSystem({ reg: [], appx: [], processes: req.processes })
      if (r.processes) {
        const t = trk.inspect(trackId)
        if (t?.watch && findUninstallerProcesses({ ...t.watch, known: [...t.watch.known] }, r.processes).some((p) => /^ping\.exe$/i.test(p.name))) pingSeen = true
      }
      return { reg: req.reg.map((q) => world.reg.has(`${q.root}|${q.path}`.toLowerCase())), appx: req.appx.map(() => null), processes: r.processes }
    },
    setTimer: (fn, msx) => {
      const hnd = setTimeout(fn, msx)
      return () => clearTimeout(hnd)
    }
  }
  assert.ok(world.reg.has(regKey))
  const trk = new UninstallTracker(deps, { fastMs: 800, slowMs: 800, idleGraceMs: 2_500, recheckGapMs: 200 })
  const started = Date.now()
  const r = await trk.start('reg:HKCU:NsisApp')
  const trackId = r.trackId!
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline && trk.inspect(trackId)!.status === 'running') await new Promise((res) => setTimeout(res, 300))
  trk.stop()
  const t = trk.inspect(trackId)!
  assert.equal(t.status, 'stillInstalled', `status final: ${t.status}`)
  assert.ok(pingSeen, 'o ping (filho que sobreviveu ao PowerShell) foi reconhecido como parte do desinstalador')
  const runFor = (t.lastRunningAt ?? 0) - started
  assert.ok(runFor >= 2_500, `ficou "rodando" enquanto o ping existia (${runFor} ms)`)
  console.log(`  árvore real (PowerShell → ping): filho reconhecido · "rodando" por ${(runFor / 1000).toFixed(1)} s · depois stillInstalled em ${((Date.now() - started) / 1000).toFixed(1)} s`)
}

/** Marcadores contra o inventário REAL (somente leitura): todo item instalado precisa aparecer como "instalado". */
async function trackingRealMarkers(inv: AppsInventory): Promise<void> {
  const items = [
    ...inv.games.map((g) => ({ id: g.id, name: g.name, item: { kind: 'game' as const, game: g } })),
    ...inv.programs.map((p) => ({ id: p.id, name: p.name, item: { kind: 'program' as const, program: p } }))
  ]
  const resolved: { id: string; name: string; markers: Marker[] }[] = []
  for (const it of items) resolved.push({ id: it.id, name: it.name, markers: await resolveMarkers(it.item, inv) })
  const regQ: SystemProbeRequest['reg'] = []
  const appxQ: SystemProbeRequest['appx'] = []
  for (const r of resolved)
    for (const m of r.markers) {
      if (m.type === 'reg') regQ.push({ root: m.root, path: m.path })
      if (m.type === 'appx') appxQ.push({ name: m.name, pfn: m.pfn })
    }
  const t0 = Date.now()
  const sys = await probeSystem({ reg: regQ, appx: appxQ, processes: false })
  const ms = Date.now() - t0
  let ri = 0
  let ai = 0
  const counts = { present: 0, absent: 0, unknown: 0, noMarkers: 0 }
  const absent: string[] = []
  for (const r of resolved) {
    const vals: (boolean | null)[] = []
    for (const m of r.markers) {
      if (m.type === 'reg') vals.push(sys.reg[ri++] ?? null)
      else if (m.type === 'appx') vals.push(sys.appx[ai++] ?? null)
      else if (m.type === 'file') vals.push(existsSync(m.path))
      else vals.push(await isDirectory(m.path))
    }
    if (!r.markers.length) counts.noMarkers++
    const v = combinePresence(vals)
    if (v === true) counts.present++
    else if (v === false) {
      counts.absent++
      absent.push(`${r.name} [${r.id}] ${JSON.stringify(r.markers)}`)
    } else counts.unknown++
  }
  const byType = new Map<string, number>()
  for (const r of resolved) for (const m of r.markers) byType.set(m.type, (byType.get(m.type) ?? 0) + 1)
  console.log(
    `\n=== Acompanhamento: marcadores do inventário real (${resolved.length} itens, ${regQ.length} chaves + ${appxQ.length} pacotes em ${ms} ms): ` +
      `instalados ${counts.present} · ausentes ${counts.absent} · sem saber ${counts.unknown} (sem marcador ${counts.noMarkers}) · tipos ${JSON.stringify(Object.fromEntries(byType))}`
  )
  for (const a of absent) console.log('  AUSENTE (seria um falso "desinstalado"): ' + a)
  for (const re of [/hydra/i, /ChatRTX/i, /BlueStacks/i]) {
    const r = resolved.find((x) => re.test(x.name))
    if (r) console.log(`  ${r.name}: ${r.id} → ${r.markers.length} marcador(es): ${r.markers.map((m) => (m.type === 'reg' ? `${m.root}\\…\\${m.path.split('\\').pop()}` : m.type)).join(', ')}`)
  }
  const sample = (prefix: string): void => {
    const r = resolved.find((x) => x.id.startsWith(prefix))
    if (r) console.log(`  exemplo ${prefix} ${r.name}: ${JSON.stringify(r.markers)}`)
  }
  sample('steam:')
  sample('xbox:')
  sample('store:')
  assert.equal(counts.absent, 0, 'item instalado com marcadores ausentes: seria marcado como desinstalado por engano')
}

function gameLine(g: GameInfo): string {
  const last = g.lastPlayed
    ? `${formatDate(g.lastPlayed)} (${formatRelative(g.lastPlayed)}${g.lastPlayedApprox ? ', aprox.' : ''}; ${g.lastPlayedSource})`
    : g.neverPlayed
      ? 'nunca jogado (Steam)'
      : `desconhecido${g.lastPlayedSource ? ' — ' + g.lastPlayedSource : ''}`
  const play = g.playtimeMinutes ? ` · ${(g.playtimeMinutes / 60).toFixed(1)} h jogadas` : ''
  const size = g.exists ? `${formatBytes(g.bytes)} [${g.bytesSource}]` : `PASTA NÃO EXISTE (launcher dizia ${formatBytes(g.reportedBytes)})`
  return `  ${g.name.padEnd(34).slice(0, 34)} ${g.drive.padEnd(3)} ${size.padEnd(26)} último: ${last}${play}`
}

export async function run(): Promise<void> {
  unitTests()

  console.log('\n=== Acompanhamento de desinstalação (registro/processos/launch simulados; arquivos no sandbox)')
  try {
    trackingUnitTests()
    await trackingScenarioTests()
    await trackingRealProbeTests()
  } finally {
    rmSync(SANDBOX, { recursive: true, force: true })
  }
  if (process.argv.includes('tracking')) return

  const api = createAppsApi()
  const t0 = Date.now()
  // --full: mede também as pastas de programas sem tamanho no registro (como o botão "Atualizar" da página)
  const full = process.argv.includes('--full')
  const inv = await api.getInventory({ refresh: true, computeSizes: full ? true : undefined })
  console.log(`\ninventário em ${((Date.now() - t0) / 1000).toFixed(1)} s (durationMs=${inv.durationMs})`)

  console.log('\n=== Launchers')
  for (const l of inv.launchers) console.log(`  ${l.launcher.padEnd(10)} instalado=${l.installed} ${l.path ?? ''} ${l.libraries?.length ? 'bibliotecas: ' + l.libraries.join(' | ') : ''}`)

  console.log('\n=== Unidades')
  for (const d of inv.drives ?? []) console.log(`  ${d.letter} ${d.mediaType}/${d.busType} livre ${formatBytes(d.freeBytes)} de ${formatBytes(d.totalBytes)}`)

  const byLauncher = new Map<string, GameInfo[]>()
  for (const g of inv.games) byLauncher.set(g.launcher, [...(byLauncher.get(g.launcher) ?? []), g])
  for (const [launcher, games] of byLauncher) {
    const total = games.reduce((s, g) => s + g.bytes, 0)
    console.log(`\n=== ${launcher}: ${games.length} jogo(s), ${formatBytes(total)}`)
    for (const g of games) console.log(gameLine(g))
  }

  const existing = inv.games.filter((g) => g.exists)
  const total = existing.reduce((s, g) => s + g.bytes, 0)
  const cutoff = Date.now() - 182 * 86_400_000
  const stale = existing.filter((g) => g.lastPlayed && g.lastPlayed < cutoff)
  console.log(
    `\nTOTAL: ${existing.length} jogos ocupando ${formatBytes(total)} · parados há 6+ meses: ${stale.length} (${formatBytes(stale.reduce((s, g) => s + g.bytes, 0))})`
  )

  console.log('\n=== Sobras de jogos desinstalados')
  for (const l of inv.leftovers ?? []) console.log(`  ${l.name.padEnd(36)} ${formatBytes(l.bytes).padEnd(10)} [${l.bytesSource}] ${l.path}`)

  console.log(`\n=== Programas: ${inv.programs.length} (${inv.programs.filter((p) => p.source === 'store').length} da Store, ${inv.programs.filter((p) => p.isGame).length} são jogos)`)
  console.log('Top 20 por tamanho:')
  for (const p of inv.programs.slice(0, 20)) {
    console.log(
      `  ${p.name.padEnd(44).slice(0, 44)} ${formatBytes(p.bytes).padEnd(9)} [${p.bytesSource ?? '-'}] inst ${p.installDate ?? '—'} · último uso ${p.lastUsed ? formatDate(p.lastUsed) + (p.lastUsedApprox ? '≈' : '') : '—'}${p.isGame ? ' · JOGO' : ''} · ${p.uninstall?.kind ?? 'sem desinstalador'}`
    )
  }
  const withUse = inv.programs.filter((p) => p.lastUsed).length
  const withSize = inv.programs.filter((p) => p.bytes).length
  console.log(`programas com último uso conhecido: ${withUse}/${inv.programs.length} · com tamanho: ${withSize}/${inv.programs.length}`)

  console.log('\n=== Fontes de último uso:', JSON.stringify(inv.usageSources))
  console.log('=== Avisos:')
  for (const w of inv.warnings ?? []) console.log('  - ' + w)

  // Verificações de sanidade contra a realidade
  assert.ok(inv.games.length > 0, 'nenhum jogo encontrado')
  assert.ok(inv.programs.length > 20, 'poucos programas encontrados')
  for (const g of inv.games) {
    assert.ok(g.id && g.name && g.uninstall?.kind, `jogo incompleto: ${g.id}`)
    assert.ok(Number.isFinite(g.bytes) && g.bytes >= 0)
    if (!g.exists) assert.equal(g.bytes, 0, `jogo sem pasta não pode ocupar espaço: ${g.id}`)
  }
  assert.ok(!inv.games.some((g) => g.id === 'steam:228980'), 'Steamworks Redistributables deveria ser ignorado')
  // Toda URI de desinstalação montada a partir dos dados reais passa na barreira de launchUninstall (formato exato)
  for (const m of [...inv.games.map((g) => g.uninstall), ...inv.programs.map((p) => p.uninstall)]) {
    if (m && (m.kind === 'uri' || m.kind === 'settings')) assert.ok(isAllowedUri(m.value), 'URI de desinstalação recusada: ' + m.value)
  }
  for (const p of inv.programs) assert.ok(!/\bKB\d{6,}\b/.test(p.name), 'atualização KB listada: ' + p.name)

  // Medidor x Steam: mede um jogo pequeno e compara com SizeOnDisk
  const small = existing.filter((g) => g.launcher === 'steam' && g.bytesSource === 'launcher' && !g.workshopBytes && g.bytes < 3 * 1024 ** 3).sort((a, b) => a.bytes - b.bytes)[0]
  if (small) {
    const m = await measureDir(small.installPath, { deadline: Date.now() + 60_000 })
    const diff = Math.abs(m.bytes - small.bytes) / small.bytes
    console.log(`\nmedidor x Steam (${small.name}): medido ${formatBytes(m.bytes)} (${m.files} arquivos) vs Steam ${formatBytes(small.bytes)} → diferença ${(diff * 100).toFixed(1)}%`)
    assert.ok(diff < 0.1, 'medição diverge muito do SizeOnDisk da Steam')
  }

  // Segunda chamada: refresh:false devolve o mesmo inventário em memória (rápido)
  const t1 = Date.now()
  const again = await api.getInventory({ refresh: false })
  assert.equal(again.collectedAt, inv.collectedAt)
  const last = await api.getLastInventory()
  assert.equal(last?.collectedAt, inv.collectedAt)
  console.log(`cache em memória: ${Date.now() - t1} ms`)

  // Acompanhamento contra o inventário real: nenhum item instalado pode parecer "desinstalado".
  await trackingRealMarkers(inv)
  assert.deepEqual(await api.getUninstallTracks(), [], 'o smoke não cria acompanhamentos (nunca desinstala)')
}
