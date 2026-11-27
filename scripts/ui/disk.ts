// Teste de interface da Análise de Discos (somente leitura): abre a página, clica em "Analisar", espera terminar,
// navega pelas abas e procura duplicados no D:. NUNCA clica em "Mover para a Lixeira".
// Uso: npx tsx --tsconfig tsconfig.node.json scripts/ui/disk.ts --out out-disk --dir <pasta> [--roots C,D,E] [--fresh] [--userdata <pasta>]
//      ... scripts/ui/disk.ts --folders --out out-r3-disk-delete --dir <pasta>   (rodada 3: apagar pastas do mapa; ver foldersMain)
//
// --fixture: testa a interface de EXCLUSÃO com dados de teste (nenhuma varredura real). Cria uma sandbox em
// %TEMP%\iacleaner-r3-disk-delete\fix2\ (arquivos próprios) e um userData próprio com varredura/duplicados/inventário falsos.
// Fase 1 (Lixeira): as chamadas cleanup:deleteFiles/deleteDuplicates (e disk:findDuplicates) são INTERCEPTADAS no
// main (nada é apagado nem lido).
// Fase 2 (Configurações → "Apagar de vez"): apaga de verdade SOMENTE arquivos da sandbox.
//
// Sem page.waitForFunction: com a CSP do app (script-src 'self', sem 'unsafe-eval'), o predicado em texto é refeito
// com eval a cada tentativa e quebra (EvalError) quando precisa esperar. As esperas usam page.evaluate(função) em
// laço (waitPage) e todas as chamadas à página usam funções, não strings.
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { Page } from 'playwright-core'
import type { DeleteDuplicatesRequest, DeleteFilesRequest } from '../../src/shared/types/cleanup'
import type { DirNode, DriveScanResult, DuplicateGroup, DuplicatesOptions, FileEntry, ScanResult } from '../../src/shared/types/disk'
import { launchApp, type AppHandle } from './harness'

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}

// Tipos mínimos do DOM/janela usados dentro de page.evaluate (o tsconfig dos scripts não inclui a lib DOM).
interface PageDoc {
  body: { innerText: string }
  querySelector(sel: string): { scrollTo(x: number, y: number): void } | null
}
type PageGlobal = { document: PageDoc; api: { settings: { update(p: unknown): Promise<unknown> }; system: { getActionLog(n: number): Promise<unknown> } } }

/** Espera (polling com page.evaluate) até `pred()` ser verdadeiro na página. Substitui page.waitForFunction. */
async function waitPage(page: Page, pred: (arg: string) => boolean, arg: string, what: string, timeout = 15_000): Promise<void> {
  const end = Date.now() + timeout
  for (;;) {
    if (await page.evaluate(pred, arg).catch(() => false)) return
    if (Date.now() > end) throw new Error(`Tempo esgotado (${timeout} ms) esperando: ${what}`)
    await page.waitForTimeout(150)
  }
}

/** Espera o texto sumir da página (ex.: "Conferindo a proteção"). */
const waitTextGone = (page: Page, text: string, timeout = 15_000): Promise<void> =>
  waitPage(page, (t: string) => !(globalThis as unknown as PageGlobal).document.body.innerText.includes(t), text, `"${text}" sumir`, timeout)

/** Rola o conteúdo da página (<main>) para o topo. */
const scrollMainTop = (page: Page): Promise<void> =>
  page.evaluate(() => {
    ;(globalThis as unknown as PageGlobal).document.querySelector('main')?.scrollTo(0, 0)
  })

// ------------------------------------------------------------------------------------------------
// --fixture: interface de exclusão (DEL-02 proteção pelo guard, DEL-06 duplicados por grupo, DEL-09 modo)
// ------------------------------------------------------------------------------------------------

/** 'D:/a/b' -> 'D:\a\b' */
const W = (p: string): string => p.replace(/\//g, '\\')
const DAY = 86_400_000

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error('FALHOU: ' + msg)
  console.log('  ok: ' + msg)
}

interface Fixture {
  userDataDir: string
  sb: string
  clip: string
  original: string
  copia: string
  unica: string
  sumiu: string
  /** SHA-256 reais dos grupos h1/h2 (o backend confere o SHA-256 completo no modo "apagar de vez") */
  h1: string
  h2: string
}

function writeFixture(): Fixture {
  const base = path.join(os.tmpdir(), 'iacleaner-r3-disk-delete', 'fix2')
  const userDataDir = path.join(base, 'ui-userdata')
  const sb = path.join(base, 'sandbox')
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(sb, { recursive: true, force: true })
  mkdirSync(path.join(sb, 'Gravacoes'), { recursive: true })
  mkdirSync(path.join(sb, 'Dupes'), { recursive: true })
  mkdirSync(path.join(userDataDir, 'state'), { recursive: true })
  const clip = path.join(sb, 'Gravacoes', 'clip-antigo.mp4')
  writeFileSync(clip, randomBytes(256 * 1024))
  const same = randomBytes(128 * 1024)
  const original = path.join(sb, 'Dupes', 'original.bin')
  const copia = path.join(sb, 'Dupes', 'copia.bin')
  const unica = path.join(sb, 'Dupes', 'unica.bin')
  const sumiu = path.join(sb, 'Dupes', 'sumiu-original.bin') // "apagado fora do app" depois da busca
  for (const p of [original, copia]) writeFileSync(p, same)
  const other = randomBytes(128 * 1024) // conteúdo do grupo h2 (diferente do h1: hash próprio)
  writeFileSync(unica, other)
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')
  const h1 = sha(same)
  const h2 = sha(other)
  const lw = (p: string): number => Math.floor(statSync(p).mtimeMs)

  const now = Date.now()
  const f = (p: string, gb: number, ext: string, category: FileEntry['category'], ageDays = 400): FileEntry => ({
    path: W(p),
    bytes: Math.round(gb * 1024 ** 3),
    lastWrite: now - ageDays * DAY,
    lastAccess: now - ageDays * DAY,
    ext,
    category
  })
  const topFiles: FileEntry[] = [
    f('D:/Jogos/Cyberpunk 2077/archive/pc/content/basegame_4_gamedata.archive', 9.8, 'archive', 'gameData'),
    f('D:/ISOs/Windows11_23H2.iso', 5.4, 'iso', 'diskImage'),
    f('D:/Rockstar Games/Grand Theft Auto V/x64a.rpf', 4.1, 'rpf', 'gameData'),
    f('D:/SteamLibrary/steamapps/common/Cyberpunk 2077/archive/pc/content/lang_pt.archive', 3.2, 'archive', 'gameData'),
    f('D:/Videos/gravacao-2023.mp4', 2.6, 'mp4', 'video'),
    f('D:/Programas/Adobe Premiere/Premiere.exe', 0.4, 'exe', 'executable'),
    f('D:/Ferramentas/setup-antigo.exe', 0.3, 'exe', 'installer'),
    { path: clip, bytes: 256 * 1024, lastWrite: lw(clip), lastAccess: lw(clip), ext: 'mp4', category: 'video' }
  ]
  const total = topFiles.reduce((s, x) => s + x.bytes, 0)
  const drive: DriveScanResult = {
    root: 'D:\\',
    scannedAt: new Date(now - 3600_000).toISOString(),
    durationMs: 12_000,
    totalBytes: total,
    files: topFiles.length,
    dirs: 12,
    cloudOnlyBytes: 0,
    inaccessibleDirs: 0,
    tree: { name: 'D:\\', path: 'D:\\', bytes: total, files: topFiles.length, dirs: 12, children: [], otherBytes: total, fileBytes: total },
    topFiles,
    oldLargeFiles: topFiles.filter((x) => x.bytes >= 100 * 1024 ** 2),
    categories: [],
    engine: 'native',
    extensions: []
  }
  const scan: ScanResult = { id: 'fixture', startedAt: drive.scannedAt, finishedAt: drive.scannedAt, drives: [drive] }
  const groups: DuplicateGroup[] = [
    { hash: h1, bytes: same.length, wastedBytes: same.length, files: [{ path: original, lastWrite: lw(original) }, { path: copia, lastWrite: lw(copia) }] },
    { hash: h2, bytes: other.length, wastedBytes: same.length, files: [{ path: sumiu, lastWrite: lw(unica) - 1000 }, { path: unica, lastWrite: lw(unica) }] },
    {
      hash: 'h3',
      bytes: 2 * 1024 ** 3,
      wastedBytes: 2 * 1024 ** 3,
      files: [
        { path: W('D:/Videos/intro-backup.bk2'), lastWrite: now - 500 * DAY },
        { path: W('D:/Jogos/Cyberpunk 2077/movies/intro.bk2'), lastWrite: now - 400 * DAY }
      ]
    },
    // A cópia MAIS ANTIGA está na pasta do jogo (bloqueada): "Marcar cópias extras" não pode marcar a cópia pessoal
    {
      hash: 'h4',
      bytes: 3 * 1024 ** 3,
      wastedBytes: 3 * 1024 ** 3,
      files: [
        { path: W('D:/Jogos/Cyberpunk 2077/movies/outro.bk2'), lastWrite: now - 600 * DAY },
        { path: W('D:/Videos/outro-backup.bk2'), lastWrite: now - 300 * DAY }
      ]
    },
    // Jogo mais antigo + 2 cópias pessoais: fica a pessoal mais antiga, só a outra pessoal é marcada
    {
      hash: 'h5',
      bytes: 1024 ** 3,
      wastedBytes: 2 * 1024 ** 3,
      files: [
        { path: W('D:/Jogos/Cyberpunk 2077/movies/credits.bk2'), lastWrite: now - 700 * DAY },
        { path: W('D:/Videos/credits.bk2'), lastWrite: now - 200 * DAY },
        { path: W('D:/Videos/Backup/credits-copia.bk2'), lastWrite: now - 100 * DAY }
      ]
    }
  ]
  const apps = {
    collectedAt: new Date(now - DAY).toISOString(),
    games: [
      {
        id: 'other:cyberpunk',
        launcher: 'other',
        name: 'Cyberpunk 2077 (teste)',
        installPath: W('D:/Jogos/Cyberpunk 2077'),
        drive: 'D:',
        bytes: 70 * 1024 ** 3,
        uninstall: { kind: 'settings', value: 'ms-settings:appsfeatures', label: 'Desinstalar pelo Windows' },
        exists: true
      }
    ],
    programs: [
      { id: 'reg:test', name: 'Adobe Premiere (teste)', installPath: W('D:/Programas/Adobe Premiere'), source: 'registry', scope: 'machine' }
    ],
    launchers: []
  }
  const put = (rel: string, v: unknown): void => writeFileSync(path.join(userDataDir, rel), JSON.stringify(v))
  put('state/scan.json', scan)
  put('state/duplicates.json', groups)
  put('state/apps.json', apps)
  // busca de duplicados de 3 dias atrás (relatório "velho")
  put('disk-duplicates-meta.json', { roots: ['D:\\'], minBytes: 10 * 1024 ** 2, finishedAt: new Date(now - 3 * DAY).toISOString(), durationMs: 4200, engine: 'node' })
  return { userDataDir, sb, clip, original, copia, unica, sumiu, h1, h2 }
}

