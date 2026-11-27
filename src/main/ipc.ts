// Registro de todos os handlers IPC: canal '<namespace>:<método>' -> implementação do domínio.
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { API_METHODS, type IaCleanerApi, type Namespace } from '@shared/api'
import type { SettingsApi, SpecialTarget, SystemApi } from '@shared/types/settings'
import { createDiskApi } from './disk'
import { nativeAvailable } from './disk/native'
import { createCleanupApi } from './cleanup'
import { createAppsApi } from './apps'
import { createPerformanceApi } from './performance'
import { createHardwareApi } from './hardware'
import { createDriversApi } from './drivers'
import { createAiApi } from './ai'
import { createDiscoverApi } from './discover'
import { createRepairApi } from './repair'
import { getSettings, setApiKey, updateSettings } from './core/settings'
import { isAdmin, runPowerShell, psQuote } from './core/powershell'
import { normalizeUiExternalUrl, platform } from './core/platform'
import { listActions } from './core/actionLog'
import { dataDir, known } from './core/paths'
import { relaunchArgs, relaunchWithLockHandoff } from './core/instanceLock'
import { isTrustedFrame } from './core/ipcGuard'
import { cleanupTempFilesSync } from './core/tempFiles'
import pkg from '../../package.json'

function createSettingsApi(): SettingsApi {
  return {
    get: getSettings,
    update: updateSettings,
    setApiKey
  }
}

function launch(file: string, args: string[] = []): void {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', () => undefined)
  child.unref()
}

const SPECIAL: Record<SpecialTarget, () => Promise<void> | void> = {
  recycleBin: () => launch(path.join(known.windir, 'explorer.exe'), ['shell:RecycleBinFolder']),
  systemProtection: () => launch(path.join(known.windir, 'System32', 'SystemPropertiesProtection.exe')),
  storageSettings: () => platform.openExternal('ms-settings:storagesense'),
  startupApps: () => platform.openExternal('ms-settings:startupapps'),
  appsSettings: () => platform.openExternal('ms-settings:appsfeatures'),
  taskManager: () => launch(path.join(known.windir, 'System32', 'Taskmgr.exe')),
  diskCleanup: () => launch(path.join(known.windir, 'System32', 'cleanmgr.exe'))
}

function createSystemApi(): SystemApi {
  return {
    async getAppInfo() {
      return {
        version: pkg.version,
        isAdmin: await isAdmin(),
        scannerAvailable: nativeAvailable(),
        userDataPath: dataDir(),
        osRelease: os.release()
      }
    },
    async relaunchAsAdmin() {
      if (await isAdmin()) return { ok: true, message: 'O app já está rodando como Administrador.' }
      if (!app.isPackaged) {
        return {
          ok: false,
          message: 'No modo desenvolvimento, abra o terminal como Administrador e rode "npm run dev".'
        }
      }
      const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
      const args = relaunchArgs(os.userInfo().username).map(psQuote).join(',')
      // Libera o lock de instância única ANTES de abrir a nova (senão ela fecha ao nascer) e o pega de volta se
      // o UAC for negado. A espera do UAC pode demorar: prazo longo.
      const started = await relaunchWithLockHandoff(app, async () => {
        const res = await runPowerShell(
          `try { Start-Process -FilePath ${psQuote(exe)} -ArgumentList ${args} -Verb RunAs; 'ok' } catch { 'cancelled' }`,
          { timeoutMs: 10 * 60_000 }
        )
        return res.stdout.trim().endsWith('ok')
      })
      if (started) {
        cleanupTempFilesSync() // app.exit não dispara will-quit
        setTimeout(() => app.exit(0), 150)
        return { ok: true, message: 'Reabrindo como Administrador...' }
      }
      return { ok: false, message: 'Permissão de administrador negada.' }
    },
    async openExternal(url) {
      // Só https: e ms-settings: (normalizado, sem espaços/aspas/controle); http: é recusado.
      await platform.openExternal(normalizeUiExternalUrl(url))
    },
    showInExplorer: (p) => platform.showInExplorer(p),
    getActionLog: (limit) => listActions(limit),
    async pickFolder(title) {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const opts = { title: title || 'Escolher pasta', properties: ['openDirectory' as const] }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
    },
    async openSpecial(target) {
      const fn = SPECIAL[target]
      if (!fn) throw new Error('Tela não suportada: ' + String(target))
      await fn()
    }
  }
}

/**
 * Registra os handlers. `isAppUrl` diz qual página é o app: só o frame principal com essa página pode chamar
 * o IPC (outra página local carregada na janela, ou um iframe, recebe "Remetente não autorizado").
 */
export function registerIpc(isAppUrl: (url: string) => boolean): void {
  const assertTrusted = (event: IpcMainInvokeEvent, channel: string): void => {
    if (!isTrustedFrame(event.senderFrame, isAppUrl)) {
      console.warn(`[ipc] chamada recusada em ${channel}: ${event.senderFrame?.url ?? '(frame destruído)'}`)
      throw new Error('Remetente não autorizado.')
    }
  }
  const impl: IaCleanerApi = {
    disk: createDiskApi(),
    cleanup: createCleanupApi(),
    apps: createAppsApi(),
    performance: createPerformanceApi(),
    hardware: createHardwareApi(),
    drivers: createDriversApi(),
    ai: createAiApi(),
    discover: createDiscoverApi(),
    repair: createRepairApi(),
    settings: createSettingsApi(),
    system: createSystemApi()
  }
  for (const ns of Object.keys(API_METHODS) as Namespace[]) {
    const target = impl[ns] as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const method of API_METHODS[ns] as readonly string[]) {
      const fn = target[method]
      if (typeof fn !== 'function') {
        // Um método faltando não pode impedir o app de abrir: responde com erro só nele.
        console.error(`[ipc] ${ns}:${method} não implementado`)
        ipcMain.handle(`${ns}:${method}`, async (event) => {
          assertTrusted(event, `${ns}:${method}`)
          throw new Error(`${ns}.${method}: ainda não implementado`)
        })
        continue
      }
      ipcMain.handle(`${ns}:${method}`, async (event, ...args: unknown[]) => {
        assertTrusted(event, `${ns}:${method}`)
        return fn.apply(target, args)
      })
    }
  }
}
