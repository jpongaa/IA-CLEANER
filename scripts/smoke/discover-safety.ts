// Testes de SEGURANÇA da Busca Profunda — 100% em sandbox. TEM que passar 100%.
// Uso: npx tsx --tsconfig tsconfig.node.json scripts/smoke/run.ts discover-safety
//
// Cria uma árvore FALSA em %TEMP%\iacleaner-r3b-discover-fix\safety (ou %IACLEANER_TEST_DIR%\safety): Arquivos de
// Programas, ProgramData, AppData (Local/Roaming/LocalLow), Downloads, um "disco" com jogos, junctions, um banco do
// Hydra, zips reais; e injeta inventário/registro/serviços/processos FALSOS. Nada fora da sandbox é alterado:
//  - a "Lixeira" é uma pasta da sandbox (modo de teste do executor) e platform.trashItem é trocado;
//  - escritas no registro/tarefas são simuladas; nenhum UAC (o executor roda sem elevação em modo de teste);
//  - desinstaladores/Configurações/navegador NUNCA são abertos (funções trocadas por gravadores).
// O único registro lido de verdade é uma chave HKCU de desinstalação existente, exportada (LEITURA) para a sandbox.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import type { AppsInventory } from '../../src/shared/types/apps'
import type { DiscoverReport, Finding } from '../../src/shared/types/discover'
import type { RegistryData, RegUninstallEntry } from '../../src/main/apps/collect'
import { emptyRegistry, collectRegistry } from '../../src/main/apps/collect'
import { setAppPaths } from '../../src/main/core/paths'
import { platform } from '../../src/main/core/platform'
import { runPowerShellJson } from '../../src/main/core/powershell'
import { getLatest, setLatest } from '../../src/main/core/state'
import { getAction, listActions } from '../../src/main/core/actionLog'
import { setLeftoverRootsForTests, checkLeftoverPath } from '../../src/main/safety/leftoverGuard'
import { resetGuardCaches } from '../../src/main/safety/guard'
import { createDiscoverApi } from '../../src/main/discover'
import { setDiscoverProvidersForTests, type DiscoverEnv } from '../../src/main/discover/context'
import { setStartupTogglerForTests, setUninstallLauncherForTests, setUninstallTrackingForTests, type CustomUninstall } from '../../src/main/discover/actions'
import { buildOpsScript, runOps, setOpsTestMode, type OpsResult } from '../../src/main/discover/ops'
import { snappyDecompress, parseLog } from '../../src/main/discover/leveldb'
import { readZipListing } from '../../src/main/discover/zip'
import { readPeInfo } from '../../src/main/discover/pe'
import { assessOwnership, buildOwnershipData, expandShortPath, nameMatches } from '../../src/main/discover/ownership'
import { unpackMsiGuid, type SystemSignals } from '../../src/main/discover/signals'
import { programRootOf, resolveHealth, setDriveProbeForTests, uninstallTarget } from '../../src/main/discover/programs'
import { gameSignature } from '../../src/main/discover/games'
import { gameDirFromExe } from '../../src/main/discover/hydra'
import { isContainerName } from '../../src/main/discover/catalog'

const ROOT = process.env.IACLEANER_TEST_DIR ? path.resolve(process.env.IACLEANER_TEST_DIR) : path.join(os.tmpdir(), 'iacleaner-r3b-discover-fix')
const SB = path.join(ROOT, 'safety')

let pass = 0
let fail = 0
const failures: string[] = []
function check(label: string, ok: boolean, extra = ''): void {
  if (ok) pass++
  else {
    fail++
    failures.push(`${label}${extra ? ' :: ' + extra : ''}`)
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && extra ? '  ->  ' + extra : ''}`)
}

// ------------------------------------------------------------------------------------------- helpers de sandbox

function mustBeInSandbox(p: string): string {
  const r = path.resolve(p)
  if (!r.toLowerCase().startsWith(SB.toLowerCase() + '\\') && r.toLowerCase() !== SB.toLowerCase()) throw new Error('Fora da sandbox: ' + p)
  return r
}
function mkdir(p: string): string {
  fs.mkdirSync(mustBeInSandbox(p), { recursive: true })
  return p
}
function file(p: string, sizeOrText: number | string = 16): string {
  mkdir(path.dirname(p))
  if (typeof sizeOrText === 'string') fs.writeFileSync(mustBeInSandbox(p), sizeOrText)
  else {
    fs.writeFileSync(mustBeInSandbox(p), '')
    if (sizeOrText > 0) fs.truncateSync(p, sizeOrText)
  }
  return p
}
const MB = 1024 * 1024
const OLD = new Date(Date.now() - 400 * 86_400_000)
function age(p: string): void {
  // datas antigas em tudo dentro (arquivos e pastas), de baixo para cima
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) walk(full)
      fs.utimesSync(full, OLD, OLD)
    }
  }
  if (fs.statSync(p).isDirectory()) walk(p)
  fs.utimesSync(p, OLD, OLD)
}
function junction(link: string, target: string): void {
  mustBeInSandbox(link)
  mustBeInSandbox(target)
  mkdir(path.dirname(link))
  execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target], { stdio: 'ignore' })
}
function exists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}
/** Nome curto 8.3 de uma pasta da sandbox (LEITURA). '' se o disco não gera nomes curtos. */
function shortName(p: string): string {
  mustBeInSandbox(p)
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${p.replace(/'/g, "''")}').ShortPath`], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}
/** Uma letra de unidade que NÃO existe nesta máquina (HD externo "desconectado"). */
function missingDriveLetter(): string {
  for (const l of 'ZYXWVUTSRQPONM') if (!fs.existsSync(`${l}:\\`)) return l
  return 'Z'
}