type Call = { ch: string; req: DeleteFilesRequest | DeleteDuplicatesRequest | DuplicatesOptions }

/** Mensagem do backend (cleanup/index.ts, STALE_DUPLICATES) quando pula um grupo de duplicados desatualizado. */
const STALE_MSG = 'O relatório de duplicados está desatualizado; procure de novo. (a cópia que ficaria não existe mais ou mudou)'

/**
 * Troca o handler IPC por um gravador (nada é apagado). Só para a fase 1. Exclusões: tudo volta como "pulado";
 * os grupos em `staleHashes` voltam com a mensagem de relatório desatualizado do backend.
 */
async function intercept(h: AppHandle, ch: string, staleHashes: string[] = []): Promise<void> {
  await h.app.evaluate(
    ({ ipcMain }, { channel, stale, staleMsg }) => {
      const g = globalThis as unknown as { __fixCalls?: unknown[] }
      g.__fixCalls = g.__fixCalls ?? []
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, async (_e, req: { paths?: string[]; groups?: { hash: string; remove: { path: string }[] }[] }) => {
        g.__fixCalls!.push({ ch: channel, req })
        if (channel === 'disk:findDuplicates') return []
        const skipped = req.paths
          ? req.paths.map((p) => ({ path: p, reason: 'Teste de interface: nada foi apagado.' }))
          : (req.groups ?? []).flatMap((x) =>
              x.remove.map((r) => ({ path: r.path, reason: stale.includes(x.hash) ? staleMsg : 'Teste de interface: nada foi apagado.' }))
            )
        return { deleted: [], skipped, bytesFreed: 0 }
      })
    },
    { channel: ch, stale: staleHashes, staleMsg: STALE_MSG }
  )
}
/** Rede de segurança: nos testes a Lixeira real nunca é esvaziada. */
async function blockRealBin(h: AppHandle): Promise<void> {
  await h.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('cleanup:emptyRecycleBin')
    ipcMain.handle('cleanup:emptyRecycleBin', async () => {
      throw new Error('bloqueado no teste')
    })
  })
}
const calls = (h: AppHandle): Promise<Call[]> => h.app.evaluate(() => ((globalThis as unknown as { __fixCalls?: Call[] }).__fixCalls ?? []) as Call[])

async function rowsState(h: AppHandle): Promise<{ name: string; locked: boolean; warned: boolean; checked: boolean; title: string }[]> {
  return h.page.$$eval('table.tbl tbody tr', (trs) =>
    trs.map((tr) => {
      const lock = tr.querySelector('[data-testid=locked]')
      const warn = tr.querySelector('[data-testid=warned]')
      const input = tr.querySelector('input[type=checkbox]') as unknown as { checked: boolean } | null
      return {
        name: (tr.querySelector('td:nth-child(2) span')?.textContent ?? '').trim(),
        locked: Boolean(lock),
        warned: Boolean(warn),
        checked: Boolean(input?.checked),
        title: (lock ?? warn)?.getAttribute('title') ?? ''
      }
    })
  )
}

async function dupeRows(h: AppHandle): Promise<{ path: string; locked: boolean; warned: boolean; checked: boolean; text: string }[]> {
  return h.page.$$eval('li', (lis) =>
    lis
      .filter((li) => li.querySelector('p.font-mono[title]'))
      .map((li) => {
        const input = li.querySelector('input[type=checkbox]') as unknown as { checked: boolean } | null
        return {
          path: li.querySelector('p.font-mono[title]')?.getAttribute('title') ?? '',
          locked: Boolean(li.querySelector('[data-testid=locked]')),
          warned: Boolean(li.querySelector('[data-testid=warned]')),
          checked: Boolean(input?.checked),
          text: (li as unknown as { innerText: string }).innerText
        }
      })
  )
}

/** Se o diálogo listar avisos do guard, marca a caixa de ciência (e confere que sem ela não dá para confirmar). */
async function ackIfNeeded(h: AppHandle): Promise<void> {
  const box = h.page.getByTestId('delete-warnings')
  if (!(await box.count())) return
  check(await h.page.getByTestId('delete-confirm').isDisabled(), 'há avisos: confirmar desativado até marcar a ciência')
  await box.locator('input[type=checkbox]').click()
}

async function waitGuard(h: AppHandle): Promise<void> {
  await h.page.waitForTimeout(300)
  await h.page.waitForSelector('text=verificando proteção...', { state: 'detached', timeout: 20_000 }).catch(() => undefined)
  await h.page.waitForTimeout(300)
}

