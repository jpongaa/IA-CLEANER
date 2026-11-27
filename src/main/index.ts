import { app, BrowserWindow, dialog, net, safeStorage, session, shell } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerIpc } from './ipc'
import { setAppPaths } from './core/paths'
import { setEventSink } from './core/events'
import { setSecretCipher } from './core/settings'
import { normalizeUiExternalUrl, setPlatform } from './core/platform'
import { viaNetFetch } from './core/netFetch'
import { setAiTransport } from './ai/client'
import { acquireInstanceLock, isRelaunchedAdmin, relaunchOriginalUser } from './core/instanceLock'
import { makeAppUrlMatcher } from './core/ipcGuard'
import { cleanupTempFilesSync, sweepStaleTempFiles } from './core/tempFiles'

const isDev = !app.isPackaged
// Testes automatizados de interface (scripts/ui): várias instâncias e dados isolados.
const isUiTest = process.env.IACLEANER_TEST === '1'
if (isUiTest && process.env.IACLEANER_USERDATA) app.setPath('userData', process.env.IACLEANER_USERDATA)

// Na instância aberta por "Reabrir como Administrador", a antiga pode ainda estar saindo: tenta o lock por alguns segundos.
const gotLock = isUiTest || acquireInstanceLock(app, process.argv)
if (!gotLock) {
  app.quit()
}

const devUrl = isDev ? process.env.ELECTRON_RENDERER_URL : undefined
const rendererFile = path.join(__dirname, '../renderer/index.html')
/** Única página que a janela pode exibir e que pode chamar o IPC. */
const isAppUrl = makeAppUrlMatcher(pathToFileURL(rendererFile).href, devUrl)

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0b0f17',
    title: 'IA Cleaner',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0f17', symbolColor: '#cbd5e1', height: 40 },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // Testes automáticos podem rodar com a janela escondida (IACLEANER_HIDDEN=1): nada aparece na tela.
  mainWindow.on('ready-to-show', () => {
    if (!(isUiTest && process.env.IACLEANER_HIDDEN === '1')) mainWindow?.show()
  })

  // Links externos abrem no navegador padrão (só https: / ms-settings:, mesma regra do system.openExternal);
  // nada de janelas novas dentro do app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(normalizeUiExternalUrl(url)).catch(() => undefined)
    } catch {
      // endereço recusado (http:, file:, javascript:...): não abre nada
    }
    return { action: 'deny' }
  })
  // A janela só exibe a página do app: qualquer outra navegação (inclusive outro .html local, que receberia o
  // preload com window.api) é bloqueada.
  const blockForeign = (e: { preventDefault(): void }, url: string): void => {
    if (!isAppUrl(url)) e.preventDefault()
  }
  mainWindow.webContents.on('will-navigate', blockForeign)
  mainWindow.webContents.on('will-redirect', blockForeign)

  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(rendererFile)
  }
}

/** Conta diferente (UAC com a senha de outro administrador): avisa que as ações valem para a outra conta. */
function warnIfOtherAccount(): void {
  if (!isRelaunchedAdmin(process.argv)) return
  const original = relaunchOriginalUser(process.argv)
  const current = os.userInfo().username
  if (!original || original.toLowerCase() === current.toLowerCase() || !mainWindow) return
  void dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: 'IA Cleaner',
    message: `O app foi reaberto com a conta "${current}", não com "${original}".`,
    detail:
      'Configurações do app, chave da IA, itens de inicialização do usuário e ajustes visuais/jogos agora valem para a conta ' +
      `"${current}". Para otimizar a conta "${original}", feche o app e abra-o normalmente nela.`
  })
}

if (gotLock) {
  app.whenReady().then(() => {
    setAppPaths({
      userData: app.getPath('userData'),
      bin: app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(app.getAppPath(), 'resources', 'bin')
    })
    setEventSink((event, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(event, payload)
    })
    if (safeStorage.isEncryptionAvailable()) {
      setSecretCipher({
        encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
        decrypt: (enc) => safeStorage.decryptString(Buffer.from(enc, 'base64'))
      })
    }
    // IA pela pilha de rede do Chromium: proxy e certificados do Windows (ver core/netFetch).
    setAiTransport({ fetch: viaNetFetch((input, init) => net.fetch(input as never, init as never) as unknown as Promise<Response>) })
    setPlatform({
      openExternal: (url) => shell.openExternal(url),
      showInExplorer: async (p) => shell.showItemInFolder(p),
      openPath: async (p) => {
        const err = await shell.openPath(p)
        if (err) throw new Error(err)
      },
      trashItem: (p) => shell.trashItem(p)
    })

    // O app não usa câmera, microfone, notificações, geolocalização...: tudo negado. Só a escrita na área de
    // transferência (botões "Copiar") é permitida.
    const allowed = new Set(['clipboard-sanitized-write'])
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)))
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))

    registerIpc(isAppUrl)
    createWindow()
    mainWindow?.once('ready-to-show', warnIfOtherAccount)

    // Sobras de sessões que fecharam no meio de uma tarefa (não nos testes de interface, que rodam em paralelo).
    if (!isUiTest) void sweepStaleTempFiles().catch(() => undefined)

    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      }
    })
  })
}

app.on('will-quit', () => cleanupTempFilesSync())

app.on('window-all-closed', () => {
  app.quit()
})