/** Zip mínimo (armazenado, sem compressão) para os testes. */
function writeZip(zipPath: string, entries: { name: string; data: Buffer }[]): void {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const crc = zlib.crc32(e.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x800, 6)
    lh.writeUInt16LE(0, 8)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(e.data.length, 18)
    lh.writeUInt32LE(e.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    locals.push(lh, name, e.data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x800, 8)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(e.data.length, 20)
    ch.writeUInt32LE(e.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += 30 + name.length + e.data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  mkdir(path.dirname(zipPath))
  fs.writeFileSync(mustBeInSandbox(zipPath), Buffer.concat([...locals, cd, eocd]))
}

function varint(n: number): Buffer {
  const out: number[] = []
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return Buffer.from(out)
}
/** Log LevelDB mínimo (um registro FULL por lote). */
function leveldbLog(puts: { key: string; value: string }[]): Buffer {
  const parts: Buffer[] = []
  let seq = 1
  for (const p of puts) {
    const k = Buffer.from(p.key, 'utf8')
    const v = Buffer.from(p.value, 'utf8')
    const head = Buffer.alloc(12)
    head.writeUInt32LE(seq++, 0)
    head.writeUInt32LE(1, 8)
    const batch = Buffer.concat([head, Buffer.from([1]), varint(k.length), k, varint(v.length), v])
    const rec = Buffer.alloc(7)
    rec.writeUInt16LE(batch.length, 4)
    rec[6] = 1
    parts.push(rec, batch)
  }
  return Buffer.concat(parts)
}

// ------------------------------------------------------------------------------------------- montagem

interface World {
  env: DiscoverEnv
  PF: string
  PF86: string
  PD: string
  LA: string
  LP: string
  RA: string
  LL: string
  DL: string
  DESK: string
  DRIVE: string
  WIN: string
  BIN: string
  VICTIM: string
}

function build(): World {
  if (exists(SB)) fs.rmSync(mustBeInSandbox(SB), { recursive: true, force: true })
  const U = path.join(SB, 'Users', 'teste')
  const w: World = {
    PF: path.join(SB, 'Program Files'),
    PF86: path.join(SB, 'Program Files (x86)'),
    PD: path.join(SB, 'ProgramData'),
    LA: path.join(U, 'AppData', 'Local'),
    LP: path.join(U, 'AppData', 'Local', 'Programs'),
    RA: path.join(U, 'AppData', 'Roaming'),
    LL: path.join(U, 'AppData', 'LocalLow'),
    DL: path.join(U, 'Downloads'),
    DESK: path.join(U, 'Desktop'),
    DRIVE: path.join(SB, 'DiscoD'),
    WIN: path.join(SB, 'Windows'),
    BIN: path.join(SB, '_lixeira_falsa'),
    VICTIM: path.join(SB, 'VITIMA'),
    env: undefined as unknown as DiscoverEnv
  }
  for (const d of [w.PF, w.PF86, w.PD, w.LA, w.LP, w.RA, w.LL, w.DL, w.DESK, w.DRIVE, w.WIN, w.BIN, w.VICTIM]) mkdir(d)
  const S = 6 * MB // acima do limite da busca completa (5 MB)

  // --- programas instalados (registro falso)
  file(path.join(w.PF, 'OwnedApp', 'owned.exe'), S)
  file(path.join(w.PF, 'OwnedApp', 'unins000.exe'), 1000)
  file(path.join(w.PF, 'Contoso', 'Product A', 'a.exe'), S)
  file(path.join(w.PF, 'Contoso', 'Old Product', 'data.bin'), S)
  file(path.join(w.PF, 'BlueStacks_nxt', 'HD-Player.exe'), 1000)
  file(path.join(w.PD, 'BlueStacks_nxt', 'Engine', 'disk.vhd'), S)
  file(path.join(w.PF, 'Adobe', 'Photoshop', 'ps.exe'), 1000)
  file(path.join(w.RA, 'Adobe', 'CCX Welcome', 'cache.bin'), S)
  // --- em uso (serviço, processo, PATH, inicialização, tarefa) sem desinstalador
  file(path.join(w.PF, 'ServiceApp', 'svc.exe'), S)
  file(path.join(w.LA, 'RunningApp', 'run.exe'), S)
  file(path.join(w.LA, 'PathTool', 'bin', 'tool.exe'), S)
  file(path.join(w.RA, 'StartupApp', 'start.exe'), S)
  file(path.join(w.LA, 'TaskApp', 'task.exe'), S)
  // --- protegidos por nome/estrutura
  file(path.join(w.PF, 'Common Files', 'Shared', 'x.dll'), S)
  file(path.join(w.LA, 'Microsoft', 'Stuff', 'x.bin'), S)
  file(path.join(w.PD, 'Package Cache', '{1234}', 'setup.exe'), S)
  file(path.join(w.RA, 'IA Cleaner', 'settings.json'), S)
  file(path.join(w.LA, 'npm-cache', '_cacache', 'x.bin'), S)
  file(path.join(w.PF, 'Kaspersky Lab', 'avp.exe'), S)
  // --- sobras de verdade
  file(path.join(w.PD, 'OldGame Data', 'cache.bin'), S)
  file(path.join(w.PF, 'RemovedApp', 'removed.exe'), S)
  file(path.join(w.RA, 'OldTool', 'config', 'big.bin'), S)
  file(path.join(w.LL, 'OldStudio', 'OldGame', 'save.dat'), S)
  file(path.join(w.LA, 'someapp-updater', 'pending', 'someapp-setup.exe'), S)
  file(path.join(w.LP, 'HalfApp', 'half.exe'), S)
  file(path.join(w.PF, 'JustUninstalled', 'left.dat'), S)
  // --- junctions
  file(path.join(w.VICTIM, 'importante.txt'), 'NAO APAGAR')
  file(path.join(w.VICTIM, 'grande.bin'), S)
  junction(path.join(w.LA, 'JunctionLeftover'), w.VICTIM)
  file(path.join(w.PD, 'LeftoverWithJunction', 'data.bin'), S)
  junction(path.join(w.PD, 'LeftoverWithJunction', 'link'), w.VICTIM)
  mkdir(path.join(SB, 'realdir', 'child'))
  file(path.join(SB, 'realdir', 'child', 'x.bin'), S)
  junction(path.join(w.RA, 'viaJunction'), path.join(SB, 'realdir'))
  // --- programa indesejado
  file(path.join(w.LA, 'WaveBrowser', 'wave.exe'), S)
  file(path.join(w.LA, 'WaveBrowser', 'uninstall.exe'), 1000)

  // --- downloads
  file(path.join(w.DL, 'OwnedApp_Setup_1.2.3.exe'), 2 * MB)
  file(path.join(w.DL, 'NeverInstalledTool-setup-x64.exe'), 2 * MB)
  const packFiles = [
    { name: 'Pack/readme.txt', data: Buffer.from('ola mundo') },
    { name: 'Pack/sub/data.bin', data: Buffer.alloc(4096, 7) }
  ]
  writeZip(path.join(w.DL, 'Pack.zip'), packFiles)
  // extraído com "Extrair tudo" (pasta dupla)
  file(path.join(w.DL, 'Pack', 'Pack', 'readme.txt'), 'ola mundo')
  file(path.join(w.DL, 'Pack', 'Pack', 'sub', 'data.bin'), 4096)
  fs.writeFileSync(path.join(w.DL, 'Pack', 'Pack', 'sub', 'data.bin'), Buffer.alloc(4096, 7))
  // Google Drive: 2 partes, pastas com espaço no fim
  writeZip(path.join(w.DL, 'drive-download-20260101T000000Z-1-001.zip'), [{ name: 'Fotos /a.jpg', data: Buffer.alloc(3000, 1) }, { name: 'Videos /b.mp4', data: Buffer.alloc(5000, 2) }])
  writeZip(path.join(w.DL, 'drive-download-20260101T000000Z-1-002.zip'), [{ name: 'Fotos /c.jpg', data: Buffer.alloc(3500, 3) }])
  fs.writeFileSync(file(path.join(w.DL, 'Fotos', 'a.jpg')), Buffer.alloc(3000, 1))
  fs.writeFileSync(file(path.join(w.DL, 'Fotos', 'c.jpg')), Buffer.alloc(3500, 3))
  fs.writeFileSync(file(path.join(w.DL, 'Videos', 'b.mp4')), Buffer.alloc(5000, 2))
  // extração parcial (só metade dos bytes)
  writeZip(path.join(w.DL, 'Metade.zip'), [{ name: 'Metade/a.bin', data: Buffer.alloc(5000, 1) }, { name: 'Metade/b.bin', data: Buffer.alloc(5000, 2) }])
  fs.writeFileSync(file(path.join(w.DL, 'Metade', 'a.bin')), Buffer.alloc(5000, 1))
  // zip nunca extraído
  writeZip(path.join(w.DL, 'NaoExtraido.zip'), [{ name: 'x/y.txt', data: Buffer.from('abc') }])
  // repack de jogo
  file(path.join(w.DL, 'Cool Game [FitGirl Repack]', 'setup.exe'), 1000)
  file(path.join(w.DL, 'Cool Game [FitGirl Repack]', 'fg-01.bin'), S)
  // download incompleto antigo e imagem de disco
  file(path.join(w.DL, 'filme.mkv.crdownload'), S)
  file(path.join(w.DL, 'linux.iso'), 21 * MB)
  // --- jogos no "disco D:"
  file(path.join(w.DRIVE, 'Games', 'SpaceGame', 'SpaceGame.exe'), S)
  file(path.join(w.DRIVE, 'Games', 'SpaceGame', 'UnityPlayer.dll'), 1000)
  file(path.join(w.DRIVE, 'Games', 'SpaceGame', 'unins000.exe'), 1000)
  file(path.join(w.DRIVE, 'Games', 'PortableGame', 'Game.exe'), S)
  file(path.join(w.DRIVE, 'Games', 'PortableGame', 'steam_api64.dll'), 1000)
  file(path.join(w.DRIVE, 'Games', 'PortableGame', 'GameAssembly.dll'), 1000)
  file(path.join(w.DRIVE, 'Gravacoes', 'clip.DVR.mp4'), S)
  file(path.join(w.DRIVE, 'SteamLibrary', 'steamapps', 'common', 'LauncherGame', 'UnityPlayer.dll'), 1000)
  file(path.join(w.DRIVE, 'Games', 'HydraGame', 'Binaries', 'Win64', 'HydraGame-Win64-Shipping.exe'), S)
  // --- Hydra (banco LevelDB falso)
  const hydraData = path.join(w.RA, 'hydralauncher')
  file(path.join(w.LP, 'Hydra', 'Hydra.exe'), 1000)
  file(path.join(w.LP, 'Hydra', 'Uninstall Hydra.exe'), 1000)
  file(path.join(w.DL, 'Big Repack [FitGirl Repack]', 'setup.exe'), 1000)
  file(path.join(w.DL, 'Big Repack [FitGirl Repack]', 'fg-01.bin'), S)
  mkdir(path.join(hydraData, 'hydra-db'))
  fs.writeFileSync(
    path.join(hydraData, 'hydra-db', '000003.log'),
    leveldbLog([
      { key: '!games!steam:1', value: JSON.stringify({ title: 'Hydra Game', objectId: '1', shop: 'steam', executablePath: path.join(w.DRIVE, 'Games', 'HydraGame', 'Binaries', 'Win64', 'HydraGame-Win64-Shipping.exe'), playTimeInMilliseconds: 7_200_000, lastTimePlayed: '2025-01-01T00:00:00Z', isDeleted: false }) },
      { key: '!games!steam:2', value: JSON.stringify({ title: 'Big Repack', objectId: '2', shop: 'steam', executablePath: null, isDeleted: false }) },
      { key: '!games!steam:3', value: JSON.stringify({ title: 'Jogo Apagado', objectId: '3', shop: 'steam', executablePath: path.join(w.DRIVE, 'Games', 'Sumiu', 'x.exe'), isDeleted: false }) },
      { key: '!games!steam:367520', value: JSON.stringify({ title: 'Hollow Knight', objectId: '367520', shop: 'steam', executablePath: path.join(w.DRIVE, 'Jogos', 'Hollow Knight', 'hollow_knight.exe'), playTimeInMilliseconds: 3_600_000, isDeleted: false }) },
      { key: '!games!steam:233860', value: JSON.stringify({ title: 'Kenshi', objectId: '233860', shop: 'steam', executablePath: path.join(w.DRIVE, 'Jogos Hydra', 'Kenshi', 'kenshi_x64.exe'), isDeleted: false }) },
      { key: '!games!steam:999', value: JSON.stringify({ title: 'Outro', objectId: '999', shop: 'steam', executablePath: path.join(w.DRIVE, 'Jogos Hydra', 'Outro', 'Outro.exe'), isDeleted: false }) },
      // na biblioteca do Hydra sem .exe, mas instalado fora dele (D:\Games\RepackGame)
      { key: '!games!steam:4242', value: JSON.stringify({ title: 'RepackGame', objectId: '4242', shop: 'steam', executablePath: null, isDeleted: false }) },
      { key: '!downloads!steam:2', value: JSON.stringify({ shop: 'steam', objectId: '2', status: 'seeding', progress: 1, downloadPath: w.DL, folderName: 'Big Repack [FitGirl Repack]', fileSize: S, shouldSeed: true }) }
    ])
  )
  // =================== R3b (discover-fix): casos novos
  // 1) pastas-contêiner de jogos: X:\Jogos (2 jogos + saves), "Coisas" (2 jogos + fotos), "Jogos Hydra"
  file(path.join(w.DRIVE, 'Jogos', 'Hollow Knight', 'hollow_knight.exe'), S)
  file(path.join(w.DRIVE, 'Jogos', 'Hollow Knight', 'UnityPlayer.dll'), 1000)
  file(path.join(w.DRIVE, 'Jogos', 'Celeste', 'Celeste.exe'), S)
  file(path.join(w.DRIVE, 'Jogos', 'Celeste', 'steam_api64.dll'), 1000)
  file(path.join(w.DRIVE, 'Jogos', 'Celeste', 'saves', 'save.dat'), 'SAVE DO USUARIO')
  file(path.join(w.DRIVE, 'Coisas', 'GameA', 'GameA.exe'), S)
  file(path.join(w.DRIVE, 'Coisas', 'GameA', 'UnityPlayer.dll'), 1000)
  file(path.join(w.DRIVE, 'Coisas', 'GameB', 'GameB.exe'), S)
  file(path.join(w.DRIVE, 'Coisas', 'GameB', 'steam_api64.dll'), 1000)
  file(path.join(w.DRIVE, 'Coisas', 'GameB', 'GameAssembly.dll'), 1000)
  file(path.join(w.DRIVE, 'Coisas', 'fotos', 'viagem.jpg'), 'FOTO')
  file(path.join(w.DRIVE, 'Jogos Hydra', 'Kenshi', 'kenshi_x64.exe'), S)
  file(path.join(w.DRIVE, 'Jogos Hydra', 'Kenshi', 'steam_api64.dll'), 1000)
  file(path.join(w.DRIVE, 'Jogos Hydra', 'Outro', 'Outro.exe'), S)
  file(path.join(w.DRIVE, 'Jogos Hydra', 'Outro', 'UnityPlayer.dll'), 1000)
  // repack com desinstalador próprio e SEM entrada no registro (acompanhado via startCustom)
  file(path.join(w.DRIVE, 'Games', 'RepackGame', 'RepackGame.exe'), S)
  file(path.join(w.DRIVE, 'Games', 'RepackGame', 'UnityPlayer.dll'), 1000)
  file(path.join(w.DRIVE, 'Games', 'RepackGame', 'unins000.exe'), 1000)
  // 2) "remover à força" fora das áreas de programas: pastas do usuário na raiz do disco
  file(path.join(w.DRIVE, 'Obsidian', 'VJPPB', 'backup.bat'), 'echo backup')
  file(path.join(w.DRIVE, 'Obsidian', 'VJPPB', 'nota.md'), '# nota')
  file(path.join(w.DRIVE, 'Obsidian', 'ferramentas', 'sync-notas.exe'), 1000)
  file(path.join(w.DRIVE, 'Games', 'macros.ahk'), '; macro')
  file(path.join(w.DRIVE, 'ToolX', 'toolx.exe'), S)
  file(path.join(w.DRIVE, 'Downloads', 'App', 'app.exe'), 1000)
  file(path.join(w.DRIVE, 'Documentos', 'Prog', 'prog.exe'), 1000)
  file(path.join(w.DRIVE, 'Videos', 'player.exe'), 1000)
  for (let i = 0; i < 5; i++) file(path.join(w.DRIVE, 'PUBG', `clip${i}.mp4`), 1000)
  file(path.join(w.DRIVE, 'PUBG', 'tool.exe'), 1000)
  file(path.join(w.DRIVE, 'Backups', 'Old', 'old.exe'), 1000)
  file(path.join(w.DRIVE, 'Projeto', 'app.exe'), 1000)
  file(path.join(w.DRIVE, 'Projeto', '.git', 'HEAD'), 'ref: refs/heads/main')
  file(path.join(w.DRIVE, 'SemExe', 'data.bin'), 1000)
  file(path.join(w.DESK, 'AppNaArea', 'app.exe'), 1000)
  // 3) pastas RAIZ de fabricante com produto instalado (Opera, Adobe) e pasta com subpasta de algo instalado
  file(path.join(w.LP, 'Opera GX', 'opera.exe'), 1000)
  file(path.join(w.RA, 'Opera Software', 'Opera GX Stable', 'Login Data'), S)
  file(path.join(w.RA, 'Opera Software', 'Opera Stable', 'Bookmarks'), S)
  file(path.join(w.PD, 'Adobe', 'SLStore', 'lic.bin'), S)
  file(path.join(w.RA, 'Diversos', 'Product A', 'cfg.bin'), S)
  // 4) EA app instalado: ProgramData\EA Desktop e AppData\Local\EADesktop são dele
  file(path.join(w.PF, 'Electronic Arts', 'EA Desktop', 'EA Desktop', 'EALauncher.exe'), 1000)
  file(path.join(w.PF, 'Electronic Arts', 'EA Desktop', 'EA Desktop', 'EAUninstall.exe'), 1000)
  file(path.join(w.PD, 'EA Desktop', 'machine.ini'), S)
  file(path.join(w.LA, 'EADesktop', 'cache.bin'), S)
  // 6) programa instalado registrado com caminho 8.3 dentro da pasta de uma "suíte" com desinstalador quebrado
  file(path.join(w.PF, 'Contoso Suite', 'Product B', 'b.exe'), S)
  file(path.join(w.PF, 'Contoso Suite', 'readme.txt'), 'suite')
  // 7) ASUS: Armoury Crate instalado; ROGLSLoader/RLSDownload/Superset são componentes dele
  file(path.join(w.PF, 'ASUS', 'ARMOURY CRATE Service', 'ArmouryCrate.Service.exe'), 1000)
  file(path.join(w.PD, 'ASUS', 'ROGLSLoader', 'Armoury Crate Installer.exe'), S)
  file(path.join(w.PD, 'ASUS', 'RLSDownload', 'pkg.bin'), S)
  file(path.join(w.PD, 'ASUS', 'Superset', 'data.bin'), S)
  // 8) sobra cuja exclusão sem admin dá "acesso negado" (simulado no executor)
  file(path.join(w.RA, 'OldDenied', 'big.bin'), S)
  // componentes de programas instalados (nome do .exe dentro da pasta do programa): Link2EA (EA app), ludusavi (Hydra)
  file(path.join(w.PF, 'Electronic Arts', 'EA Desktop', 'EA Desktop', 'Link2EA.exe'), 1000)
  file(path.join(w.LA, 'Link2EA', 'cache', 'x.bin'), S)
  file(path.join(w.LP, 'Hydra', 'resources', 'ludusavi', 'ludusavi.exe'), 1000)
  file(path.join(w.RA, 'ludusavi', 'config.yaml'), S)

  // tudo "antigo" (sobras só contam se não mexidas há 30+ dias)
  for (const d of [w.PF, w.PF86, w.PD, w.LA, w.RA, w.LL, w.DL, w.DRIVE]) age(d)
  // pasta usada AGORA por algum programa (mexida hoje): nunca é sobra, nem na busca completa
  file(path.join(w.LA, 'RecentCef', 'User Data', 'CrashpadMetrics-active.pma'), S)

  w.env = {
    home: U,
    downloads: [w.DL],
    desktop: [w.DESK],
    documents: path.join(U, 'Documents'),
    programFiles: [w.PF, w.PF86],
    programData: w.PD,
    localAppData: w.LA,
    localPrograms: w.LP,
    appData: w.RA,
    localLow: w.LL,
    windir: w.WIN,
    driveRoots: [w.DRIVE + '\\'],
    hydraData,
    altLauncherDirs: []
  }
  return w
}

function regEntry(p: Partial<RegUninstallEntry> & { name: string; key: string }): RegUninstallEntry {
  return { hive: 'HKCU', publisher: null, version: '1.0', size: null, location: null, date: null, icon: null, uninstall: null, system: null, parent: null, release: null, noRemove: null, msi: null, ...p }
}

// ------------------------------------------------------------------------------------------- principal

export async function run(): Promise<void> {
  const w = build()
  const userData = path.join(ROOT, 'userData-safety')
  if (exists(userData)) fs.rmSync(userData, { recursive: true, force: true })
  setAppPaths({ userData, bin: path.resolve('resources', 'bin') })
  resetGuardCaches()
  setLeftoverRootsForTests({ programFiles: [w.PF, w.PF86], programData: [w.PD], localAppData: [w.LA], localPrograms: [w.LP], roaming: [w.RA], localLow: [w.LL], windows: [w.WIN], usersRoots: [path.join(SB, 'Users')], forceExtraRoots: [w.DRIVE], personalRoots: [w.DL, w.DESK] })
  const MISSING = missingDriveLetter()
  const shortB = shortName(path.join(w.PF, 'Contoso Suite', 'Product B'))

  // Uma chave HKCU REAL só para testar a EXPORTAÇÃO (leitura) do backup .reg — nunca é apagada (simulado).
  let realHkcuKey: string | null = null
  try {
    const real = await collectRegistry()
    realHkcuKey = real.uninstall.find((e) => e.hive === 'HKCU' && /^[\w .{}-]+$/.test(e.key))?.key ?? null
  } catch {
    realHkcuKey = null
  }

  const GUID_OK = '{11111111-2222-3333-4444-555555555555}'
  const GUID_GONE = '{99999999-8888-7777-6666-555555555555}'
  const registry: RegUninstallEntry[] = [
    regEntry({ name: 'Owned App', key: 'OwnedApp', location: path.join(w.PF, 'OwnedApp'), uninstall: `"${path.join(w.PF, 'OwnedApp', 'unins000.exe')}"`, hive: 'HKLM' }),
    regEntry({ name: 'Product A', key: 'ContosoA', publisher: 'Contoso Ltd', location: path.join(w.PF, 'Contoso', 'Product A'), uninstall: `"${path.join(w.PF, 'Contoso', 'Product A', 'a.exe')}" /uninstall`, hive: 'HKLM' }),
    regEntry({ name: 'BlueStacks', key: 'BlueStacks', publisher: 'now.gg', uninstall: `"${path.join(w.PF, 'BlueStacks_nxt', 'HD-Player.exe')}" -u`, hive: 'HKLM' }),
    regEntry({ name: 'Adobe Photoshop', key: 'PHSP', publisher: 'Adobe Inc.', location: path.join(w.PF, 'Adobe', 'Photoshop'), uninstall: `"${path.join(w.PF, 'Adobe', 'Photoshop', 'ps.exe')}" --uninstall`, hive: 'HKLM' }),
    regEntry({ name: 'Ghost App', key: realHkcuKey ?? 'GhostApp', uninstall: `"${path.join(w.PF, 'GhostApp', 'uninstall.exe')}"`, location: path.join(w.PF, 'GhostApp') }),
    regEntry({ name: 'Half App', key: 'HalfApp', location: path.join(w.LP, 'HalfApp'), uninstall: `"${path.join(w.LP, 'HalfApp', 'unins000.exe')}"` }),
    regEntry({ name: 'MSI Ghost', key: GUID_GONE, uninstall: `MsiExec.exe /X${GUID_GONE}`, hive: 'HKLM' }),
    regEntry({ name: 'MSI Ok', key: GUID_OK, uninstall: `MsiExec.exe /X${GUID_OK}`, hive: 'HKLM' }),
    regEntry({ name: 'Wave Browser', key: 'Wavesor', publisher: 'Wavesor Software', location: path.join(w.LA, 'WaveBrowser'), uninstall: `"${path.join(w.LA, 'WaveBrowser', 'uninstall.exe')}"` }),
    // 2ª entrada do Hydra (HKCU), cuja pasta já sumiu (desinstalado pela outra): vem ANTES da que funciona
    regEntry({ name: 'Hydra', key: '82b09a60-hydra-dup', location: path.join(w.LP, 'HydraVelho'), uninstall: `"${path.join(w.LP, 'HydraVelho', 'Uninstall Hydra.exe')}" /currentuser` }),
    regEntry({ name: 'Hydra', key: 'hydra-launcher', location: path.join(w.LP, 'Hydra'), uninstall: `"${path.join(w.LP, 'Hydra', 'Uninstall Hydra.exe')}" /currentuser` }),
    regEntry({ name: 'Opera GX Stable 137.0', key: 'Opera GX 137', publisher: 'Opera Software', location: path.join(w.LP, 'Opera GX'), uninstall: `"${path.join(w.LP, 'Opera GX', 'opera.exe')}" --uninstall` }),
    regEntry({ name: 'EA app', key: '{EA-APP}', publisher: 'Electronic Arts', hive: 'HKLM', uninstall: `"${path.join(w.PF, 'Electronic Arts', 'EA Desktop', 'EA Desktop', 'EAUninstall.exe')}"` }),
    regEntry({ name: 'ARMOURY CRATE Service', key: 'ArmouryCrateService', publisher: 'ASUSTeK COMPUTER INC.', hive: 'HKLM', location: path.join(w.PF, 'ASUS', 'ARMOURY CRATE Service'), uninstall: `"${path.join(w.PF, 'ASUS', 'ARMOURY CRATE Service', 'ArmouryCrate.Service.exe')}" -u` }),
    // jogo num HD externo desconectado (a unidade não existe agora)
    regEntry({ name: 'Jogo no HD externo', key: 'JogoExterno_is1', location: `${MISSING}:\\Jogos\\JogoExterno`, uninstall: `"${MISSING}:\\Jogos\\JogoExterno\\unins000.exe"` }),
    // programa instalado registrado com caminho 8.3, dentro da "suíte" cujo desinstalador sumiu
    ...(shortB ? [regEntry({ name: 'Product B', key: 'ContosoProductB', publisher: 'Contoso', hive: 'HKLM', location: shortB, uninstall: `"${shortB}\\b.exe" /uninstall` })] : []),
    regEntry({ name: 'Contoso Suite', key: 'ContosoSuite', publisher: 'Contoso', hive: 'HKLM', location: path.join(w.PF, 'Contoso Suite'), uninstall: `"${path.join(w.PF, 'Contoso Suite', 'uninstall.exe')}"` }),
    regEntry({ name: 'Space Game', key: 'SpaceGame_is1', location: path.join(w.DRIVE, 'Games', 'SpaceGame'), uninstall: `"${path.join(w.DRIVE, 'Games', 'SpaceGame', 'unins000.exe')}"` }),
    regEntry({ name: 'Kaspersky', key: 'KAV', location: path.join(w.PF, 'Kaspersky Lab'), uninstall: `"${path.join(w.PF, 'Kaspersky Lab', 'gone.exe')}"`, hive: 'HKLM' })
  ]
  let processes = [
    { pid: 999_001, name: 'run.exe', path: path.join(w.LA, 'RunningApp', 'run.exe') },
    { pid: 999_010, name: 'sync-notas.exe', path: path.join(w.DRIVE, 'Obsidian', 'ferramentas', 'sync-notas.exe') }
  ]
  const signals = (): SystemSignals => ({
    services: [{ name: 'ServiceApp', display: 'Service App', path: `"${path.join(w.PF, 'ServiceApp', 'svc.exe')}" -service`, startMode: 'Auto', state: 'Running', pid: 0, driver: false }],
    tasks: [
      { path: '\\', name: 'TaskApp Updater', exe: path.join(w.LA, 'TaskApp', 'task.exe'), enabled: true, autoStart: true, admin: false },
      { path: '\\', name: 'Backup das notas', exe: path.join(w.DRIVE, 'Obsidian', 'VJPPB', 'backup.bat'), enabled: true, autoStart: true, admin: false }
    ],
    startup: [
      { id: 'run:HKCU:StartupApp', name: 'StartupApp', command: `"${path.join(w.RA, 'StartupApp', 'start.exe')}" --tray`, target: path.join(w.RA, 'StartupApp', 'start.exe'), enabled: true, admin: false, location: 'Inicialização (usuário)' },
      { id: 'folder:user:Macros.lnk', name: 'Macros', command: `"${path.join(w.DRIVE, 'Games', 'macros.ahk')}"`, target: path.join(w.DRIVE, 'Games', 'macros.ahk'), enabled: true, admin: false, location: 'Pasta Inicializar (usuário)' },
      { id: 'run:HKCU:ToolX', name: 'ToolX', command: `"${path.join(w.DRIVE, 'ToolX', 'toolx.exe')}" --tray`, target: path.join(w.DRIVE, 'ToolX', 'toolx.exe'), enabled: true, admin: false, location: 'Inicialização (usuário)' }
    ],
    processes,
    appPaths: [],
    pathDirs: [path.join(w.LA, 'PathTool', 'bin')],
    msiProducts: [GUID_OK],
    folders: { downloads: w.DL, desktop: w.DESK },
    isAdmin: false,
    warnings: []
  })
  const inventory = (): AppsInventory => ({
    collectedAt: new Date().toISOString(),
    games: [
      {
        id: 'steam:1',
        launcher: 'steam',
        name: 'Launcher Game',
        installPath: path.join(w.DRIVE, 'SteamLibrary', 'steamapps', 'common', 'LauncherGame'),
        drive: 'D:',
        bytes: 0,
        exists: true,
        uninstall: { kind: 'uri', value: 'steam://uninstall/1', label: 'x' }
      }
    ],
    programs: [
      { id: 'reg:HKLM:OwnedApp', name: 'Owned App', installPath: path.join(w.PF, 'OwnedApp'), source: 'registry', scope: 'machine' },
      // inventário salvo há poucos minutos: o programa já saiu do registro (acabou de ser desinstalado)
      { id: 'reg:HKLM:JustUninstalled', name: 'Zzyzx Removido', installPath: path.join(w.PF, 'JustUninstalled'), source: 'registry', scope: 'machine' },
      // aparece em Jogos & Programas: a Busca Profunda desinstala pelo mesmo caminho de lá (acompanhado)
      { id: 'reg:HKCU:Wavesor', name: 'Wave Browser', installPath: path.join(w.LA, 'WaveBrowser'), source: 'registry', scope: 'user', uninstall: { kind: 'command', value: `"${path.join(w.LA, 'WaveBrowser', 'uninstall.exe')}"`, label: 'x' } }
    ],
    launchers: [{ launcher: 'ea', installed: true, path: path.join(w.PF, 'Electronic Arts', 'EA Desktop', 'EA Desktop') }]
  } as AppsInventory)
  setDiscoverProvidersForTests({
    env: async () => w.env,
    inventory: async () => inventory(),
    registry: async (): Promise<RegistryData> => ({ ...emptyRegistry('teste'), warnings: [], uninstall: registry }),
    signals: async () => signals(),
    msiInfo: async () => new Map()
  })
  const opsCalls: { elevated: boolean; script: string }[] = []
  const planOf = (script: string): { recycle?: { path: string }[] } | null => {
    const m = /FromBase64String\('([^']+)'\)/.exec(script)
    return m ? JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) : null
  }
  setOpsTestMode({ fakeBin: w.BIN, simulateSystemWrites: true }, async (script, elevated) => {
    opsCalls.push({ elevated, script })
    // "acesso negado" simulado: a sobra OldDenied só sai como administrador
    const denied = (planOf(script)?.recycle ?? []).filter((r) => /OldDenied/i.test(r.path))
    if (denied.length && !elevated) {
      return { ok: true, cancelled: false, started: true, data: { steps: denied.map((r) => ({ op: 'recycle' as const, target: r.path, ok: false, error: 'Acesso negado ao caminho.', code: 'error' })) } }
    }
    try {
      return { ok: true, cancelled: false, started: true, data: await runPowerShellJson<OpsResult>(script, { timeoutMs: 120_000 }) }
    } catch (e) {
      return { ok: false, cancelled: false, started: true, error: (e as Error).message }
    }
  })
  const launched: string[] = []
  setUninstallLauncherForTests(async (m) => {
    launched.push(`${m.kind}|${m.value}|${m.requiresAdmin ? 'admin' : 'user'}`)
    return { started: true }
  })
  // Desinstalações acompanhadas (Jogos & Programas): gravador, nada é aberto
  const tracked: { via: 'inventory' | 'custom'; id: string; elevated: boolean; spec?: CustomUninstall }[] = []
  let trackAnswer: { started: boolean; message: string } | null = null
  setUninstallTrackingForTests({
    async uninstall(id, elevated) {
      tracked.push({ via: 'inventory', id, elevated })
      return trackAnswer ?? { started: true, message: 'O desinstalador oficial está aberto (teste).', trackId: 't-inv' }
    },
    async startCustom(spec, elevated) {
      tracked.push({ via: 'custom', id: spec.itemId, elevated, spec })
      return trackAnswer ?? { started: true, message: 'O desinstalador oficial está aberto (teste).', trackId: 't-custom' }
    }
  })
  const toggled: string[] = []
  setStartupTogglerForTests({
    async disableItem(id) {
      toggled.push(id)
      return { ok: true, message: 'ok (teste)' }
    },
    async disableTask(p, n) {
      toggled.push(p + n)
      return { ok: true, message: 'ok (teste)' }
    }
  })
  const opened: string[] = []
  const realPlatform = { ...platform }
  platform.openExternal = async (u) => void opened.push('url:' + u)
  platform.showInExplorer = async (p) => void opened.push('explorer:' + p)
  platform.openPath = async (p) => void opened.push('open:' + p)
  let deniedTrash: string | null = null
  platform.trashItem = async (p) => {
    mustBeInSandbox(p)
    if (deniedTrash && p.toLowerCase() === deniedTrash.toLowerCase()) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    fs.renameSync(p, path.join(w.BIN, path.basename(p) + '-' + Math.random().toString(36).slice(2, 8)))
  }

  const kill: ChildProcess[] = []
  try {
    // =============================================================== unidades (sem disco)
    console.log('\n--- Unidades')
    check('unpackMsiGuid (Blender: B19CB0B46A92C8B46AB01645DFA33EDA)', unpackMsiGuid('B19CB0B46A92C8B46AB01645DFA33EDA') === '{4B0BC91B-29A6-4B8C-A60B-6154FD3AE3AD}', String(unpackMsiGuid('B19CB0B46A92C8B46AB01645DFA33EDA')))
    check('uninstallTarget: MSI não registrado = quebrado', uninstallTarget({ uninstall: `MsiExec.exe /X${GUID_GONE}` }, [GUID_OK]).kind === 'broken')
    check('uninstallTarget: MSI registrado = ok', uninstallTarget({ uninstall: `MsiExec.exe /I${GUID_OK}` }, [GUID_OK]).kind === 'ok')
    check('uninstallTarget: lista MSI vazia = não sabe (não acusa)', uninstallTarget({ uninstall: `MsiExec.exe /X${GUID_GONE}` }, []).kind === 'unknown')
    check('uninstallTarget: rundll32 confere a DLL', (() => {
      const t = uninstallTarget({ uninstall: '"C:\\WINDOWS\\SysWOW64\\RunDll32.EXE" "C:\\Program Files\\NVIDIA Corporation\\Installer2\\InstallerCore\\NVI2.DLL",UninstallPackage X' }, [])
      return t.kind === 'file' && /NVI2\.DLL$/i.test(t.file)
    })())
    check('uninstallTarget: steam:// não é acusado', uninstallTarget({ uninstall: '"C:\\Program Files (x86)\\Steam\\steam.exe" steam://uninstall/1' }, []).kind !== 'broken')
    check('nameMatches: BlueStacks_nxt ~ BlueStacks', nameMatches('BlueStacks_nxt', { name: 'BlueStacks' }))
    check('nameMatches: LogiShrd ~ Logitech (editora)', nameMatches('LogiShrd', { name: 'Logitech Options', publisher: 'Logitech' }))
    check('nameMatches: SupremaPoker !~ Steam', !nameMatches('SupremaPoker', { name: 'Steam', publisher: 'Valve Corporation' }))
    check('nameMatches: "Data" (genérico) nunca casa', !nameMatches('Data', { name: 'Data Studio' }))
    // snappy: literal "abcabcabc" = literal "abc" + cópia(offset 3, len 6)
    check('snappy: literal + cópia', snappyDecompress(Buffer.from([9, 0x08, 0x61, 0x62, 0x63, 0x09, 0x03])).toString() === 'abcabcabc')
    {
      const m = new Map()
      parseLog(leveldbLog([{ key: 'k1', value: 'v1' }, { key: 'k1', value: 'v2' }]), m)
      check('leveldb log: versão mais nova vence', m.get('k1')?.value?.toString() === 'v2')
    }
    {
      const z = await readZipListing(path.join(w.DL, 'drive-download-20260101T000000Z-1-001.zip'))
      check('zip: lê nomes e tira espaço do fim da pasta ("Fotos /a.jpg" -> "Fotos\\a.jpg")', Boolean(z && z.entries.some((e) => e.name === 'Fotos\\a.jpg')), JSON.stringify(z?.entries.map((e) => e.name)))
    }
    {
      const pe = await readPeInfo(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe'))
      check('PE: lê ProductName/CompanyName do notepad.exe (somente leitura)', Boolean(pe?.companyName && /microsoft/i.test(pe.companyName)), JSON.stringify(pe))
      check('PE: arquivo que não é PE -> null', (await readPeInfo(path.join(w.DL, 'linux.iso'))) === null)
    }
    check('assinatura de jogo: Unity', Boolean(await gameSignature(path.join(w.DRIVE, 'Games', 'SpaceGame'))))
    check('assinatura de jogo: gravações .mp4 não são jogo', (await gameSignature(path.join(w.DRIVE, 'Gravacoes'))) === null)

    // =============================================================== R3b: funções puras
    console.log('\n--- R3b: pasta do jogo, pasta do programa, unidade desconectada, nome 8.3')
    {
      const roots = ['C:\\Users\\usuario\\Downloads', 'C:\\', 'D:\\', 'E:\\']
      const cases: [string, string | undefined][] = [
        ['D:\\Jogos\\Hollow Knight\\hollow_knight.exe', 'D:\\Jogos\\Hollow Knight'],
        ['E:\\Jogos Hydra\\Kenshi\\bin\\kenshi_x64.exe', 'E:\\Jogos Hydra\\Kenshi'],
        ['C:\\Users\\usuario\\Desktop\\Jogo X\\x.exe', 'C:\\Users\\usuario\\Desktop\\Jogo X'],
        ['C:\\Users\\usuario\\Games\\Celeste\\Celeste.exe', 'C:\\Users\\usuario\\Games\\Celeste'],
        ['C:\\Program Files\\Jogo\\bin\\x.exe', 'C:\\Program Files\\Jogo'],
        ['D:\\Games\\Hydroneer\\Mining\\Binaries\\Win64\\x.exe', 'D:\\Games\\Hydroneer'],
        ['D:\\Hollow Knight\\hollow_knight.exe', 'D:\\Hollow Knight'],
        ['D:\\Jogos\\solto.exe', undefined]
      ]
      for (const [exe, want] of cases) check(`gameDirFromExe: ${exe} -> ${want ?? '(nenhuma: solto no contêiner)'}`, gameDirFromExe(exe, roots) === want, String(gameDirFromExe(exe, roots)))
      check('pasta-contêiner pelo nome: Jogos, "Jogos Hydra", Epic Games, Repacks; não: Hollow Knight, Jogo X', isContainerName('Jogos') && isContainerName('Jogos Hydra') && isContainerName('Epic Games') && isContainerName('Repacks') && !isContainerName('Hollow Knight') && !isContainerName('Jogo X'))
      const pr = (p: string): string | undefined => programRootOf(p, { env: w.env })
      check('programRootOf: tarefa .bat fora das áreas de programas -> nenhuma pasta', pr(path.join(w.DRIVE, 'Obsidian', 'VJPPB', 'backup.bat')) === undefined)
      check('programRootOf: atalho .ahk -> nenhuma pasta', pr(path.join(w.DRIVE, 'Games', 'macros.ahk')) === undefined)
      check('programRootOf: .exe fora das áreas -> só a pasta que contém o .exe', pr(path.join(w.DRIVE, 'ToolX', 'toolx.exe')) === path.join(w.DRIVE, 'ToolX'))
      check('programRootOf: .exe em subpasta -> a subpasta (nunca a de 1º nível)', pr(path.join(w.DRIVE, 'Obsidian', 'ferramentas', 'sync-notas.exe')) === path.join(w.DRIVE, 'Obsidian', 'ferramentas'))
      check('programRootOf: .exe solto na Área de Trabalho -> nenhuma pasta', pr(path.join(w.DESK, 'x.exe')) === undefined)
      check('programRootOf: .exe solto em pasta-contêiner (D:\\Games) -> nenhuma pasta', pr(path.join(w.DRIVE, 'Games', 'x.exe')) === undefined)
      const hz = await resolveHealth({ uninstall: `"${MISSING}:\\Jogos\\X\\unins000.exe"` }, [])
      check(`resolveHealth: unidade ${MISSING}: desconectada -> "não sei" (nunca "quebrado")`, hz.ok === null && /desconectada/.test(hz.why), JSON.stringify(hz))
      const missingOnC = { uninstall: `"${path.join(w.PF, 'NaoExiste', 'unins000.exe')}"` }
      setDriveProbeForTests(async () => 'removable')
      const hr = await resolveHealth(missingOnC, [])
      setDriveProbeForTests(async () => 'network')
      const hn = await resolveHealth(missingOnC, [])
      setDriveProbeForTests(null)
      const hf = await resolveHealth(missingOnC, [])
      check('resolveHealth: unidade removível/de rede -> "não sei"', hr.ok === null && hn.ok === null, JSON.stringify([hr, hn]))
      check('resolveHealth: disco fixo e arquivo sumiu -> quebrado', hf.ok === false, JSON.stringify(hf))
      if (shortB) {
        check(`nome 8.3 expandido (${path.basename(shortB)} -> Product B)`, expandShortPath(shortB).toLowerCase() === path.join(w.PF, 'Contoso Suite', 'Product B').toLowerCase(), expandShortPath(shortB))
        const d83 = buildOwnershipData({ registry, broadExtra: [w.PF, w.PF86, w.PD] })
        check('dono registrado com caminho 8.3 é reconhecido pelo caminho (Contoso Suite contém Product B)', assessOwnership(path.join(w.PF, 'Contoso Suite'), d83, { skipNameMatch: true, excludeOwnerIds: ['reg:HKLM:ContosoSuite'] }).owned)
      } else console.log('  (este disco não gera nomes 8.3: testes de 8.3 pulados)')
    }

    // =============================================================== guard das sobras
    console.log('\n--- leftoverGuard')
    const g = (p: string, mode: 'leftover' | 'force' = 'leftover'): boolean => checkLeftoverPath(p, { mode }).allowed
    check('guard: sobra em ProgramData liberada', g(path.join(w.PD, 'OldGame Data')))
    check('guard: ProgramData (raiz) bloqueada', !g(w.PD))
    check('guard: Arquivos de Programas (raiz) bloqueada', !g(w.PF))
    check('guard: Common Files bloqueada', !g(path.join(w.PF, 'Common Files')))
    check('guard: Common Files\\X bloqueada', !g(path.join(w.PF, 'Common Files', 'Shared')))
    check('guard: AppData\\Local\\Microsoft\\X bloqueada', !g(path.join(w.LA, 'Microsoft', 'Stuff')))
    check('guard: Package Cache bloqueada', !g(path.join(w.PD, 'Package Cache', '{1234}')))
    check('guard: pasta "IA Cleaner" bloqueada', !g(path.join(w.RA, 'IA Cleaner')))
    check('guard: pasta de dados do app (userData) bloqueada', !checkLeftoverPath(userData).allowed)
    check('guard: junction bloqueada', !g(path.join(w.LA, 'JunctionLeftover')))
    check('guard: caminho que passa por junction bloqueado', !g(path.join(w.RA, 'viaJunction', 'child')))
    check('guard: 3 níveis abaixo da área bloqueado (só pasta inteira)', !g(path.join(w.RA, 'OldTool', 'config', 'x')))
    check('guard: fora das áreas de programas bloqueado (Downloads)', !g(path.join(w.DL, 'Pack')))
    check('guard: "Windows" (sandbox) bloqueada', !g(path.join(w.WIN, 'System32')))
    check('guard: antivírus nunca à força', !g(path.join(w.PF, 'Kaspersky Lab'), 'force'))
    check('guard: pasta de jogo em outro disco pode ser removida à força', g(path.join(w.DRIVE, 'Games', 'PortableGame'), 'force'))
    check('guard: raiz da área extra nunca à força', !g(w.DRIVE, 'force'))
    check('guard: caminho relativo/estranho bloqueado', !g('..\\..\\Windows') && !g('C:') && !g('\\\\servidor\\c$\\x'))
    // R3b: "remover à força" fora das áreas de programas
    for (const [label, p] of [
      ['Downloads de outro disco', path.join(w.DRIVE, 'Downloads', 'App')],
      ['Documentos de outro disco', path.join(w.DRIVE, 'Documentos', 'Prog')],
      ['Vídeos', path.join(w.DRIVE, 'Videos')],
      ['pasta com gravações (5 vídeos)', path.join(w.DRIVE, 'PUBG')],
      ['pasta de backups', path.join(w.DRIVE, 'Backups', 'Old')],
      ['projeto de programação (.git)', path.join(w.DRIVE, 'Projeto')],
      ['pasta sem nenhum .exe', path.join(w.DRIVE, 'SemExe')],
      ['pasta dentro da Área de Trabalho', path.join(w.DESK, 'AppNaArea')],
      ['pasta-contêiner de jogos (D:\\Games)', path.join(w.DRIVE, 'Games')],
      ['pasta-contêiner "Jogos Hydra"', path.join(w.DRIVE, 'Jogos Hydra')]
    ] as const) {
      const d = checkLeftoverPath(p, { mode: 'force' })
      check(`guard (à força): bloqueia ${label}`, !d.allowed, d.reason)
    }
    check('guard (à força): programa portátil com .exe na raiz do disco continua liberado', g(path.join(w.DRIVE, 'ToolX'), 'force'), checkLeftoverPath(path.join(w.DRIVE, 'ToolX'), { mode: 'force' }).reason)
    for (const [label, p] of [
      ['Roaming\\Opera Software', path.join(w.RA, 'Opera Software')],
      ['ProgramData\\Adobe', path.join(w.PD, 'Adobe')],
      ['ProgramData\\ASUS', path.join(w.PD, 'ASUS')],
      ['Arquivos de Programas\\Electronic Arts', path.join(w.PF, 'Electronic Arts')]
    ] as const) {
      check(`guard (sobra e à força): raiz de fabricante bloqueada: ${label}`, !g(p) && !g(p, 'force'))
    }

    // =============================================================== ownership direto
    console.log('\n--- Donos')
    {
      const data = buildOwnershipData({ inventory: inventory(), registry, signals: signals(), broadExtra: [w.PF, w.PF86, w.PD, w.LA, w.LP, w.RA, w.LL, w.DL, w.DRIVE] })
      const own = (p: string): ReturnType<typeof assessOwnership> => assessOwnership(p, data)
      check('dono: InstallLocation', own(path.join(w.PF, 'OwnedApp')).owned)
      check('dono: pasta que CONTÉM um programa instalado (Contoso)', own(path.join(w.PF, 'Contoso')).owned)
      check('dono: nome parecido (ProgramData\\BlueStacks_nxt)', own(path.join(w.PD, 'BlueStacks_nxt')).owned)
      check('em uso: serviço', own(path.join(w.PF, 'ServiceApp')).inUse)
      check('em uso: processo aberto', own(path.join(w.LA, 'RunningApp')).inUse)
      check('em uso: PATH', own(path.join(w.LA, 'PathTool')).inUse)
      check('em uso: inicialização', own(path.join(w.RA, 'StartupApp')).inUse)
      check('em uso: tarefa agendada', own(path.join(w.LA, 'TaskApp')).inUse)
      check('sem dono: sobra de verdade', !own(path.join(w.PD, 'OldGame Data')).owned && !own(path.join(w.PD, 'OldGame Data')).inUse)
      check('pasta ampla (Arquivos de Programas) nunca vira "dono" de tudo', !assessOwnership(path.join(w.PD, 'OldGame Data'), buildOwnershipData({ registry: [regEntry({ name: 'X', key: 'x', location: w.PD })], broadExtra: [w.PD] })).owned)
    }

    // =============================================================== busca completa (somente leitura)
    const api = createDiscoverApi()
    const eqp = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
    console.log('\n--- Busca NORMAL na sandbox (pastas-contêiner)')
    {
      const normal: DiscoverReport = await api.scan({ deep: false })
      const nPath = (p: string): Finding[] => normal.findings.filter((f) => f.paths.some((x) => eqp(x, p)))
      check('normal: "D:\\Coisas" (2 jogos + fotos) NÃO vira "um jogo"', nPath(path.join(w.DRIVE, 'Coisas')).length === 0, JSON.stringify(nPath(path.join(w.DRIVE, 'Coisas')).map((f) => f.title)))
      check('normal: GameA e GameB aparecem separados', nPath(path.join(w.DRIVE, 'Coisas', 'GameA')).length === 1 && nPath(path.join(w.DRIVE, 'Coisas', 'GameB')).length === 1)
      check('normal: D:\\Jogos nunca é proposto; Hollow Knight (Hydra) e Celeste separados', nPath(path.join(w.DRIVE, 'Jogos')).length === 0 && nPath(path.join(w.DRIVE, 'Jogos', 'Hollow Knight'))[0]?.source === 'Hydra Launcher' && nPath(path.join(w.DRIVE, 'Jogos', 'Celeste')).length === 1)
    }
    console.log('\n--- Busca (deep) na sandbox')
    const before = fs.readdirSync(w.BIN).length
    const report: DiscoverReport = await api.scan({ deep: true })
    check('busca não moveu nada para a "Lixeira"', fs.readdirSync(w.BIN).length === before)
    check('busca não chamou o executor', opsCalls.length === 0)
    check('busca não abriu nada', launched.length === 0 && opened.length === 0)
    const byPath = (p: string, kind?: string): Finding | undefined =>
      report.findings.find((f) => (!kind || f.kind === kind) && f.paths.some((x) => x.toLowerCase() === p.toLowerCase()))
    const notListed = (p: string): boolean => !report.findings.some((f) => f.paths.some((x) => x.toLowerCase() === p.toLowerCase() || x.toLowerCase().startsWith(p.toLowerCase() + '\\')))
    // sobras
    check('sobra: ProgramData\\OldGame Data', Boolean(byPath(path.join(w.PD, 'OldGame Data'), 'leftoverFolder')))
    check('sobra: Arquivos de Programas\\RemovedApp (pede admin)', Boolean(byPath(path.join(w.PF, 'RemovedApp'), 'leftoverFolder')?.actions.some((a) => a.kind === 'deleteLeftovers' && a.requiresAdmin)))
    check('sobra: Roaming\\OldTool', Boolean(byPath(path.join(w.RA, 'OldTool'), 'leftoverFolder')))
    const ll = byPath(path.join(w.LL, 'OldStudio'), 'leftoverFolder')
    check('sobra: LocalLow\\OldStudio com aviso de saves', Boolean(ll?.warning && /save/i.test(ll.warning)))
    check('sobra: cache "-updater" = pode apagar', byPath(path.join(w.LA, 'someapp-updater'), 'leftoverFolder')?.verdict === 'safe')
    check('sobra (busca completa): pasta de fabricante com produto instalado (Adobe\\CCX Welcome) tem dono: não aparece', !byPath(path.join(w.RA, 'Adobe', 'CCX Welcome'), 'leftoverFolder'))
    // nunca listados como sobra
    for (const [label, p] of [
      ['programa instalado (InstallLocation)', path.join(w.PF, 'OwnedApp')],
      ['fabricante com produto instalado (Contoso)', path.join(w.PF, 'Contoso')],
      ['BlueStacks_nxt (BlueStacks instalado)', path.join(w.PD, 'BlueStacks_nxt')],
      ['pasta de serviço', path.join(w.PF, 'ServiceApp')],
      ['pasta com processo aberto', path.join(w.LA, 'RunningApp')],
      ['pasta no PATH', path.join(w.LA, 'PathTool')],
      ['Common Files', path.join(w.PF, 'Common Files')],
      ['AppData\\Local\\Microsoft', path.join(w.LA, 'Microsoft')],
      ['Package Cache', path.join(w.PD, 'Package Cache')],
      ['"IA Cleaner"', path.join(w.RA, 'IA Cleaner')],
      ['npm-cache (cache de ferramenta)', path.join(w.LA, 'npm-cache')],
      ['junction', path.join(w.LA, 'JunctionLeftover')],
      ['pasta com junction dentro', path.join(w.PD, 'LeftoverWithJunction')],
      ['vítima da junction', w.VICTIM],
      ['jogo de launcher (Steam)', path.join(w.DRIVE, 'SteamLibrary')]
    ] as const) {
      check(`nunca listado como sobra/apagável: ${label}`, notListed(p) || !report.findings.some((f) => f.kind === 'leftoverFolder' && f.paths.some((x) => x.toLowerCase().startsWith(p.toLowerCase()))))
    }
    // programas
    const ghost = report.findings.find((f) => f.kind === 'brokenUninstall' && /Ghost App/.test(f.title))
    check('desinstalador quebrado: entrada fantasma = pode apagar', ghost?.verdict === 'safe' && ghost.actions.some((a) => a.kind === 'removeBrokenEntry'))
    const half = report.findings.find((f) => f.kind === 'brokenUninstall' && /Half App/.test(f.title))
    check('desinstalador quebrado com pasta: oferece remover à força (perigoso)', Boolean(half?.actions.some((a) => a.kind === 'forceRemove' && a.dangerous && a.confirmWord === 'REMOVER')))
    check('MSI não registrado = quebrado', report.findings.some((f) => f.kind === 'brokenUninstall' && /MSI Ghost/.test(f.title)))
    check('MSI registrado não é acusado', !report.findings.some((f) => /MSI Ok/.test(f.title)))
    check('antivírus com desinstalador quebrado: nunca "remover à força"', !report.findings.some((f) => /Kaspersky/.test(f.title) && f.actions.some((a) => a.kind === 'forceRemove')))
    const startupApp = byPath(path.join(w.RA, 'StartupApp'))
    check('sem desinstalador + inicialização: tirar da inicialização e remover à força', Boolean(startupApp?.kind === 'noUninstaller' && startupApp.actions.some((a) => a.kind === 'disableStartup') && startupApp.actions.some((a) => a.kind === 'forceRemove')))
    const svcApp = byPath(path.join(w.PF, 'ServiceApp'))
    check('sem desinstalador com serviço: NÃO oferece remover à força', Boolean(svcApp && !svcApp.actions.some((a) => a.kind === 'forceRemove')))
    check('indesejado: Wave Browser', report.findings.some((f) => f.kind === 'unwanted' && /Wave/.test(f.title)))
    // downloads
    const inst = byPath(path.join(w.DL, 'OwnedApp_Setup_1.2.3.exe'))
    check('instalador de programa instalado = pode apagar', inst?.kind === 'downloadedInstaller' && inst.installState === 'installed' && inst.verdict === 'safe', JSON.stringify(inst && { s: inst.installState, v: inst.verdict, t: inst.title }))
    const inst2 = byPath(path.join(w.DL, 'NeverInstalledTool-setup-x64.exe'))
    check('instalador de algo não instalado = revisar', inst2?.installState === 'notInstalled' && inst2.verdict === 'review')
    const pack = byPath(path.join(w.DL, 'Pack.zip'))
    check('zip já extraído (pasta dupla do "Extrair tudo") = pode apagar', pack?.kind === 'archiveExtracted' && pack.verdict === 'safe')
    const gd = report.findings.find((f) => f.kind === 'archiveExtracted' && f.paths.length === 2 && f.paths.every((p) => /drive-download/i.test(p)))
    check('Google Drive: 2 partes agrupadas e conferidas', gd?.verdict === 'safe')
    check('zip extraído pela metade = revisar', byPath(path.join(w.DL, 'Metade.zip'))?.verdict === 'review')
    check('zip nunca extraído não aparece', !byPath(path.join(w.DL, 'NaoExtraido.zip')))
    check('pasta extraída nunca é oferecida para apagar', notListed(path.join(w.DL, 'Pack')) && notListed(path.join(w.DL, 'Fotos')))
    check('repack FitGirl = instalador de jogo', byPath(path.join(w.DL, 'Cool Game [FitGirl Repack]'))?.kind === 'gameRepack')
    check('download incompleto antigo = pode apagar', byPath(path.join(w.DL, 'filme.mkv.crdownload'))?.verdict === 'safe')
    check('imagem de disco', byPath(path.join(w.DL, 'linux.iso'))?.kind === 'diskImage')
    // jogos e Hydra
    const space = byPath(path.join(w.DRIVE, 'Games', 'SpaceGame'), 'orphanGame')
    check('jogo fora do launcher com desinstalador próprio -> abrir desinstalador', Boolean(space?.actions.some((a) => a.kind === 'runUninstaller') && !space.actions.some((a) => a.kind === 'recycle')))
    const portable = byPath(path.join(w.DRIVE, 'Games', 'PortableGame'), 'orphanGame')
    check('jogo portátil sem desinstalador -> Lixeira', Boolean(portable?.actions.some((a) => a.kind === 'recycle')))
    check('gravações (.mp4) não viram jogo', notListed(path.join(w.DRIVE, 'Gravacoes')))
    check('jogo da Steam (inventário) não aparece como órfão', !report.findings.some((f) => f.kind === 'orphanGame' && /LauncherGame/i.test(f.paths.join())))
    const hydra = report.findings.find((f) => f.kind === 'altLauncher' && /Hydra/.test(f.title))
    check('Hydra: launcher com lista do que baixou', Boolean(hydra?.items?.some((i) => /Hydra Game/.test(i.label) && i.exists) && hydra.items.some((i) => /Jogo Apagado/.test(i.label) && !i.exists)))
    check('Hydra: jogo instalado por ele aparece como jogo fora dos launchers', byPath(path.join(w.DRIVE, 'Games', 'HydraGame'), 'orphanGame')?.source === 'Hydra Launcher')
    const big = byPath(path.join(w.DL, 'Big Repack [FitGirl Repack]'), 'gameRepack')
    check('Hydra: download no disco com aviso de "seeding"', Boolean(big?.warning && /seeding/i.test(big.warning)))
    check('Hydra: download no disco com origem "Hydra Launcher"', big?.source === 'Hydra Launcher')

    // =============================================================== R3b: busca
    console.log('\n--- R3b: busca (deep)')
    const exact = (p: string): Finding[] => report.findings.filter((f) => f.paths.some((x) => eqp(x, p)))
    check('contêiner D:\\Jogos (2 jogos + saves) nunca é proposto', exact(path.join(w.DRIVE, 'Jogos')).length === 0, JSON.stringify(exact(path.join(w.DRIVE, 'Jogos')).map((f) => f.title)))
    check('Hollow Knight (Hydra) é um achado próprio: D:\\Jogos\\Hollow Knight', byPath(path.join(w.DRIVE, 'Jogos', 'Hollow Knight'), 'orphanGame')?.source === 'Hydra Launcher')
    check('Celeste aparece como jogo próprio (com os saves dele)', Boolean(byPath(path.join(w.DRIVE, 'Jogos', 'Celeste'), 'orphanGame')))
    check('"D:\\Coisas" (2 jogos + fotos) nunca é proposto; GameA/GameB separados', exact(path.join(w.DRIVE, 'Coisas')).length === 0 && Boolean(byPath(path.join(w.DRIVE, 'Coisas', 'GameA'))) && Boolean(byPath(path.join(w.DRIVE, 'Coisas', 'GameB'))))
    check('"Jogos Hydra" nunca é proposto; Kenshi e Outro (Hydra) separados', exact(path.join(w.DRIVE, 'Jogos Hydra')).length === 0 && byPath(path.join(w.DRIVE, 'Jogos Hydra', 'Kenshi'))?.source === 'Hydra Launcher' && byPath(path.join(w.DRIVE, 'Jogos Hydra', 'Outro'))?.source === 'Hydra Launcher')
    check('nenhum achado de jogo contém outro achado de jogo', !report.findings.some((a) => a.kind === 'orphanGame' && report.findings.some((b) => b !== a && b.kind === 'orphanGame' && b.paths.some((p) => a.paths.some((q) => p.toLowerCase().startsWith(q.toLowerCase() + '\\'))))))
    check('tarefa .bat do usuário (Obsidian): nenhum "remover à força"', !report.findings.some((f) => f.paths.some((p) => p.toLowerCase().startsWith(path.join(w.DRIVE, 'Obsidian').toLowerCase())) && f.actions.some((a) => a.kind === 'forceRemove')))
    check('atalho .ahk em D:\\Games: D:\\Games nunca é proposto', exact(path.join(w.DRIVE, 'Games')).length === 0)
    const toolx = byPath(path.join(w.DRIVE, 'ToolX'))
    check('programa portátil na inicialização: só a pasta do .exe, com tirar da inicialização e remover à força', toolx?.kind === 'noUninstaller' && toolx.actions.some((a) => a.kind === 'forceRemove') && toolx.actions.some((a) => a.kind === 'disableStartup'))
    for (const [label, p] of [
      ['EA app instalado: ProgramData\\EA Desktop', path.join(w.PD, 'EA Desktop')],
      ['EA app instalado: AppData\\Local\\EADesktop', path.join(w.LA, 'EADesktop')],
      ['ASUS\\ROGLSLoader (Armoury Crate instalado)', path.join(w.PD, 'ASUS', 'ROGLSLoader')],
      ['ASUS\\RLSDownload (Armoury Crate instalado)', path.join(w.PD, 'ASUS', 'RLSDownload')],
      ['ASUS\\Superset (Armoury Crate instalado)', path.join(w.PD, 'ASUS', 'Superset')],
      ['raiz de fabricante Opera Software', path.join(w.RA, 'Opera Software')],
      ['raiz de fabricante ProgramData\\Adobe', path.join(w.PD, 'Adobe')]
    ] as const) {
      check(`não é sobra: ${label}`, !report.findings.some((f) => f.kind === 'leftoverFolder' && f.paths.some((x) => eqp(x, p) || x.toLowerCase().startsWith(p.toLowerCase() + '\\') || p.toLowerCase().startsWith(x.toLowerCase() + '\\'))))
    }
    const ext = report.findings.filter((f) => /HD externo/.test(f.title))
    check(`HD externo (${MISSING}:) desconectado: entrada NÃO vira "fantasma, pode apagar"`, !ext.some((f) => f.verdict === 'safe' || f.actions.some((a) => a.kind === 'removeBrokenEntry')), JSON.stringify(ext.map((f) => f.verdict)))
    check('Hydra: launcher usa a entrada que funciona (abrir + desinstalar)', hydra?.relatedId === 'reg:HKCU:hydra-launcher' && hydra.actions.some((a) => a.kind === 'openLauncher') && hydra.actions.some((a) => a.kind === 'runUninstaller'), JSON.stringify({ rel: hydra?.relatedId, a: hydra?.actions.map((a) => a.kind) }))
    const dup = report.findings.find((f) => f.kind === 'brokenUninstall' && f.relatedId === 'reg:HKCU:82b09a60-hydra-dup')
    check('Hydra: a 2ª entrada (pasta já apagada) vira desinstalador quebrado com "tirar da lista"', dup?.verdict === 'safe' && dup.actions.some((a) => a.kind === 'removeBrokenEntry'))
    check('Hydra: biblioteca nos sub-itens do launcher (Hollow Knight, Kenshi, Outro)', ['Hollow Knight', 'Kenshi', 'Outro'].every((t) => hydra?.items?.some((i) => i.label.includes(t) && i.exists)))
    for (const [label, p] of [
      ['AppData\\Local\\Link2EA (Link2EA.exe é do EA app instalado)', path.join(w.LA, 'Link2EA')],
      ['AppData\\Roaming\\ludusavi (ludusavi.exe vem dentro do Hydra instalado)', path.join(w.RA, 'ludusavi')],
      ['pasta mexida hoje (em uso por algum programa)', path.join(w.LA, 'RecentCef')]
    ] as const) {
      check(`não é sobra: ${label}`, !report.findings.some((f) => f.kind === 'leftoverFolder' && f.paths.some((x) => eqp(x, p))))
    }
    const rgItem = hydra?.items?.find((i) => i.label === 'Jogo: RepackGame')
    check('Hydra: jogo da biblioteca instalado FORA do Hydra aparece como instalado (com a pasta)', Boolean(rgItem?.exists && /instalado em/.test(rgItem.note ?? '') && eqp(rgItem.path ?? '', path.join(w.DRIVE, 'Games', 'RepackGame'))), JSON.stringify(rgItem))
    const suite = report.findings.find((f) => f.kind === 'brokenUninstall' && /Contoso Suite/.test(f.title))
    const repackGame = byPath(path.join(w.DRIVE, 'Games', 'RepackGame'), 'orphanGame')
    check('repack sem registro: oferece o desinstalador próprio (unins000.exe)', Boolean(repackGame?.actions.some((a) => a.kind === 'runUninstaller')))

    // =============================================================== ações (todas em sandbox)
    console.log('\n--- Ações')
    const leftover = byPath(path.join(w.PD, 'OldGame Data'), 'leftoverFolder')!
    // ação que não está na lista do achado
    check('act: ação fora da lista do achado é recusada', !(await api.act({ findingId: leftover.id, action: 'forceRemove', confirmWord: 'REMOVER' })).ok)
    check('act: achado inexistente é recusado', !(await api.act({ findingId: 'leftoverFolder:c:\\windows', action: 'deleteLeftovers' })).ok)
    // corrida: um processo passa a rodar de dentro da pasta depois da busca -> recusa
    processes = [...processes, { pid: 999_002, name: 'old.exe', path: path.join(w.PD, 'OldGame Data', 'old.exe') }]
    const race = await api.act({ findingId: leftover.id, action: 'deleteLeftovers' })
    check('act: revalida na hora (programa abriu depois da busca) e NÃO apaga', !race.ok && exists(path.join(w.PD, 'OldGame Data')), race.message)
    processes = processes.filter((p) => p.pid !== 999_002)
    const del = await api.act({ findingId: leftover.id, action: 'deleteLeftovers' })
    check('act deleteLeftovers: vai para a Lixeira (falsa) e pede admin (ProgramData)', del.ok && !exists(path.join(w.PD, 'OldGame Data')) && opsCalls.at(-1)?.elevated === true, del.message)
    check('act deleteLeftovers: registrado no Histórico', Boolean(del.logId && (await getAction(del.logId))?.action === 'discover.deleteLeftovers'))
    check('act: achado removido do último relatório', !(await getLatest('discover'))?.findings.some((f) => f.id === leftover.id))

    // deleteLeftovers direto (pedido da interface com caminhos arbitrários)
    const dl = await api.deleteLeftovers([
      path.join(w.PF, 'OwnedApp'),
      path.join(w.LA, 'RunningApp'),
      path.join(w.PD, 'LeftoverWithJunction'),
      path.join(w.LA, 'JunctionLeftover'),
      path.join(w.RA, 'viaJunction', 'child'),
      path.join(w.PF, 'Common Files', 'Shared'),
      path.join(w.DL, 'Pack'),
      path.join(w.RA, 'IA Cleaner'),
      path.join(w.PD, 'BlueStacks_nxt'),
      path.join(w.LA, 'PathTool'),
      w.PF
    ])
    check('deleteLeftovers: nada com dono/em uso/junction/protegido foi apagado', dl.deleted.length === 0, JSON.stringify(dl.deleted))
    check('deleteLeftovers: tudo explicado (11 recusas)', dl.skipped.length === 11, JSON.stringify(dl.skipped.map((s) => s.reason.slice(0, 50))))
    for (const p of [path.join(w.PF, 'OwnedApp', 'owned.exe'), path.join(w.LA, 'RunningApp', 'run.exe'), path.join(w.VICTIM, 'importante.txt'), path.join(SB, 'realdir', 'child', 'x.bin'), path.join(w.PF, 'Common Files', 'Shared', 'x.dll'), path.join(w.RA, 'IA Cleaner', 'settings.json'), path.join(w.PD, 'BlueStacks_nxt', 'Engine', 'disk.vhd')]) {
      check(`intacto: ${path.relative(SB, p)}`, exists(p))
    }
    check('vítima da junction intacta (conteúdo)', fs.readFileSync(path.join(w.VICTIM, 'importante.txt'), 'utf8') === 'NAO APAGAR')
    const just = await api.checkLeftovers([path.join(w.PF, 'JustUninstalled')])
    check('sobra de programa que ACABOU de sair do registro (inventário salvo desatualizado) pode ser apagada', just[0]?.allowed === true, JSON.stringify(just))
    const chk = await api.checkLeftovers([path.join(w.RA, 'OldTool'), path.join(w.PF, 'OwnedApp')])
    check('checkLeftovers: libera sobra e recusa pasta com dono', chk[0]?.allowed === true && chk[1]?.allowed === false && (chk[0].bytes ?? 0) >= 6 * MB)
    const userLeft = await api.deleteLeftovers([path.join(w.RA, 'OldTool')])
    check('deleteLeftovers: sobra em AppData vai sem admin', userLeft.deleted.length === 1 && opsCalls.at(-1)?.elevated === false && !exists(path.join(w.RA, 'OldTool')))

    // recycle (Downloads) via limpeza (guard)
    const zipF = byPath(path.join(w.DL, 'Pack.zip'))!
    check('act recycle: caminho que não é do achado é recusado', !(await api.act({ findingId: zipF.id, action: 'recycle', paths: [path.join(w.DL, 'Pack')] })).ok)
    const rz = await api.act({ findingId: zipF.id, action: 'recycle' })
    check('act recycle: zip para a Lixeira, pasta extraída fica', rz.ok && !exists(path.join(w.DL, 'Pack.zip')) && exists(path.join(w.DL, 'Pack', 'Pack', 'readme.txt')), rz.message)
    // jogo portátil: processo aberto de dentro -> recusa
    processes = [...processes, { pid: 999_003, name: 'Game.exe', path: path.join(w.DRIVE, 'Games', 'PortableGame', 'Game.exe') }]
    const pg = await api.act({ findingId: portable!.id, action: 'recycle' })
    check('act recycle: jogo aberto não é apagado', !pg.ok && exists(path.join(w.DRIVE, 'Games', 'PortableGame')), pg.message)
    processes = processes.filter((p) => p.pid !== 999_003)

    // desinstaladores (nunca abertos de verdade)
    const ru = await api.act({ findingId: space!.id, action: 'runUninstaller' })
    const t0 = tracked.at(-1)
    check(
      'act runUninstaller (fora do inventário): acompanhado via startCustom com a entrada do registro do jogo',
      ru.ok && t0?.via === 'custom' && t0.id === 'reg:HKCU:SpaceGame_is1' && Boolean(t0.spec?.method.value.includes('unins000.exe')) && t0.spec?.kind === 'game' && eqp(t0.spec?.installPath ?? '', path.join(w.DRIVE, 'Games', 'SpaceGame')),
      JSON.stringify(t0)
    )
    check('act runUninstaller: nada é aberto fora do acompanhamento', !launched.some((l) => l.includes('unins000.exe')))
    check('relatório salvo: achado fica, com a anotação "desinstalador aberto"', Boolean((await getLatest('discover'))?.findings.find((f) => f.id === space!.id)?.evidence.some((e) => /Desinstalador oficial aberto/.test(e))))
    const waveF = report.findings.find((f) => f.kind === 'unwanted' && /Wave/.test(f.title))!
    const rw = await api.act({ findingId: waveF.id, action: 'runUninstaller' })
    check('act runUninstaller (item do inventário): mesmo caminho de Jogos & Programas (apps.uninstall)', rw.ok && tracked.at(-1)?.via === 'inventory' && tracked.at(-1)?.id === 'reg:HKCU:Wavesor', JSON.stringify(tracked.at(-1)))
    if (repackGame) {
      const rr = await api.act({ findingId: repackGame.id, action: 'runUninstaller' })
      const t1 = tracked.at(-1)
      check('act runUninstaller (unins000.exe de repack, sem registro): startCustom pela pasta do jogo', rr.ok && t1?.via === 'custom' && /^discover:/.test(t1.id) && eqp(t1.spec?.installPath ?? '', path.join(w.DRIVE, 'Games', 'RepackGame')), JSON.stringify(t1))
    }
    trackAnswer = { started: false, message: 'Não foi possível abrir o desinstalador: Acesso negado.' }
    const rd = await api.act({ findingId: space!.id, action: 'runUninstaller' })
    trackAnswer = null
    check('act runUninstaller "acesso negado": oferece tentar como Administrador (details.canElevate)', !rd.ok && (rd.details as { canElevate?: boolean })?.canElevate === true)
    const re = await api.act({ findingId: space!.id, action: 'runUninstaller', elevated: true })
    check('act runUninstaller como Administrador: pedido repassado (elevated)', re.ok && tracked.at(-1)?.elevated === true)
    // relatório adulterado: desinstalador fora da pasta / URL fora da lista
    {
      const rep = (await getLatest('discover'))!
      const tampered: DiscoverReport = {
        ...rep,
        findings: rep.findings.map((f) =>
          f.id === portable!.id
            ? { ...f, actions: [...f.actions, { kind: 'runUninstaller', label: 'x' }, { kind: 'learnMore', label: 'x' }], meta: { ...f.meta, uninstallerExe: 'C:\\Windows\\System32\\cmd.exe', url: 'https://malicioso.example/' } }
            : f
        )
      }
      await setLatest('discover', tampered)
      const t1 = await api.act({ findingId: portable!.id, action: 'runUninstaller' })
      check('act: desinstalador adulterado (cmd.exe) é recusado', !t1.ok && !launched.some((l) => /cmd\.exe/i.test(l)) && !tracked.some((t) => /cmd\.exe/i.test(t.spec?.method.value ?? '')), t1.message)
      const t2 = await api.act({ findingId: portable!.id, action: 'learnMore' })
      check('act: URL fora da lista é recusada', !t2.ok && !opened.some((o) => /malicioso/.test(o)))
      await setLatest('discover', rep)
    }
    const os1 = await api.act({ findingId: report.findings.find((f) => f.kind === 'unwanted')!.id, action: 'openSettings' })
    check('act openSettings: só a Segurança do Windows/Configurações', os1.ok && opened.some((o) => o === 'url:windowsdefender://threat'))

    // tirar da inicialização (gravador, nada no registro)
    const ds = await api.act({ findingId: startupApp!.id, action: 'disableStartup' })
    check('act disableStartup: confere o item e desativa só ele', ds.ok && toggled.includes('run:HKCU:StartupApp'), ds.message)
    {
      const saved = (await getLatest('discover'))?.findings.find((f) => f.id === startupApp!.id)
      check('relatório salvo depois de "tirar da inicialização": achado fica, sem essa ação', Boolean(saved && !saved.actions.some((a) => a.kind === 'disableStartup') && saved.actions.some((a) => a.kind === 'forceRemove')))
    }

    // remover à força
    const noWord = await api.act({ findingId: startupApp!.id, action: 'forceRemove' })
    check('act forceRemove: sem digitar REMOVER é recusado', !noWord.ok && exists(path.join(w.RA, 'StartupApp')))
    const fr = await api.act({ findingId: startupApp!.id, action: 'forceRemove', confirmWord: 'REMOVER' })
    const frSteps = (fr.details as OpsResult | undefined)?.steps ?? []
    check('act forceRemove: pasta para a Lixeira, inicialização desativada (simulado)', fr.ok && !exists(path.join(w.RA, 'StartupApp')) && frSteps.some((s) => s.op === 'disableRun' && s.ok), fr.message)
    check('act forceRemove: registrado no Histórico', Boolean(fr.logId && (await getAction(fr.logId))?.action === 'discover.forceRemove'))
    // remover à força pasta que contém outro programa instalado -> recusa
    {
      const rep = (await getLatest('discover'))!
      const fake: Finding = {
        id: 'noUninstaller:teste-contoso',
        kind: 'noUninstaller',
        title: 'Contoso — teste',
        detail: '',
        paths: [path.join(w.PF, 'Contoso')],
        bytes: 0,
        verdict: 'review',
        risk: 'medium',
        evidence: [],
        actions: [{ kind: 'forceRemove', label: 'x', dangerous: true, confirmWord: 'REMOVER' }],
        meta: { folder: path.join(w.PF, 'Contoso') }
      }
      await setLatest('discover', { ...rep, findings: [...rep.findings, fake] })
      const r = await api.act({ findingId: fake.id, action: 'forceRemove', confirmWord: 'REMOVER' })
      check('act forceRemove: recusa pasta com outro programa instalado dentro', !r.ok && exists(path.join(w.PF, 'Contoso', 'Product A', 'a.exe')), r.message)
      const fake2: Finding = { ...fake, id: 'noUninstaller:teste-svc', paths: [path.join(w.PF, 'ServiceApp')], meta: { folder: path.join(w.PF, 'ServiceApp') } }
      await setLatest('discover', { ...rep, findings: [...rep.findings, fake2] })
      const r2 = await api.act({ findingId: fake2.id, action: 'forceRemove', confirmWord: 'REMOVER' })
      check('act forceRemove: recusa pasta de serviço do Windows', !r2.ok && exists(path.join(w.PF, 'ServiceApp', 'svc.exe')), r2.message)
      const fake3: Finding = { ...fake, id: 'noUninstaller:teste-av', paths: [path.join(w.PF, 'Kaspersky Lab')], meta: { folder: path.join(w.PF, 'Kaspersky Lab') } }
      await setLatest('discover', { ...rep, findings: [...rep.findings, fake3] })
      const r3 = await api.act({ findingId: fake3.id, action: 'forceRemove', confirmWord: 'REMOVER' })
      check('act forceRemove: recusa antivírus', !r3.ok && exists(path.join(w.PF, 'Kaspersky Lab', 'avp.exe')), r3.message)
      await setLatest('discover', rep)
    }

    // =============================================================== R3b: ações
    console.log('\n--- R3b: ações')
    {
      // API (IPC) de sobras: raiz de fabricante, subpasta de algo instalado, EA app, componentes da ASUS
      const vend = await api.checkLeftovers([
        path.join(w.RA, 'Opera Software'),
        path.join(w.PD, 'Adobe'),
        path.join(w.RA, 'Diversos'),
        path.join(w.PD, 'EA Desktop'),
        path.join(w.LA, 'EADesktop'),
        path.join(w.PD, 'ASUS', 'ROGLSLoader'),
        path.join(w.PD, 'ASUS'),
        path.join(w.LA, 'Link2EA'),
        path.join(w.RA, 'ludusavi')
      ])
      check('checkLeftovers: Opera Software, Adobe, subpasta de programa instalado, EA Desktop, EADesktop, ASUS, Link2EA, ludusavi: tudo recusado', vend.length === 9 && vend.every((v) => !v.allowed), JSON.stringify(vend.map((v) => [path.basename(v.path), v.allowed, v.reason.slice(0, 70)])))
      const vdel = await api.deleteLeftovers([path.join(w.RA, 'Opera Software'), path.join(w.PD, 'Adobe'), path.join(w.RA, 'Diversos'), path.join(w.PD, 'EA Desktop'), path.join(w.PD, 'ASUS', 'ROGLSLoader')])
      check(
        'deleteLeftovers: nada disso foi para a Lixeira',
        vdel.deleted.length === 0 &&
          [path.join(w.RA, 'Opera Software', 'Opera GX Stable', 'Login Data'), path.join(w.PD, 'Adobe', 'SLStore', 'lic.bin'), path.join(w.RA, 'Diversos', 'Product A', 'cfg.bin'), path.join(w.PD, 'EA Desktop', 'machine.ini'), path.join(w.PD, 'ASUS', 'ROGLSLoader', 'Armoury Crate Installer.exe')].every(exists),
        JSON.stringify(vdel.deleted)
      )

      // relatório adulterado/antigo: pasta-contêiner proposta como "um jogo"
      const rep = (await getLatest('discover'))!
      const fakeGame = (id: string, dir: string, kind: Finding['kind'] = 'orphanGame', act: Finding['actions'][number]['kind'] = 'recycle'): Finding => ({
        id,
        kind,
        title: 'teste — jogo fora dos launchers',
        detail: '',
        paths: [dir],
        bytes: 0,
        verdict: 'review',
        risk: 'medium',
        evidence: [],
        actions: [act === 'forceRemove' ? { kind: 'forceRemove', label: 'x', dangerous: true, confirmWord: 'REMOVER' } : { kind: act, label: 'x' }],
        meta: { folder: dir }
      })
      const fj = fakeGame('orphanGame:teste-jogos', path.join(w.DRIVE, 'Jogos'))
      const fc = fakeGame('orphanGame:teste-coisas', path.join(w.DRIVE, 'Coisas'))
      const fo = fakeGame('noUninstaller:teste-obsidian', path.join(w.DRIVE, 'Obsidian'), 'noUninstaller', 'forceRemove')
      const fg = fakeGame('noUninstaller:teste-games', path.join(w.DRIVE, 'Games'), 'noUninstaller', 'forceRemove')
      await setLatest('discover', { ...rep, findings: [...rep.findings, fj, fc, fo, fg] })
      const r1 = await api.act({ findingId: fj.id, action: 'recycle' })
      check('act recycle de "D:\\Jogos" (contém o jogo do Hydra e o Celeste com saves) é recusado', !r1.ok && exists(path.join(w.DRIVE, 'Jogos', 'Celeste', 'saves', 'save.dat')) && exists(path.join(w.DRIVE, 'Jogos', 'Hollow Knight', 'hollow_knight.exe')), r1.message)
      const r2 = await api.act({ findingId: fc.id, action: 'recycle' })
      check('act recycle de "D:\\Coisas" (2 jogos + fotos) é recusado', !r2.ok && exists(path.join(w.DRIVE, 'Coisas', 'fotos', 'viagem.jpg')) && exists(path.join(w.DRIVE, 'Coisas', 'GameA', 'GameA.exe')), r2.message)
      const r3 = await api.act({ findingId: fo.id, action: 'forceRemove', confirmWord: 'REMOVER' })
      check('act forceRemove de pasta do usuário na raiz do disco (Obsidian: .bat + .exe em subpasta) é recusado', !r3.ok && exists(path.join(w.DRIVE, 'Obsidian', 'VJPPB', 'nota.md')), r3.message)
      const r4 = await api.act({ findingId: fg.id, action: 'forceRemove', confirmWord: 'REMOVER' })
      check('act forceRemove de "D:\\Games" é recusado', !r4.ok && exists(path.join(w.DRIVE, 'Games', 'SpaceGame', 'SpaceGame.exe')), r4.message)
      await setLatest('discover', rep)

      // nome 8.3: "Contoso Suite" (desinstalador quebrado) com Product B instalado dentro
      if (suite?.actions.some((a) => a.kind === 'forceRemove')) {
        const r = await api.act({ findingId: suite.id, action: 'forceRemove', confirmWord: 'REMOVER' })
        check('act forceRemove recusa pasta com programa instalado dentro registrado com nome 8.3', !r.ok && exists(path.join(w.PF, 'Contoso Suite', 'Product B', 'b.exe')), r.message)
      } else check('Contoso Suite: "remover à força" nem é oferecido (Product B instalado dentro)', exists(path.join(w.PF, 'Contoso Suite', 'Product B', 'b.exe')))

      // jogo do Hydra de verdade: vai para a Lixeira sozinho; o vizinho e o item do launcher ficam certos
      const hk = byPath(path.join(w.DRIVE, 'Jogos', 'Hollow Knight'), 'orphanGame')
      if (hk) {
        const r = await api.act({ findingId: hk.id, action: 'recycle' })
        check('act recycle do jogo do Hydra (D:\\Jogos\\Hollow Knight): só ele vai para a Lixeira', r.ok && !exists(path.join(w.DRIVE, 'Jogos', 'Hollow Knight')) && exists(path.join(w.DRIVE, 'Jogos', 'Celeste', 'saves', 'save.dat')), r.message)
        const saved = await getLatest('discover')
        const hItem = saved?.findings.find((f) => f.kind === 'altLauncher' && /Hydra/.test(f.title))?.items?.find((i) => i.label.includes('Hollow Knight'))
        check('relatório salvo: achado do jogo saiu e o item "Hollow Knight" do Hydra ficou como apagado', !saved?.findings.some((f) => f.id === hk.id) && hItem?.exists === false, JSON.stringify(hItem))
      } else check('Hollow Knight listado para o teste de Lixeira', false)

      // "sem permissão" -> details.canElevate -> repetir como Administrador
      const ni = byPath(path.join(w.DL, 'NeverInstalledTool-setup-x64.exe'))!
      deniedTrash = path.join(w.DL, 'NeverInstalledTool-setup-x64.exe')
      const d1 = await api.act({ findingId: ni.id, action: 'recycle' })
      deniedTrash = null
      check('act recycle "sem permissão": oferece tentar como Administrador (details.canElevate)', !d1.ok && (d1.details as { canElevate?: boolean })?.canElevate === true && exists(path.join(w.DL, 'NeverInstalledTool-setup-x64.exe')), d1.message)
      const before2 = opsCalls.length
      const d2 = await api.act({ findingId: ni.id, action: 'recycle', elevated: true })
      check('act recycle como Administrador: um pedido elevado ao executor e o arquivo vai para a Lixeira', d2.ok && opsCalls.length === before2 + 1 && opsCalls.at(-1)?.elevated === true && !exists(path.join(w.DL, 'NeverInstalledTool-setup-x64.exe')), d2.message)
      const od = byPath(path.join(w.RA, 'OldDenied'), 'leftoverFolder')
      if (od) {
        const e1 = await api.act({ findingId: od.id, action: 'deleteLeftovers' })
        check('act deleteLeftovers "acesso negado": oferece tentar como Administrador', !e1.ok && (e1.details as { canElevate?: boolean })?.canElevate === true && exists(path.join(w.RA, 'OldDenied', 'big.bin')), e1.message)
        const e2 = await api.act({ findingId: od.id, action: 'deleteLeftovers', elevated: true })
        check('act deleteLeftovers como Administrador: vai para a Lixeira', e2.ok && opsCalls.at(-1)?.elevated === true && !exists(path.join(w.RA, 'OldDenied')), e2.message)
      } else check('sobra OldDenied listada para o teste de "acesso negado"', false)
    }

    // entrada quebrada: backup .reg (LEITURA do registro real) + exclusão simulada + desfazer simulado
    if (ghost) {
      const rb = await api.act({ findingId: ghost.id, action: 'removeBrokenEntry' })
      const steps = (rb.details as OpsResult | undefined)?.steps ?? []
      if (realHkcuKey) {
        const exp = steps.find((s) => s.op === 'regExport' && s.ok)
        check('removeBrokenEntry: exporta backup .reg (leitura) para a pasta de dados', Boolean(exp && fs.existsSync(exp.target) && exp.target.toLowerCase().startsWith(userData.toLowerCase())), JSON.stringify(steps))
        check('removeBrokenEntry: exclusão SIMULADA (registro intacto)', steps.some((s) => s.op === 'regDelete' && s.code === 'simulated'))
        const entry = rb.logId ? await getAction(rb.logId) : undefined
        check('removeBrokenEntry: Histórico com desfazer reg.import', entry?.undo?.kind === 'reg.import')
        const un = await api.undo(rb.logId!)
        check('undo: importa o backup (simulado) e marca como desfeito', un.ok && (await getAction(rb.logId!))?.undone === true, un.message)
        check('undo: não desfaz duas vezes', !(await api.undo(rb.logId!)).ok)
      } else {
        check('removeBrokenEntry sem chave real: falha sem alterar nada', !rb.ok)
      }
    }
    // desinstalador "volta" a existir -> recusa apagar a entrada
    if (half) {
      file(path.join(w.LP, 'HalfApp', 'unins000.exe'), 100)
      const r = await api.act({ findingId: half.id, action: 'removeBrokenEntry' })
      check('removeBrokenEntry: desinstalador voltou -> não mexe', !r.ok, r.message)
    }
    // undo com arquivo fora da pasta de backups
    {
      const { logAction } = await import('../../src/main/core/actionLog')
      const e = await logAction({ domain: 'apps', action: 'discover.removeBrokenEntry', title: 'teste', success: true, undo: { kind: 'reg.import', payload: { file: path.join(SB, 'malicioso.reg'), elevated: false } } })
      file(path.join(SB, 'malicioso.reg'), 'Windows Registry Editor Version 5.00')
      check('undo: backup fora da pasta de backups é recusado', !(await api.undo(e.id)).ok)
    }

    // =============================================================== executor (script PowerShell) direto
    console.log('\n--- Executor')
    {
      // atômico: uma pasta inválida -> nada é feito
      file(path.join(w.LA, 'AtomicA', 'x.bin'), 100)
      const r = await runOps({ atomic: true, recycle: [{ path: path.join(w.LA, 'AtomicA') }, { path: path.join(w.LA, 'JunctionLeftover') }] }, false)
      check('executor atômico: uma pasta com problema -> nada é movido', Boolean(r.data?.aborted) && exists(path.join(w.LA, 'AtomicA', 'x.bin')), JSON.stringify(r.data))
      // junction dentro -> recusa
      const r2 = await runOps({ recycle: [{ path: path.join(w.PD, 'LeftoverWithJunction') }] }, false)
      check('executor: pasta com junction dentro é recusada pelo próprio script', !r2.data?.steps.some((s) => s.op === 'recycle' && s.ok) && exists(path.join(w.VICTIM, 'importante.txt')))
      // caminho não normalizado
      const r3 = await runOps({ recycle: [{ path: path.join(w.LA, 'AtomicA') + '\\..\\AtomicA' }] }, false)
      check('executor: caminho com ".." é recusado', !r3.data?.steps.some((s) => s.op === 'recycle' && s.ok) && exists(path.join(w.LA, 'AtomicA')))
      // fechar só processos de DENTRO da pasta (processos de teste, cópias do ping na sandbox)
      const pingSrc = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE')
      const inside = file(path.join(w.LA, 'KillApp', 'killme.exe'), 1)
      const outside = file(path.join(SB, 'OutsideApp', 'keepme.exe'), 1)
      fs.copyFileSync(pingSrc, inside)
      fs.copyFileSync(pingSrc, outside)
      const p1 = spawn(inside, ['-n', '120', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
      const p2 = spawn(outside, ['-n', '120', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
      kill.push(p1, p2)
      await new Promise((r) => setTimeout(r, 800))
      const r4 = await runOps({ killInside: [path.join(w.LA, 'KillApp')], kill: [{ pid: p1.pid!, name: 'killme.exe' }, { pid: p2.pid!, name: 'keepme.exe' }] }, false)
      await new Promise((r) => setTimeout(r, 500))
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }
      check('executor: fecha processo de dentro da pasta', !alive(p1.pid!), JSON.stringify(r4.data?.steps))
      check('executor: NÃO fecha processo de fora da pasta', alive(p2.pid!))
      // o script não usa "-Verb RunAs" nem toca no registro quando simulado
      const script = buildOpsScript({ recycle: [{ path: 'C:\\x' }], regRemove: [{ regPath: 'HKEY_CURRENT_USER\\Software\\X', backupFile: 'C:\\b.reg' }] }, { fakeBin: w.BIN, simulateSystemWrites: true })
      check('script de teste: sem RunAs e com Lixeira falsa', !/RunAs/i.test(script) && script.includes(w.BIN) && !/SHFileOperation/.test(script))
      const realScript = buildOpsScript({ recycle: [{ path: 'C:\\x' }] }, null)
      check('script real: Lixeira via SHFileOperation com aviso antes de apagar de vez (FOF_WANTNUKEWARNING)', /SHFileOperation/.test(realScript) && /0x4000/.test(realScript) && /0x0040/.test(realScript))
      // reg.exe escreve no stderr (ex.: "reg import" sempre): o padrão usado no script não pode virar exceção
      const regProbe = await runPowerShellJson<{ code: number }>(
        "$eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'\n$null = & (Join-Path $env:SystemRoot 'System32\\reg.exe') query 'HKCU\\Software\\IACleanerChaveQueNaoExiste' 2>&1\n$c = $LASTEXITCODE\n$ErrorActionPreference = $eap\nConvertTo-Json -InputObject @{ code = $c } -Compress",
        { timeoutMs: 30_000 }
      )
      check('reg.exe com mensagem no stderr não derruba o script (decide pelo código de saída)', regProbe.code === 1, JSON.stringify(regProbe))
      // O script REAL com um plano VAZIO: só compila o componente da Lixeira e não faz nada (prova que o C# compila)
      const empty = await runPowerShellJson<OpsResult>(buildOpsScript({}, null), { timeoutMs: 120_000 })
      check('script real com plano vazio: componente da Lixeira compila e nada é feito', empty.recycleReady === true && empty.steps.length === 0, JSON.stringify(empty))
    }

    // nenhum UAC/elevação real em todo o teste
    check('nenhuma elevação real (todas as execuções passaram pelo executor de teste)', opsCalls.length > 0)
    const log = await listActions(50)
    check('Histórico tem as ações da Busca Profunda', log.some((e) => e.action.startsWith('discover.')))
  } finally {
    for (const p of kill) {
      try {
        p.kill()
      } catch {
        // já saiu
      }
    }
    Object.assign(platform, realPlatform)
    setDiscoverProvidersForTests(null)
    setOpsTestMode(null)
    setUninstallLauncherForTests(null)
    setUninstallTrackingForTests(null)
    setDriveProbeForTests(null)
    setStartupTogglerForTests(null)
    setLeftoverRootsForTests(null)
    await new Promise((r) => setTimeout(r, 300))
    try {
      fs.rmSync(mustBeInSandbox(SB), { recursive: true, force: true })
    } catch (e) {
      console.log('aviso: não foi possível limpar a sandbox agora:', (e as Error).message)
    }
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`)
  if (fail) throw new Error('Falhas:\n' + failures.join('\n'))
}