async function fixtureMain(): Promise<void> {
  const outDir = arg('out', 'out-disk')!
  const fx = writeFixture()
  console.log('sandbox:', fx.sb)
  const t0 = Date.now()
  const log = (m: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)
  const errors: string[] = []

  // ---------------- Fase 1: modo Lixeira (padrão), exclusões interceptadas ----------------
  let h = await launchApp({ outDir, userDataDir: fx.userDataDir, screenshotsDir: arg('dir') })
  try {
    const { page } = h
    await blockRealBin(h)
    await intercept(h, 'cleanup:deleteFiles')
    await intercept(h, 'cleanup:deleteDuplicates', [fx.h2])
    await intercept(h, 'disk:findDuplicates')
    await h.goto('disk')
    await page.waitForSelector('text=Mapa de pastas', { timeout: 30_000 })
    await page.locator('button', { hasText: 'Maiores arquivos' }).first().click()
    await waitGuard(h)
    await page.locator('table.tbl').scrollIntoViewIfNeeded()
    log('screenshot: ' + (await h.shot('fix-1-maiores')))
    let rows = await rowsState(h)
    for (const r of rows) console.log(`   ${r.locked ? 'CADEADO' : r.warned ? 'AVISO  ' : 'livre  '} ${r.name}  ${r.title.slice(0, 80)}`)
    const row = (n: string): (typeof rows)[number] => rows.find((r) => r.name === n)!
    check(row('basegame_4_gamedata.archive').locked || row('basegame_4_gamedata.archive').warned, 'arquivo de jogo do inventário (D:\\Jogos) tem cadeado/aviso do guard')
    check(row('x64a.rpf').locked, 'Rockstar Games: cadeado')
    check(row('lang_pt.archive').locked, 'SteamLibrary: cadeado')
    check(row('Premiere.exe').warned || row('Premiere.exe').locked, 'programa do inventário: aviso/cadeado')
    check(row('setup-antigo.exe').warned && !row('setup-antigo.exe').locked, '.exe solto: aviso do guard (selecionável à mão)')
    check(!row('gravacao-2023.mp4').locked && !row('gravacao-2023.mp4').warned, 'vídeo comum: livre')
    check((await page.getByTestId('inventory-hint').count()) === 0, 'com inventário de Jogos & Programas salvo, a dica de inventário não aparece')

    // "Marcar todos" não pega jogo/programa/aviso
    await page.locator('table.tbl thead input[type=checkbox]').click()
    await page.waitForTimeout(300)
    rows = await rowsState(h)
    const marked = rows.filter((r) => r.checked).map((r) => r.name)
    const free = rows.filter((r) => !r.locked && !r.warned).map((r) => r.name)
    console.log('   marcados por "marcar todos":', marked.join(' | '))
    check(marked.length === free.length && free.every((n) => marked.includes(n)), `marcar todos = exatamente os ${free.length} arquivo(s) sem cadeado nem aviso`)
    check(['Windows11_23H2.iso', 'gravacao-2023.mp4'].every((n) => marked.includes(n)), 'arquivos comuns (ISO, vídeo) foram marcados')
    check(!rows.some((r) => (r.locked || r.warned) && r.checked), 'nenhum arquivo com cadeado/aviso entrou em "marcar todos"')
    log('screenshot: ' + (await h.shot('fix-2-marcar-todos')))

    // Marca à mão um item com aviso → confirmação lista o motivo e exige ciência
    await page.locator('table.tbl tbody tr', { hasText: 'setup-antigo.exe' }).locator('input[type=checkbox]').click()
    await page.locator('button', { hasText: 'Mover para a Lixeira' }).first().click()
    await page.waitForSelector('[data-testid=delete-warnings]', { timeout: 15_000 })
    const confirmBtn = page.getByTestId('delete-confirm')
    check(await confirmBtn.isDisabled(), 'com aviso, o botão de confirmar começa desativado')
    const title1 = await page.locator('h2').last().innerText()
    check(title1.includes(`Mover ${marked.length + 1} arquivos para a Lixeira?`), `título no modo Lixeira: "${title1}"`)
    const warnText = await page.getByTestId('delete-warnings').innerText()
    check(/programa instalado|arquivo de programa/i.test(warnText), 'diálogo mostra o motivo do guard para o item com aviso')
    log('screenshot: ' + (await h.shot('fix-3-dialogo-aviso')))
    await page.getByTestId('delete-warnings').locator('input[type=checkbox]').click()
    check(await confirmBtn.isEnabled(), 'depois da caixa de ciência, confirmar fica ativo')
    await confirmBtn.click()
    await page.waitForSelector('text=não foram movidos', { timeout: 15_000 })
    // O resultado fica aberto no diálogo (com o motivo de cada item pulado): fecha
    await page.getByTestId('delete-result-close').click()
    let c = await calls(h)
    const del1 = c.find((x) => x.ch === 'cleanup:deleteFiles')?.req as DeleteFilesRequest
    console.log('   deleteFiles recebeu:', JSON.stringify(del1))
    check(del1?.mode === 'recycle', 'modo Lixeira enviado como mode "recycle"')
    check(del1.paths.length === marked.length + 1 && !del1.paths.some((p) => /Jogos|Rockstar|SteamLibrary|Programas/.test(p)), 'nenhum arquivo de jogo/programa foi enviado para exclusão')

    // ---------------- Duplicados ----------------
    await scrollMainTop(page)
    await page.locator('button', { hasText: 'Duplicados' }).first().click()
    await page.waitForSelector('[data-testid=dupes-stale]', { timeout: 15_000 })
    await waitGuard(h)
    check(/há 3 dias/.test(await page.getByTestId('dupes-stale').innerText()), 'aviso de relatório velho (há 3 dias) com "Procurar de novo"')
    log('screenshot: ' + (await h.shot('fix-4-dupes-velho')))
    await page.locator('button', { hasText: 'Marcar cópias extras' }).first().click()
    await page.waitForTimeout(800)
    const drows = await dupeRows(h)
    for (const r of drows) console.log(`   ${r.checked ? '[x]' : '[ ]'} ${r.locked ? 'CADEADO' : r.warned ? 'AVISO  ' : 'livre  '} ${r.path}  {${r.text.replace(/\s+/g, ' ').slice(-40)}}`)
    const drow = (p: string): (typeof drows)[number] | undefined => drows.find((r) => r.path === W(p))
    check(!drows.some((r) => r.checked && (r.locked || r.warned)), 'marcar cópias extras não marcou cópia com cadeado/aviso')
    check(drows.find((r) => r.path.includes('Jogos'))?.locked, 'cópia dentro da pasta do jogo (inventário): cadeado')
    check(!drows.find((r) => r.path === fx.original)?.checked && !drows.find((r) => r.path === fx.sumiu)?.checked, 'a cópia mais antiga (pessoal) de cada grupo não é marcada')
    // Item 2 (rodada 2): cópia mais antiga dentro da pasta do jogo → a cópia PESSOAL fica
    check(drow('D:/Jogos/Cyberpunk 2077/movies/outro.bk2')?.locked, 'h4: cópia mais antiga é do jogo (cadeado)')
    check(!drow('D:/Videos/outro-backup.bk2')?.checked, 'h4: a cópia pessoal NÃO é marcada (não sobra só a cópia do jogo)')
    check(!drow('D:/Videos/credits.bk2')?.checked && /Fica/.test(drow('D:/Videos/credits.bk2')?.text ?? ''), 'h5: fica a cópia pessoal mais antiga (selo "Fica")')
    check(drow('D:/Videos/Backup/credits-copia.bk2')?.checked, 'h5: só a outra cópia pessoal é marcada')
    check((await page.getByTestId('kept-not-oldest').count()) === 1, 'rodapé explica que, quando a mais antiga é protegida, fica a cópia pessoal')
    // Cópias da sandbox que ficaram de fora (aviso) são marcadas à mão
    for (const p of [fx.copia, fx.unica]) {
      if (!drows.find((r) => r.path === p)?.checked) await page.locator('li', { hasText: path.basename(p) }).locator('input[type=checkbox]').click()
    }
    await page.locator('li', { hasText: 'credits-copia.bk2' }).scrollIntoViewIfNeeded()
    log('screenshot: ' + (await h.shot('fix-5-dupes-marcados')))
    await page.locator('div.sticky').scrollIntoViewIfNeeded()
    log('screenshot: ' + (await h.shot('fix-5b-dupes-rodape')))
    await page.locator('button', { hasText: 'Mover cópias para a Lixeira' }).first().click()
    await page.waitForSelector('[data-testid=delete-dialog]', { timeout: 15_000 })
    await waitTextGone(page, 'Conferindo a proteção')
    // Item 3: o diálogo deixa claro que "deve ficar" vem da busca e que tudo é conferido de novo antes de apagar
    const dlgText = await page.getByTestId('delete-dialog').innerText()
    check(/Deve ficar:/.test(dlgText), 'diálogo mostra qual cópia deve ficar em cada grupo')
    check(/Tudo é conferido de novo no disco antes de apagar/.test(dlgText) && /vem da busca feita há 3 dias/.test(dlgText), 'diálogo avisa que a lista é da busca (há 3 dias) e que tudo é reconferido antes de apagar')
    const keepLines = await page.getByTestId('dupes-keep').allInnerTexts()
    console.log('   linhas "deve ficar":', JSON.stringify(keepLines))
    check(keepLines.some((t) => t.includes(W('D:/Videos/credits.bk2')) && /\(\+1\)/.test(t)), 'h5: "deve ficar" mostra a cópia pessoal (não a do jogo, que vem antes na lista)')
    check(keepLines.every((t) => /conferido no disco antes de apagar/.test(t)), 'cada linha "deve ficar" diz que é conferida no disco antes de apagar')
    log('screenshot: ' + (await h.shot('fix-6-dupes-dialogo')))
    await ackIfNeeded(h)
    await page.getByTestId('delete-confirm').click()
    for (let i = 0; i < 50 && !(await calls(h)).some((x) => x.ch === 'cleanup:deleteDuplicates'); i++) await page.waitForTimeout(200)
    c = await calls(h)
    const dd = c.find((x) => x.ch === 'cleanup:deleteDuplicates')?.req as DeleteDuplicatesRequest
    console.log('   deleteDuplicates recebeu:', JSON.stringify(dd))
    check(dd?.mode === 'recycle' && dd.groups.length === 3, 'deleteDuplicates com 3 grupos (h1, h2, h5), mode "recycle"')
    const g1 = dd.groups.find((g) => g.hash === fx.h1)!
    const g2 = dd.groups.find((g) => g.hash === fx.h2)!
    const g5 = dd.groups.find((g) => g.hash === 'h5')!
    check(g1.keep[0].path === fx.original && g1.remove[0].path === fx.copia && g1.remove[0].lastWrite > 0, 'grupo h1: keep=original, remove=copia (com lastWrite)')
    check(g2.keep[0].path === fx.sumiu && g2.remove[0].path === fx.unica, 'grupo h2: keep=original sumido, remove=unica (o backend deve pular o grupo)')
    check(
      g5.remove.length === 1 && g5.remove[0].path === W('D:/Videos/Backup/credits-copia.bk2') && g5.keep.some((k) => k.path === W('D:/Videos/credits.bk2')),
      'grupo h5: remove só a cópia pessoal mais nova; a pessoal mais antiga fica'
    )
    check(!dd.groups.some((g) => g.hash === 'h4'), 'grupo h4 (jogo + pessoal) não foi enviado')
    check(!c.some((x) => x.ch === 'cleanup:deleteFiles' && (x.req as DeleteFilesRequest).paths.includes(fx.copia)), 'duplicados NÃO vão mais por deleteFiles (caminhos soltos)')

    // Item 3: o backend pulou o grupo h2 por estar desatualizado → resultado mostra o motivo e "Procurar de novo"
    await page.waitForSelector('[data-testid=delete-result-stale]', { timeout: 15_000 })
    const resText = await page.getByTestId('delete-result').innerText()
    console.log('   resultado:', resText.replace(/\s+/g, ' '))
    check(/1 grupo\(s\) foram pulados/.test(resText) && /a cópia que ficaria não existe mais ou mudou/.test(resText), 'resultado mostra o grupo pulado e o motivo do backend')
    check(/unica\.bin/.test(resText), 'resultado diz qual arquivo foi pulado (unica.bin)')
    check(/Teste de interface/.test(resText), 'outros motivos (não desatualizado) aparecem separados')
    check((await page.getByTestId('delete-result-rescan').count()) === 1, 'resultado oferece "Procurar de novo"')
    check((await page.locator('text=foram pulados e nada deles foi movido').count()) >= 1, 'toast também avisa do grupo pulado')
    log('screenshot: ' + (await h.shot('fix-11-dupes-resultado-pulado')))
    await page.locator('button', { hasText: 'Fechar' }).last().click()
    await page.waitForSelector('[data-testid=dupes-skipped-stale]', { timeout: 10_000 })
    check(/1 grupo\(s\)/.test(await page.getByTestId('dupes-skipped-stale').innerText()), 'depois de fechar, a aba Duplicados mantém o aviso com "Procurar de novo"')
    await page.getByTestId('dupes-skipped-stale').scrollIntoViewIfNeeded()
    log('screenshot: ' + (await h.shot('fix-12-dupes-aviso-pulado')))
    await page.getByTestId('dupes-skipped-stale').locator('button', { hasText: 'Procurar de novo' }).click()
    for (let i = 0; i < 50 && !(await calls(h)).some((x) => x.ch === 'disk:findDuplicates'); i++) await page.waitForTimeout(200)
    const fd = (await calls(h)).find((x) => x.ch === 'disk:findDuplicates')?.req as DuplicatesOptions | undefined
    console.log('   findDuplicates recebeu:', JSON.stringify(fd))
    check(fd && fd.roots.includes('D:\\'), '"Procurar de novo" refaz a busca (findDuplicates interceptado, nada lido)')
    await page.waitForSelector('[data-testid=dupes-skipped-stale]', { state: 'detached', timeout: 10_000 })
    check(true, 'o aviso de grupos pulados some ao procurar de novo')

    // Parar uma exclusão em andamento: progresso no diálogo + botão "Parar" → cleanup.cancelDelete
    await h.app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { __fixCalls: unknown[]; __cancelled?: boolean }
      ipcMain.removeHandler('cleanup:cancelDelete')
      ipcMain.handle('cleanup:cancelDelete', async () => {
        g.__fixCalls.push({ ch: 'cleanup:cancelDelete', req: null })
        g.__cancelled = true
      })
      ipcMain.removeHandler('cleanup:deleteFiles')
      ipcMain.handle('cleanup:deleteFiles', async (e, req: { paths: string[] }) => {
        g.__fixCalls.push({ ch: 'cleanup:deleteFiles', req })
        e.sender.send('cleanup:progress', { task: 'cleanup:delete', phase: 'deleting', current: 1, total: req.paths.length, percent: Math.round(100 / req.paths.length) })
        for (let i = 0; i < 150 && !g.__cancelled; i++) await new Promise((r) => setTimeout(r, 100))
        return { deleted: [], skipped: req.paths.map((p) => ({ path: p, reason: 'Cancelado.' })), bytesFreed: 0 }
      })
    })
    await page.waitForSelector('text=não foram movidos', { state: 'detached', timeout: 15_000 }).catch(() => undefined)
    await scrollMainTop(page)
    await page.locator('button', { hasText: 'Maiores arquivos' }).first().click()
    await waitGuard(h)
    // A seleção é da página (continua marcada desde o começo): limpa e marca de novo
    if (await page.getByTestId('selection-bar').count()) await page.getByTestId('selection-bar').locator('button', { hasText: 'Limpar seleção' }).click()
    await page.locator('table.tbl thead input[type=checkbox]').click()
    await page.locator('button', { hasText: 'Mover para a Lixeira' }).first().click()
    await page.waitForSelector('[data-testid=delete-dialog]', { timeout: 15_000 })
    await waitTextGone(page, 'Conferindo a proteção')
    await page.getByTestId('delete-confirm').click()
    // Botão "Parar" do diálogo (texto exato: o menu lateral tem "Reparar Erros")
    const stopBtn = page.locator('button', { hasText: /^\s*Parar\s*$/ })
    await stopBtn.first().waitFor({ timeout: 10_000 })
    await page.waitForSelector('text=Movendo para a Lixeira: 1 de', { timeout: 10_000 })
    log('screenshot: ' + (await h.shot('fix-10-parar')))
    await stopBtn.first().click()
    await page.waitForSelector('text=Cancelado.', { timeout: 15_000 })
    check((await calls(h)).some((x) => x.ch === 'cleanup:cancelDelete'), '"Parar" chama cleanup.cancelDelete e o diálogo fecha com o resultado')
    errors.push(...h.consoleErrors)
  } finally {
    await h.close()
  }

  // ---------------- Fase 2: Configurações → "Apagar de vez" (exclusão real só na sandbox) ----------------
  h = await launchApp({ outDir, userDataDir: fx.userDataDir, screenshotsDir: arg('dir') })
  try {
    const { page } = h
    // Só a busca de duplicados é interceptada (para testar "Procurar de novo" sem ler o D: real); exclusões são reais.
    await blockRealBin(h)
    await intercept(h, 'disk:findDuplicates')
    await page.evaluate(() => (globalThis as unknown as PageGlobal).api.settings.update({ deleteMode: 'permanent' }))
    await h.goto('disk')
    await page.waitForSelector('text=Mapa de pastas', { timeout: 30_000 })
    await page.locator('button', { hasText: 'Maiores arquivos' }).first().click()
    await waitGuard(h)
    await page.locator('table.tbl tbody tr', { hasText: 'clip-antigo.mp4' }).locator('input[type=checkbox]').click()
    check((await page.locator('button', { hasText: 'Apagar de vez' }).count()) === 1, 'botão da barra vira "Apagar de vez" quando a configuração é permanente')
    await page.locator('button', { hasText: 'Apagar de vez' }).first().click()
    await page.waitForSelector('[data-testid=delete-dialog]', { timeout: 15_000 })
    await waitTextGone(page, 'Conferindo a proteção')
    const title2 = await page.locator('h2').last().innerText()
    check(/Apagar de vez 1 arquivo\? Não dá para recuperar/.test(title2), `título de perigo: "${title2}"`)
    const btn = page.getByTestId('delete-confirm')
    log('screenshot: ' + (await h.shot('fix-7-permanente')))
    await ackIfNeeded(h)
    check(await btn.isDisabled(), 'confirmar desativado até digitar APAGAR')
    await page.getByTestId('delete-dialog').locator('input.input').fill('APAGAR')
    check(await btn.isEnabled(), 'digitando APAGAR, confirmar fica ativo')
    await btn.click()
    await page.waitForSelector('text=apagado de vez', { timeout: 20_000 })
    const toastText = await page.locator('text=apagado de vez').first().innerText()
    check(!/Lixeira/.test(toastText), `toast sem falar de Lixeira: "${toastText}"`)
    check(!existsSync(fx.clip), 'arquivo da sandbox foi apagado de vez')
    log('screenshot: ' + (await h.shot('fix-8-permanente-feito')))
    const logEntries = (await page.evaluate(() => (globalThis as unknown as PageGlobal).api.system.getActionLog(5))) as {
      action: string
      details?: { mode?: string }
    }[]
    const entry = logEntries.find((e) => e.action === 'cleanup.deleteFiles')
    check(entry?.details?.mode === 'permanent', 'histórico registra mode "permanent"')
    // espera o toast sumir para não confundir com o resultado dos duplicados
    await page.waitForSelector('text=apagado de vez', { state: 'detached', timeout: 15_000 }).catch(() => undefined)

    // Duplicados em modo permanente com o backend REAL: só cópias da sandbox são marcadas (à mão). O grupo h2
    // (o "original" foi apagado fora do app) tem de ser pulado pelo backend e o resultado tem de dizer por quê.
    await scrollMainTop(page)
    await page.locator('button', { hasText: 'Duplicados' }).first().click()
    await waitGuard(h)
    for (const p of [fx.copia, fx.unica]) await page.locator('li', { hasText: path.basename(p) }).locator('input[type=checkbox]').click()
    await page.waitForTimeout(300)
    const drows2 = await dupeRows(h)
    const checked2 = drows2.filter((r) => r.checked).map((r) => r.path)
    console.log('   marcadas (fase 2):', JSON.stringify(checked2))
    check(checked2.length === 2 && checked2.every((p) => p.startsWith(fx.sb)), 'fase 2: só cópias da sandbox estão marcadas')
    await page.locator('button', { hasText: 'Apagar cópias de vez' }).first().click()
    await page.waitForSelector('[data-testid=delete-dialog]', { timeout: 15_000 })
    await waitTextGone(page, 'Conferindo a proteção')
    check(/Tudo é conferido de novo no disco antes de apagar/.test(await page.getByTestId('delete-dialog').innerText()), 'modo permanente: diálogo também avisa da reconferência')
    await ackIfNeeded(h)
    await page.getByTestId('delete-dialog').locator('input.input').fill('APAGAR')
    await page.getByTestId('delete-confirm').click()
    const outcome = await Promise.race([
      page.waitForSelector('text=ainda não está disponível', { timeout: 20_000 }).then(() => 'not-implemented'),
      page.waitForSelector('[data-testid=delete-result]', { timeout: 20_000 }).then(() => 'result'),
      page.waitForSelector('text=apagado(s) de vez', { timeout: 20_000 }).then(() => 'deleted')
    ]).catch(() => 'timeout')
    await page.waitForTimeout(600)
    log('screenshot: ' + (await h.shot('fix-9-dupes-permanente')))
    console.log('   deleteDuplicates (real):', outcome)
    check(existsSync(fx.original), 'a cópia mantida (original.bin) continua no disco')
    check(existsSync(fx.unica), 'grupo com o "original" sumido foi pulado: unica.bin continua no disco')
    check(outcome === 'result', 'backend real pulou um grupo → o diálogo mostra o resultado (não fecha calado)')
    check(!existsSync(fx.copia), 'cópia extra válida (copia.bin) apagada de vez')
    const res2 = await page.getByTestId('delete-result').innerText()
    console.log('   resultado (backend real):', res2.replace(/\s+/g, ' '))
    check(/1 cópia\(s\) apagada\(s\) de vez/.test(res2), 'resultado: 1 cópia apagada de vez')
    check(/1 grupo\(s\) foram pulados/.test(res2) && /unica\.bin/.test(res2) && /não existe mais ou mudou/.test(res2), 'resultado: grupo h2 pulado com o motivo do backend real')
    // "Procurar de novo" no próprio resultado: fecha e refaz a busca (findDuplicates interceptado nesta fase)
    await page.getByTestId('delete-result-rescan').click()
    await page.waitForSelector('[data-testid=delete-result]', { state: 'detached', timeout: 10_000 })
    for (let i = 0; i < 50 && !(await calls(h)).some((x) => x.ch === 'disk:findDuplicates'); i++) await page.waitForTimeout(200)
    const fd2 = (await calls(h)).find((x) => x.ch === 'disk:findDuplicates')?.req as DuplicatesOptions | undefined
    console.log('   findDuplicates recebeu (fase 2):', JSON.stringify(fd2))
    check(fd2?.roots.includes('D:\\') && fd2.minBytes === 10 * 1024 ** 2, '"Procurar de novo" do resultado refaz a busca com as mesmas unidades e tamanho mínimo')
    errors.push(...h.consoleErrors)
  } finally {
    await h.close()
  }
  if (errors.length) console.log('ERROS NO CONSOLE:\n' + errors.join('\n'))
  else console.log('Sem erros no console.')
  console.log('FIXTURE OK')
}

// ------------------------------------------------------------------------------------------------
// --folders (rodada 3): apagar PASTAS do mapa. Sandbox e userData próprios em %TEMP%\iacleaner-r3-disk-delete\folders\.
// Fase A: exclusões, Lixeira (tamanho/esvaziar) e a conferência de análise desatualizada são INTERCEPTADAS no main
//         (nada é apagado, a Lixeira real não é medida nem esvaziada).
// Fase B: backend REAL, modo "Apagar de vez", só com pastas da sandbox (nunca a Lixeira real).
// ------------------------------------------------------------------------------------------------

interface FoldersFixture {
  base: string
  userDataDir: string
  sb: string
  pastaVelha: string
  sumiuAntes: string
}

const GB = 1024 ** 3
function node(p: string, bytes: number, children: DirNode[] = [], fileBytes = 0, files = 10): DirNode {
  const sum = children.reduce((s, c) => s + c.bytes, 0)
  return {
    name: /^[A-Z]:\\$/i.test(p) ? p : p.slice(p.lastIndexOf('\\') + 1),
    path: p,
    bytes,
    files: files + children.reduce((s, c) => s + c.files, 0),
    dirs: children.reduce((s, c) => s + c.dirs + 1, 0),
    lastWrite: Date.now() - 40 * DAY,
    children: children.length ? children : undefined,
    otherBytes: bytes - sum,
    fileBytes
  }
}

function driveOf(root: string, tree: DirNode, topFiles: FileEntry[]): DriveScanResult {
  return {
    root,
    scannedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
    durationMs: 9000,
    totalBytes: tree.bytes,
    files: tree.files,
    dirs: tree.dirs,
    cloudOnlyBytes: 0,
    inaccessibleDirs: 0,
    tree,
    topFiles,
    oldLargeFiles: [],
    categories: [{ category: 'video', bytes: 124 * GB, files: 300 }],
    engine: 'native',
    extensions: []
  }
}

function writeFoldersFixture(): FoldersFixture {
  const base = path.join(os.tmpdir(), 'iacleaner-r3-disk-delete', 'folders')
  const userDataDir = path.join(base, 'ui-userdata')
  const sb = path.join(base, 'sandbox')
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(sb, { recursive: true, force: true })
  mkdirSync(path.join(userDataDir, 'state'), { recursive: true })
  const pastaVelha = path.join(sb, 'PastaVelha')
  const sumiuAntes = path.join(sb, 'SumiuAntes') // não existe no disco (apagada "fora do app")
  mkdirSync(path.join(pastaVelha, 'Sub'), { recursive: true })
  writeFileSync(path.join(pastaVelha, 'gravacao.mp4'), randomBytes(200 * 1024))
  writeFileSync(path.join(pastaVelha, 'Sub', 'notas.txt'), 'teste')

  const now = Date.now()
  const pubg = node(W("D:/Gravacoes NVIDIA/PLAYERUNKNOWN'S BATTLEGROUNDS"), 100 * GB, [], 100 * GB, 300)
  const peak = node(W('D:/Gravacoes NVIDIA/PEAK'), 20 * GB, [], 20 * GB, 40)
  const D = node(
    'D:\\',
    300 * GB,
    [
      node(W('D:/Gravacoes NVIDIA'), 120 * GB, [pubg, peak]),
      node(W('D:/Jogos'), 70 * GB, [node(W('D:/Jogos/Cyberpunk 2077'), 70 * GB, [node(W('D:/Jogos/Cyberpunk 2077/archive'), 60 * GB)])]),
      node(W('D:/SteamLibrary'), 40 * GB, [node(W('D:/SteamLibrary/steamapps'), 40 * GB)]),
      node(W('D:/.DICloakCache'), 23 * GB, [], 23 * GB),
      node(W('D:/xampp'), 15 * GB, [node(W('D:/xampp/mysql'), 9 * GB)]),
      node(W('D:/Program Files'), 10 * GB),
      node(W('D:/Downloads antigos'), 8 * GB, [], 8 * GB),
      node(W('D:/Antigo Projeto'), 5 * GB, [], 5 * GB)
    ],
    0
  )
  const fe = (p: string, gb: number, category: FileEntry['category'], ext: string): FileEntry => ({
    path: W(p),
    bytes: Math.round(gb * GB),
    lastWrite: now - 300 * DAY,
    lastAccess: now - 300 * DAY,
    ext,
    category
  })
  const dTop = [
    fe('D:/Jogos/Cyberpunk 2077/archive/basegame.archive', 9.8, 'gameData', 'archive'),
    fe("D:/Gravacoes NVIDIA/PLAYERUNKNOWN'S BATTLEGROUNDS/clip-01.DVR.mp4", 4, 'video', 'mp4'),
    fe('D:/ISOs/Windows11.iso', 1.5, 'diskImage', 'iso')
  ]
  // C:\: pastas reais do sistema (só o guard as lê) + a cadeia até a sandbox (em %TEMP%)
  const parts = sb.split('\\') // ['C:', 'Users', '<usuario>', 'AppData', 'Local', 'Temp', ...]
  let chain = node(sb, 1 * GB, [node(pastaVelha, 0.6 * GB, [node(path.join(pastaVelha, 'Sub'), 0.1 * GB)], 0.5 * GB), node(sumiuAntes, 0.4 * GB, [], 0.4 * GB)])
  for (let i = parts.length - 1; i >= 2; i--) {
    const p = parts.slice(0, i).join('\\')
    chain = node(p, (i === 2 ? 200 : 1 + (parts.length - i) * 0.01) * GB, [chain])
  }
  const C = node('C:\\', 260 * GB, [
    chain,
    node(W('C:/Windows'), 30 * GB, [node(W('C:/Windows/WinSxS'), 12 * GB)]),
    node(W('C:/ProgramData'), 25 * GB, [node(W('C:/ProgramData/BlueStacks_nxt'), 18.5 * GB)])
  ])
  const scan: ScanResult = {
    id: 'r3-folders',
    startedAt: new Date(now - 2 * 3600_000).toISOString(),
    finishedAt: new Date(now - 2 * 3600_000).toISOString(),
    drives: [driveOf('C:\\', C, []), driveOf('D:\\', D, dTop)]
  }
  const apps = {
    collectedAt: new Date(now - DAY).toISOString(),
    games: [
      {
        id: 'other:cyberpunk',
        launcher: 'other',
        name: 'Cyberpunk 2077 (teste)',
        installPath: W('D:/Jogos/Cyberpunk 2077'),
        drive: 'D:',
        bytes: 70 * GB,
        uninstall: { kind: 'settings', value: 'ms-settings:appsfeatures', label: 'Desinstalar pelo Windows' },
        exists: true
      }
    ],
    programs: [{ id: 'reg:xampp', name: 'XAMPP (teste)', installPath: W('D:/xampp'), source: 'registry', scope: 'machine' }],
    launchers: []
  }
  const put = (rel: string, v: unknown): void => writeFileSync(path.join(userDataDir, rel), JSON.stringify(v))
  put('state/scan.json', scan)
  put('state/duplicates.json', [])
  put('state/apps.json', apps)
  return { base, userDataDir, sb, pastaVelha, sumiuAntes }
}

type FolderCall = { ch: string; req: unknown }

/** Fase A: troca os handlers que alteram o PC (ou leem a Lixeira real) por gravadores com respostas roteirizadas. */
async function interceptFolders(h: AppHandle): Promise<void> {
  await h.app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __r3?: { ch: string; req: unknown }[]; __fresh?: number }
    g.__r3 = []
    g.__fresh = 0
    const rec = (ch: string, req: unknown): void => {
      g.__r3!.push({ ch, req })
    }
    const swap = (ch: string, fn: (req: unknown) => unknown): void => {
      ipcMain.removeHandler(ch)
      ipcMain.handle(ch, async (_e, req) => {
        rec(ch, req)
        return fn(req)
      })
    }
    swap('cleanup:deleteFiles', (raw) => {
      const req = raw as { paths: string[]; mode: string }
      const deleted: string[] = []
      const skipped: { path: string; reason: string; code: string }[] = []
      for (const p of req.paths) {
        if (req.mode === 'recycle' && /Gravacoes NVIDIA$/i.test(p))
          skipped.push({ path: p, reason: 'Grande demais para a Lixeira deste disco.', code: 'tooBigForRecycle' })
        else if (req.mode === 'recycle' && /DICloakCache/i.test(p))
          skipped.push({ path: p, reason: 'Em uso por outro programa (feche o programa e tente de novo).', code: 'inUse' })
        else deleted.push(p)
      }
      return { deleted, skipped, bytesFreed: 0 }
    })
    swap('cleanup:deleteDuplicates', () => ({ deleted: [], skipped: [], bytesFreed: 0 }))
    swap('cleanup:getRecycleBinInfo', () => ({
      bytes: Math.round(12.3 * 1024 ** 3),
      items: 57,
      perDrive: [
        { drive: 'C:', bytes: Math.round(4.3 * 1024 ** 3) },
        { drive: 'D:', bytes: 8 * 1024 ** 3 }
      ]
    }))
    swap('cleanup:emptyRecycleBin', () => ({ ok: true, message: 'Lixeira esvaziada (teste de interface: nada foi apagado).', bytesFreed: 0 }))
    swap('disk:checkScanFreshness', () => {
      g.__fresh = (g.__fresh ?? 0) + 1
      const missing = g.__fresh === 1 ? [{ path: 'D:\\Antigo Projeto', root: 'D:\\', kind: 'dir', bytes: 5 * 1024 ** 3 }] : []
      return {
        checkedAt: new Date().toISOString(),
        checked: 120,
        missing,
        missingCount: missing.length,
        missingBytes: missing.reduce((s, m) => s + m.bytes, 0),
        unavailableRoots: []
      }
    })
    swap('disk:startScan', () => ({ scanId: 'nao-deveria' }))
    swap('disk:findDuplicates', () => [])
  })
}
const r3Calls = (h: AppHandle): Promise<FolderCall[]> => h.app.evaluate(() => ((globalThis as unknown as { __r3?: FolderCall[] }).__r3 ?? []) as FolderCall[])

interface FolderRow {
  path: string
  locked: boolean
  covered: boolean
  warned: boolean
  checked: boolean
  reason: string
  alt: string
}
async function folderRows(h: AppHandle): Promise<FolderRow[]> {
  return h.page.$$eval('tr[data-testid=folder-row]', (trs) =>
    trs.map((tr) => {
      const input = tr.querySelector('input[type=checkbox]') as unknown as { checked: boolean } | null
      return {
        path: tr.getAttribute('data-path') ?? '',
        locked: Boolean(tr.querySelector('[data-testid=folder-locked]')),
        covered: Boolean(tr.querySelector('[data-testid=folder-covered]')),
        warned: Boolean(tr.querySelector('[data-testid=folder-warned]')),
        checked: Boolean(input?.checked),
        reason: (tr.querySelector('[data-testid=folder-reason]')?.textContent ?? '').trim(),
        alt: (tr.querySelector('[data-testid=alt-action]')?.textContent ?? tr.querySelector('[data-testid=alt-drill]')?.textContent ?? '').trim()
      }
    })
  )
}
async function rowOf(h: AppHandle, p: string): Promise<ReturnType<Page['locator']>> {
  const paths = await h.page.$$eval('tr[data-testid=folder-row]', (trs) => trs.map((tr) => tr.getAttribute('data-path') ?? ''))
  const i = paths.indexOf(p)
  if (i < 0) throw new Error(`linha não encontrada: ${p} (tem: ${paths.join(' | ')})`)
  return h.page.locator('tr[data-testid=folder-row]').nth(i)
}
async function rightClickTile(h: AppHandle, p: string): Promise<void> {
  const paths = await h.page.$$eval('g[data-testid=tile]', (gs) => gs.map((g) => g.getAttribute('data-path') ?? ''))
  const i = paths.indexOf(p)
  if (i < 0) throw new Error(`retângulo não encontrado: ${p}`)
  await h.page.locator('g[data-testid=tile]').nth(i).click({ button: 'right' })
  await h.page.waitForSelector('[data-testid=tile-menu]', { timeout: 5000 })
}
async function waitFolderGuard(h: AppHandle): Promise<void> {
  await h.page.waitForTimeout(250)
  await h.page.waitForSelector('[data-testid=folder-guard-loading]', { state: 'detached', timeout: 30_000 }).catch(() => undefined)
  await h.page.waitForTimeout(250)
}
async function enter(h: AppHandle, p: string): Promise<void> {
  await (await rowOf(h, p)).locator('td:nth-child(2) button').first().click()
  await waitFolderGuard(h)
}
const barText = async (h: AppHandle): Promise<string> =>
  (await h.page.getByTestId('selection-bar').count()) ? (await h.page.getByTestId('selection-bar').innerText()).replace(/\s+/g, ' ') : ''

async function foldersMain(): Promise<void> {
  const outDir = arg('out', 'out-r3-disk-delete')!
  const fx = writeFoldersFixture()
  console.log('sandbox:', fx.sb)
  const t0 = Date.now()
  const log = (m: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)
  const errors: string[] = []
  const D = (p: string): string => W(`D:/${p}`)

  // ---------------- Fase A: tudo interceptado ----------------
  let h = await launchApp({ outDir, userDataDir: fx.userDataDir, screenshotsDir: arg('dir') })
  try {
    const { page } = h
    await interceptFolders(h)
    await h.goto('disk')
    await page.waitForSelector('text=Mapa de pastas', { timeout: 30_000 })
    await page.locator('button', { hasText: /^D:\\/ }).first().click()
    await waitFolderGuard(h)
    await page.waitForSelector('[data-testid=stale-scan]', { timeout: 10_000 })
    check(/Antigo Projeto/.test(await page.getByTestId('stale-scan').innerText()), 'aviso "algumas pastas não existem mais" com o exemplo (Antigo Projeto)')
    await page.getByTestId('folder-map').scrollIntoViewIfNeeded()
    log('screenshot: ' + (await h.shot('r3-1-mapa-d')))
    let rows = await folderRows(h)
    for (const r of rows) console.log(`   ${r.locked ? 'CADEADO' : r.warned ? 'AVISO  ' : 'livre  '} ${r.path}  ${r.reason.slice(0, 70)}  [${r.alt}]`)
    const row = (p: string): FolderRow => rows.find((r) => r.path === p) ?? ({} as FolderRow)
    check(row(D('SteamLibrary')).locked && /Jogos & Programas/.test(row(D('SteamLibrary')).alt), 'SteamLibrary: cadeado + "Jogos & Programas"')
    check(row(D('Jogos')).locked && /Contém "Cyberpunk 2077"/.test(row(D('Jogos')).reason), 'D:\\Jogos (jogo do inventário dentro): cadeado com "Contém Cyberpunk 2077"')
    check(row(D('xampp')).locked && /programa instalado/i.test(row(D('xampp')).reason) && /Jogos & Programas/.test(row(D('xampp')).alt), 'xampp (programa do inventário): cadeado + desinstalar')
    check(row(D('Program Files')).locked, 'D:\\Program Files: cadeado')
    for (const p of ['Gravacoes NVIDIA', 'Downloads antigos', '.DICloakCache']) check(!row(D(p)).locked, `${p}: liberada`)

    // Seleção por checkbox
    for (const p of ['Gravacoes NVIDIA', 'Downloads antigos']) await (await rowOf(h, D(p))).locator('input[type=checkbox]').click()
    let bar = await barText(h)
    console.log('   barra:', bar)
    check(/Para apagar: 2 pastas ·/.test(bar) && /128 GB/.test(bar), 'barra fixa soma 2 pastas (128 GB)')
    log('screenshot: ' + (await h.shot('r3-2-selecao')))

    // Dentro da pasta marcada: subpastas aparecem incluídas (marcadas e travadas)
    await enter(h, D('Gravacoes NVIDIA'))
    rows = await folderRows(h)
    check(rows.length === 2 && rows.every((r) => r.covered && r.checked), 'subpastas de uma pasta marcada aparecem como "já incluídas"')
    check((await page.getByTestId('current-folder-selected').count()) === 1, 'aviso "esta pasta está marcada para apagar"')
    await rightClickTile(h, D("Gravacoes NVIDIA/PLAYERUNKNOWN'S BATTLEGROUNDS"))
    check(/Já incluída/.test(await page.getByTestId('tile-menu').innerText()), 'menu do treemap: subpasta já incluída na pasta marcada')
    log('screenshot: ' + (await h.shot('r3-3-menu-incluida')))
    await page.keyboard.press('Escape')
    await page.locator('button', { hasText: 'Subir' }).first().click()
    await waitFolderGuard(h)

    // Menu do botão direito: marcar uma pasta liberada; ver motivo + alternativa numa protegida
    await rightClickTile(h, D('.DICloakCache'))
    await page.getByTestId('tile-menu-toggle').click()
    check(/Para apagar: 3 pastas ·/.test(await barText(h)), 'menu "Marcar para apagar" soma na barra (3 pastas)')
    await rightClickTile(h, D('SteamLibrary'))
    const menuText = await page.getByTestId('tile-menu').innerText()
    check(/Steam/.test(menuText) && (await page.getByTestId('tile-menu-alt').count()) === 1 && (await page.getByTestId('tile-menu-delete').count()) === 0, 'menu de pasta protegida: motivo + "o que fazer", sem apagar')
    log('screenshot: ' + (await h.shot('r3-4-menu-protegida')))
    await page.keyboard.press('Escape')

    // Outra aba: arquivo dentro de pasta marcada aparece incluído; ISO livre soma na mesma barra
    await page.locator('button', { hasText: 'Maiores arquivos' }).first().click()
    await waitGuard(h)
    check((await page.getByTestId('covered').count()) === 1, 'Maiores arquivos: clip dentro da pasta marcada aparece "já incluído"')
    await page.locator('table.tbl tbody tr', { hasText: 'Windows11.iso' }).locator('input[type=checkbox]').click()
    bar = await barText(h)
    console.log('   barra:', bar)
    check(/3 pastas e 1 arquivo/.test(bar) && /153 GB/.test(bar), 'barra soma entre abas: 3 pastas e 1 arquivo (152,5 GB → "153 GB")')
    log('screenshot: ' + (await h.shot('r3-5-maiores-somado')))

    // Confirmação (Lixeira)
    await page.getByTestId('selection-delete').click()
    await page.waitForSelector('[data-testid=delete-dialog]', { timeout: 15_000 })
    await waitTextGone(page, 'Conferindo a proteção')
    const title = await page.locator('h2').last().innerText()
    check(/Mover 3 pastas e 1 arquivo para a Lixeira\?/.test(title), `título: "${title}"`)
    check((await page.getByTestId('folders-recheck-note').count()) === 1, 'diálogo explica que pastas vão inteiras e são conferidas de novo no disco')
    check(/pasta inteira/.test(await page.getByTestId('delete-dialog').innerText()), 'lista mostra "pasta inteira"')
    log('screenshot: ' + (await h.shot('r3-6-dialogo')))
    await ackIfNeeded(h)
    await page.getByTestId('delete-confirm').click()
    await page.waitForSelector('[data-testid=delete-files-result]', { timeout: 15_000 })
    let c = await r3Calls(h)
    const req1 = c.find((x) => x.ch === 'cleanup:deleteFiles')?.req as DeleteFilesRequest
    console.log('   deleteFiles recebeu:', JSON.stringify(req1))
    check(req1.mode === 'recycle' && req1.paths.length === 4 && !req1.paths.some((p) => /clip-01/.test(p)), 'pedido: Lixeira, 4 itens, sem o arquivo que já está dentro da pasta')
    await page.waitForTimeout(500)
    const res = (await page.getByTestId('delete-files-result').innerText()).replace(/\s+/g, ' ')
    console.log('   resultado:', res)
    check(/Grandes demais para a Lixeira \(1\)/.test(res) && /Gravacoes NVIDIA/.test(res), 'resultado: grupo "Grandes demais para a Lixeira"')
    check(/Em uso \(1\)/.test(res) && /DICloakCache/.test(res), 'resultado: grupo "Em uso" com o motivo')
    check((await page.getByTestId('delete-result-bin').count()) === 1, 'resultado explica que o espaço só volta depois de esvaziar a Lixeira')
    check(/12,3 GB/.test(await page.getByTestId('delete-result-empty-bin').innerText()), 'botão "Esvaziar Lixeira agora (12,3 GB)"')
    check(/120 GB/.test(await page.getByTestId('delete-result-permanent').innerText()), 'botão "Apagar de vez (120 GB)..." para o que não cabe na Lixeira')
    log('screenshot: ' + (await h.shot('r3-7-resultado')))

    // "Apagar de vez" (confirmação forte)
    await page.getByTestId('delete-result-permanent').click()
    await page.waitForSelector('[data-testid=delete-toobig-note]', { timeout: 15_000 })
    await waitTextGone(page, 'Conferindo a proteção')
    const t2 = await page.locator('h2').last().innerText()
    check(/Apagar de vez 1 pasta\? Não dá para recuperar/.test(t2), `título forte: "${t2}"`)
    const btn = page.getByTestId('delete-confirm')
    check(await btn.isDisabled(), 'confirmar desativado até digitar APAGAR')
    await page.getByTestId('delete-dialog').locator('input.input').fill('APAGAR')
    check(await btn.isEnabled(), 'digitando APAGAR, confirmar fica ativo')
    log('screenshot: ' + (await h.shot('r3-8-apagar-de-vez')))
    await btn.click()
    await page.waitForSelector('[data-testid=delete-dialog]', { state: 'detached', timeout: 15_000 })
    c = await r3Calls(h)
    const req2 = c.filter((x) => x.ch === 'cleanup:deleteFiles')[1]?.req as DeleteFilesRequest
    console.log('   deleteFiles (de vez) recebeu:', JSON.stringify(req2))
    check(req2?.mode === 'permanent' && req2.paths.length === 1 && req2.paths[0] === D('Gravacoes NVIDIA'), 'segundo pedido: só a pasta grande, mode "permanent"')

    // O mapa esquece o que saiu (forgetFiles real, no userData de teste); o que ficou em uso continua marcado
    await page.locator('button', { hasText: 'Mapa de pastas' }).first().click()
    await waitFolderGuard(h)
    rows = await folderRows(h)
    check(!rows.some((r) => r.path === D('Gravacoes NVIDIA') || r.path === D('Downloads antigos')), 'pastas apagadas saíram do mapa')
    check(rows.find((r) => r.path === D('.DICloakCache'))?.checked, 'pasta que estava em uso continua marcada (para tentar de novo)')
    bar = await barText(h)
    check(/Para apagar: 1 pasta ·/.test(bar) && /23,0 GB/.test(bar), `barra depois: "${bar}"`)
    const saved = (await page.evaluate(() => (globalThis as unknown as { api: { disk: { getLastScan(): Promise<ScanResult> } } }).api.disk.getLastScan())) as ScanResult
    const dSaved = saved.drives.find((d) => d.root === 'D:\\')!
    console.log(`   D:\\ salvo: ${(dSaved.totalBytes / GB).toFixed(1)} GB`)
    check(Math.abs(dSaved.totalBytes - (300 - 120 - 8 - 1.5) * GB) < GB / 100, 'total do D: descontou as 2 pastas e o ISO')
    log('screenshot: ' + (await h.shot('r3-9-mapa-depois')))

    // Lixeira: aviso na página + esvaziar com confirmação (interceptado)
    await page.waitForSelector('[data-testid=recycle-bin-notice]', { timeout: 10_000 })
    await page.getByTestId('empty-bin-open').click()
    await page.waitForSelector('[data-testid=empty-bin-dialog]', { timeout: 10_000 })
    await page.waitForSelector('text=Entendi: tudo o que está na Lixeira', { timeout: 10_000 })
    check(await page.getByTestId('empty-bin-confirm').isDisabled(), 'esvaziar: confirmar desativado até marcar a ciência')
    await page.getByTestId('empty-bin-dialog').locator('input[type=checkbox]').click()
    log('screenshot: ' + (await h.shot('r3-10-esvaziar')))
    await page.getByTestId('empty-bin-confirm').click()
    await page.waitForSelector('[data-testid=empty-bin-dialog]', { state: 'detached', timeout: 10_000 })
    check((await r3Calls(h)).filter((x) => x.ch === 'cleanup:emptyRecycleBin').length === 1, 'emptyRecycleBin chamado uma vez (interceptado: nada foi apagado)')

    // Análise desatualizada: "Tirar do mapa" (forgetFiles real no userData de teste)
    await scrollMainTop(page)
    await page.getByTestId('stale-scan').locator('button', { hasText: 'Tirar do mapa' }).click()
    await page.waitForSelector('[data-testid=stale-scan]', { state: 'detached', timeout: 10_000 })
    await waitFolderGuard(h)
    check(!(await folderRows(h)).some((r) => r.path === D('Antigo Projeto')), '"Tirar do mapa": a pasta que não existe mais saiu do mapa')
    check(!(await r3Calls(h)).some((x) => x.ch === 'disk:startScan'), 'nenhuma análise real foi iniciada')

    // Pasta liberada com jogo dentro: banner da pasta atual + alternativa que navega
    await enter(h, D('Jogos'))
    check((await page.getByTestId('current-folder-blocked').count()) === 1 && (await page.getByTestId('delete-current-folder').isDisabled()), 'D:\\Jogos: aviso de pasta protegida e "Apagar esta pasta" desativado')
    rows = await folderRows(h)
    check(rows[0]?.locked && /Jogos & Programas/.test(rows[0].alt), 'Cyberpunk 2077: cadeado + "Jogos & Programas"')
    log('screenshot: ' + (await h.shot('r3-11-jogos-protegida')))
    await (await rowOf(h, D('Jogos/Cyberpunk 2077'))).getByTestId('alt-action').click()
    await page.waitForSelector('h1:has-text("Jogos & Programas"), h2:has-text("Jogos & Programas")', { timeout: 10_000 }).catch(() => undefined)
    const heading = await page.locator('main h1, main h2').first().innerText().catch(() => '')
    check(/Jogos & Programas/.test(heading), `alternativa leva à página Jogos & Programas ("${heading}")`)

    // C:\: Windows → Busca extrema; ProgramData → Busca Profunda; Users → entrar
    await h.goto('disk')
    await page.waitForSelector('text=Mapa de pastas', { timeout: 30_000 })
    await page.locator('button', { hasText: /^C:\\/ }).first().click()
    await waitFolderGuard(h)
    rows = await folderRows(h)
    for (const r of rows) console.log(`   ${r.locked ? 'CADEADO' : 'livre  '} ${r.path}  ${r.reason.slice(0, 60)}  [${r.alt}]`)
    check(rows.find((r) => r.path === 'C:\\Windows')?.alt.includes('Busca extrema'), 'C:\\Windows → "Limpeza → Busca extrema"')
    check(rows.find((r) => r.path === 'C:\\ProgramData')?.alt.includes('Busca Profunda'), 'C:\\ProgramData → "Abrir Busca Profunda"')
    check(rows.find((r) => r.path === 'C:\\Users')?.locked && /Entrar na pasta/.test(rows.find((r) => r.path === 'C:\\Users')!.alt), 'C:\\Users → "Entrar na pasta"')
    await page.getByTestId('folder-map').scrollIntoViewIfNeeded()
    log('screenshot: ' + (await h.shot('r3-12-c-protegidas')))
    await enter(h, 'C:\\ProgramData')
    rows = await folderRows(h)
    check(rows.find((r) => /BlueStacks_nxt$/.test(r.path))?.alt.includes('Busca Profunda'), 'BlueStacks_nxt (ProgramData) → Busca Profunda')
    errors.push(...h.consoleErrors)
  } finally {
    await h.close()
  }

  // ---------------- Fase B: backend REAL, "Apagar de vez", só pastas da sandbox ----------------
  h = await launchApp({ outDir, userDataDir: fx.userDataDir, screenshotsDir: arg('dir') })
  try {
    const { page } = h
    // Rede de segurança: a Lixeira real nunca é esvaziada neste teste; a análise real nunca é iniciada.
    await h.app.evaluate(({ ipcMain }) => {
      for (const ch of ['cleanup:emptyRecycleBin', 'disk:startScan', 'disk:findDuplicates']) {
        ipcMain.removeHandler(ch)
        ipcMain.handle(ch, async () => {
          throw new Error('bloqueado no teste')
        })
      }
    })
    await page.evaluate(() => (globalThis as unknown as PageGlobal).api.settings.update({ deleteMode: 'permanent' }))
    const fr = (await page.evaluate(() =>
      (globalThis as unknown as { api: { disk: { checkScanFreshness(): Promise<unknown> } } }).api.disk.checkScanFreshness()
    )) as { missing: { path: string }[]; missingCount: number }
    console.log(`   conferência real: ${fr.missingCount} item(ns) sumiram; inclui SumiuAntes: ${fr.missing.some((m) => m.path === fx.sumiuAntes)}`)
    check(!fr.missing.some((m) => m.path === fx.pastaVelha), 'conferência real: PastaVelha (existe) não é marcada como sumida')
    await h.goto('disk')
    await page.waitForSelector('text=Mapa de pastas', { timeout: 30_000 })
    await page.locator('button', { hasText: /^C:\\/ }).first().click()
    await waitFolderGuard(h)
    // Desce até a sandbox clicando nas pastas
    const parts = fx.sb.split('\\')
    for (let i = 2; i <= parts.length; i++) await enter(h, parts.slice(0, i).join('\\'))
    let rows = await folderRows(h)
    for (const r of rows) console.log(`   ${r.locked ? 'CADEADO' : r.warned ? 'AVISO  ' : 'livre  '} ${r.path}  ${r.reason}`)
    check(rows.length === 2 && rows.every((r) => !r.locked), 'pastas da sandbox (em Temp) estão liberadas')
    for (const p of [fx.pastaVelha, fx.sumiuAntes]) await (await rowOf(h, p)).locator('input[type=checkbox]').click()
    check(/Apagar de vez/.test(await barText(h)), 'modo "Apagar de vez": a barra muda o rótulo')
    await page.getByTestId('selection-delete').click()
    await page.waitForSelector('[data-testid=delete-dialog]', { timeout: 15_000 })
    await waitTextGone(page, 'Conferindo a proteção')
    await ackIfNeeded(h)
    check(await page.getByTestId('delete-confirm').isDisabled(), 'apagar de vez: precisa digitar APAGAR')
    await page.getByTestId('delete-dialog').locator('input.input').fill('APAGAR')
    log('screenshot: ' + (await h.shot('r3-13-real-confirmacao')))
    await page.getByTestId('delete-confirm').click()
    // O corpo da confirmação (delete-dialog) some tanto quando o diálogo fecha quanto quando vira o resultado.
    const outcome = await page
      .waitForSelector('[data-testid=delete-dialog]', { state: 'detached', timeout: 30_000 })
      .then(async () => {
        await page.waitForTimeout(400)
        return (await page.getByTestId('delete-files-result').count()) ? 'result' : 'closed'
      })
      .catch(() => 'timeout')
    await page.waitForTimeout(400)
    log('screenshot: ' + (await h.shot('r3-14-real-resultado')))
    const resText = outcome === 'result' ? (await page.getByTestId('delete-files-result').innerText()).replace(/\s+/g, ' ') : '(diálogo fechou: tudo apagado)'
    console.log(`   backend real: ${outcome} — ${resText}`)
    const goneNow = !existsSync(fx.pastaVelha)
    console.log(`   PastaVelha no disco depois: ${goneNow ? 'apagada' : 'continua'}`)
    check(outcome !== 'timeout', 'o backend respondeu')
    if (goneNow) check(outcome === 'closed' || /apagado\(s\) de vez/.test(resText), 'PastaVelha sumiu do disco e o resultado diz que foi apagada')
    else check(outcome === 'result' && /(Só pela Lixeira|Protegidos|Não foram apagados)/.test(resText), 'PastaVelha continua no disco e o resultado mostra o motivo (ex.: "Só pela Lixeira" — o backend ainda não aceita apagar de vez pastas do mapa)')
    check(existsSync(fx.sb), 'a pasta da sandbox em si continua (só o que foi escolhido é apagado)')
    if (!goneNow) {
      // O que não pode ser apagado de vez pode ir para a Lixeira: só o diálogo é conferido (Cancelar — a Lixeira real não é usada)
      check((await page.getByTestId('delete-result-recycle').count()) === 1, 'resultado oferece "Mover para a Lixeira" para o que não pôde ser apagado de vez')
      await page.getByTestId('delete-result-recycle').click()
      await page.waitForSelector('[data-testid=delete-forced-recycle]', { timeout: 15_000 })
      await waitTextGone(page, 'Conferindo a proteção')
      const t3 = await page.locator('h2').last().innerText()
      check(/Mover 2 pastas para a Lixeira\?/.test(t3) && (await page.getByTestId('delete-confirm').isEnabled()), `diálogo de Lixeira (sem digitar APAGAR): "${t3}"`)
      log('screenshot: ' + (await h.shot('r3-15-real-para-lixeira')))
      await page.locator('footer button', { hasText: 'Cancelar' }).click()
      await page.waitForSelector('[data-testid=delete-dialog]', { state: 'detached', timeout: 10_000 })
      check(existsSync(fx.pastaVelha), 'cancelado: PastaVelha continua no disco (nada foi para a Lixeira real)')
    }
    errors.push(...h.consoleErrors)
  } finally {
    await h.close()
  }
  if (errors.length) console.log('ERROS NO CONSOLE:\n' + errors.join('\n'))
  else console.log('Sem erros no console.')
  console.log('FOLDERS OK')
}

async function main(): Promise<void> {
  if (process.argv.includes('--folders')) return foldersMain()
  if (process.argv.includes('--fixture')) return fixtureMain()
  const outDir = arg('out', 'out-disk')!
  const userDataDir = arg('userdata') ?? path.join(os.tmpdir(), 'iacleaner-ui-disk')
  if (process.argv.includes('--fresh')) rmSync(userDataDir, { recursive: true, force: true })
  const roots = (arg('roots', 'C,D,E') ?? 'C,D,E').split(',').map((r) => `${r.trim().toUpperCase()}:`)
  const h = await launchApp({ outDir, userDataDir, screenshotsDir: arg('dir') })
  const { page } = h
  const t0 = Date.now()
  const log = (m: string): void => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)
  try {
    await h.goto('disk')
    await page.waitForSelector('text=Unidades', { timeout: 30_000 })
    // espera os cards das unidades
    await page.waitForSelector('button[aria-pressed]', { timeout: 60_000 })
    await page.waitForTimeout(800)
    log('screenshot: ' + (await h.shot('disk-1-inicial')))

    // Ajusta a seleção para as raízes pedidas
    const cards = page.locator('button[aria-pressed]')
    const n = await cards.count()
    for (let i = 0; i < n; i++) {
      const c = cards.nth(i)
      const text = (await c.innerText()).trim()
      const letter = text.slice(0, 2).toUpperCase()
      const pressed = (await c.getAttribute('aria-pressed')) === 'true'
      if (roots.includes(letter) !== pressed) await c.click()
    }

    const analyze = page.locator('button', { hasText: /^Analisar \d/ }).first()
    await analyze.click()
    log('cliquei em Analisar')
    await page.waitForSelector('text=Analisando...', { timeout: 20_000 })
    await page.waitForTimeout(2500)
    log('screenshot: ' + (await h.shot('disk-2-progresso')))

    await page.waitForSelector('text=Analisando...', { state: 'detached', timeout: 10 * 60_000 })
    await page.waitForSelector('text=Mapa de pastas', { timeout: 30_000 })
    await page.waitForTimeout(1500)
    log('análise concluída')
    if (process.argv.includes('--fresh')) {
      // userData novo: sem inventário de Jogos & Programas → a página sugere abrir essa página (jogos em pastas próprias)
      await page.locator('button', { hasText: 'Maiores arquivos' }).first().click()
      await page.waitForTimeout(500)
      console.log('dica de inventário visível (userData novo):', (await page.getByTestId('inventory-hint').count()) === 1)
      await page.locator('button', { hasText: 'Mapa de pastas' }).first().click()
      await page.waitForTimeout(500)
    }
    log('screenshot: ' + (await h.shot('disk-3-resultado')))

    // Rola até o mapa e tira screenshot dele
    await page.getByTestId('folder-map').scrollIntoViewIfNeeded()
    await page.waitForTimeout(500)
    log('screenshot: ' + (await h.shot('disk-4-mapa')))

    // Drill-down: entra na maior pasta (primeira linha da tabela)
    const firstRow = page.locator('table.tbl tbody tr td button').first()
    if (await firstRow.isEnabled()) {
      await firstRow.click()
      await page.waitForTimeout(800)
      await page.getByTestId('folder-map').scrollIntoViewIfNeeded()
      log('screenshot: ' + (await h.shot('disk-5-drill')))
    }

    const tab = async (label: string, file: string): Promise<void> => {
      await page.locator('button', { hasText: label }).first().click()
      await page.waitForTimeout(900)
      await page.locator('button', { hasText: label }).first().scrollIntoViewIfNeeded()
      log('screenshot: ' + (await h.shot(file)))
    }
    await tab('Maiores arquivos', 'disk-6-maiores')
    await tab('Antigos e grandes', 'disk-7-antigos')
    await tab('Por tipo', 'disk-8-tipos')
    await tab('Duplicados', 'disk-9-duplicados')

    // Procura duplicados só no D: (somente leitura)
    if (await page.locator('button', { hasText: /Procurar (duplicados|de novo)/ }).count()) {
      const boxes = page.locator('label:has(input[type=checkbox])', { hasText: /^[A-Z]:\\$/ })
      const nb = await boxes.count()
      for (let i = 0; i < nb; i++) {
        const b = boxes.nth(i)
        const txt = (await b.innerText()).trim()
        const input = b.locator('input')
        const want = txt === 'D:\\'
        if ((await input.isChecked()) !== want) await input.click()
      }
      await page.locator('button', { hasText: /Procurar (duplicados|de novo)/ }).first().click()
      log('procurando duplicados no D:')
      await page.waitForTimeout(1500)
      log('screenshot: ' + (await h.shot('disk-10-dupes-progresso')))
      await page.waitForSelector('text=ocupados por cópias extras', { timeout: 5 * 60_000 })
      await page.waitForSelector('button:has-text("Cancelar")', { state: 'detached', timeout: 5 * 60_000 }).catch(() => undefined)
      await page.waitForTimeout(1000)
      log('screenshot: ' + (await h.shot('disk-11-dupes')))
      await page.locator('button', { hasText: 'Marcar cópias extras' }).first().click()
      await page.waitForTimeout(600)
      log('screenshot: ' + (await h.shot('disk-12-dupes-marcados')))
    }

    // Outra unidade
    const eTab = page.locator('button', { hasText: /^E:\\/ }).first()
    if (await eTab.count()) {
      await scrollMainTop(page)
      await eTab.click()
      await page.locator('button', { hasText: 'Mapa de pastas' }).first().click()
      await page.waitForTimeout(900)
      await page.getByTestId('folder-map').scrollIntoViewIfNeeded()
      log('screenshot: ' + (await h.shot('disk-13-e-mapa')))
      // Pasta sem subpastas (ex.: gravações do jogo): botão "ver arquivos" leva à lista filtrada
      const showFiles = page.locator('button[title="Ver os maiores arquivos desta pasta"]').first()
      if (await showFiles.count()) {
        await showFiles.click()
        await page.waitForTimeout(800)
        await page.locator('button', { hasText: 'Maiores arquivos' }).first().scrollIntoViewIfNeeded()
        log('screenshot: ' + (await h.shot('disk-14-e-arquivos-da-pasta')))
      }
    }

    // Sai e volta para a página: o resultado deve continuar lá
    await h.goto('dashboard')
    await h.goto('disk')
    await page.waitForSelector('text=Mapa de pastas', { timeout: 30_000 })
    log('resultado mantido ao voltar para a página: ok')

    if (h.consoleErrors.length) console.log('ERROS NO CONSOLE:\n' + h.consoleErrors.join('\n'))
    else console.log('Sem erros no console.')
  } finally {
    await h.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
