// Programas instalados: entradas de desinstalação (HKLM 64/32 + HKCU) e apps da Microsoft Store.
import path from 'node:path'
import type { ProgramInfo } from '@shared/types/apps'
import type { RegUninstallEntry, StorePackage } from './collect'
import { exeFromIcon, installDirOf } from './launchers'
import { programIdOf } from './model'
import { isInstallerExe } from './usage'
import { parseInstallDate } from './util'

const UPDATE_RELEASE = /update|hotfix|service pack|security/i
const KB_NAME = /\bKB\d{6,}\b/i

/** A entrada aparece em "Aplicativos instalados" do Windows? (mesmas regras básicas do Painel de Controle) */
export function isListedProgram(e: RegUninstallEntry): boolean {
  if (!e.name?.trim()) return false
  if (Number(e.system) === 1) return false
  if (e.parent?.trim()) return false
  if (e.release && UPDATE_RELEASE.test(e.release)) return false
  if (KB_NAME.test(e.name)) return false
  if (!e.uninstall?.trim() && Number(e.noRemove) !== 1) return false
  return true
}

/** .exe do ícone, quando é o programa em si (não um instalador/desinstalador em cache). */
function mainExeOf(icon: string | null | undefined): string | undefined {
  const exe = exeFromIcon(icon)
  return exe && !isInstallerExe(exe) ? exe : undefined
}

function cleanVersion(v: string | null | undefined): string | undefined {
  const s = (v ?? '').trim()
  return s || undefined
}

export function programsFromRegistry(entries: RegUninstallEntry[]): ProgramInfo[] {
  const out: ProgramInfo[] = []
  const seen = new Map<string, ProgramInfo>()
  for (const e of entries) {
    if (!isListedProgram(e)) continue
    const machine = e.hive.startsWith('HKLM')
    const sizeKb = e.size !== null && e.size !== undefined ? Number(e.size) >>> 0 : 0
    const p: ProgramInfo = {
      id: programIdOf(e.hive, e.key),
      name: e.name.trim(),
      publisher: e.publisher?.trim() || undefined,
      version: cleanVersion(e.version),
      installDate: parseInstallDate(e.date),
      installPath: installDirOf(e),
      source: 'registry',
      scope: machine ? 'machine' : 'user',
      mainExe: mainExeOf(e.icon)
    }
    if (sizeKb > 0) {
      p.bytes = sizeKb * 1024
      p.bytesSource = 'registry'
    }
    if (e.uninstall?.trim()) {
      p.uninstall = {
        kind: 'command',
        value: e.uninstall.trim(),
        label: 'Abrir desinstalador oficial',
        requiresAdmin: machine
      }
    }
    // Mesmo programa registrado duas vezes (64/32 bits ou máquina/usuário): fica a entrada mais completa.
    const dupKey = `${p.name.toLowerCase()}|${(p.version ?? '').toLowerCase()}|${(p.publisher ?? '').toLowerCase()}`
    const prev = seen.get(dupKey)
    if (prev) {
      if (!prev.bytes && p.bytes) {
        prev.bytes = p.bytes
        prev.bytesSource = p.bytesSource
      }
      prev.installPath ??= p.installPath
      prev.installDate ??= p.installDate
      prev.mainExe ??= p.mainExe
      continue
    }
    seen.set(dupKey, p)
    out.push(p)
  }
  return out
}

function publisherOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const o = /(?:^|,\s*)O=("?)([^",]+)\1/i.exec(raw)?.[2]
  const cn = /(?:^|,\s*)CN=("?)([^",]+)\1/i.exec(raw)?.[2]
  const v = (o ?? cn ?? '').trim()
  // CN=7430E2A4-EFE7-... (GUID) não ajuda o usuário
  if (!v || /^[0-9A-F-]{20,}$/i.test(v)) return undefined
  return v
}

function humanizePackage(name: string): string {
  const last = name.split('.').filter(Boolean).pop() ?? name
  return last.replace(/([a-z])([A-Z])/g, '$1 $2')
}

/** Pacotes de sistema/infraestrutura que não fazem sentido como "programa" para o usuário. */
const STORE_INFRA = /^(Microsoft\.(VCLibs|NET|UI\.Xaml|WindowsAppRuntime|Services\.Store|DesktopAppInstaller|StorePurchaseApp|Xbox\.TCUI|XboxIdentityProvider|Winget|LanguageExperiencePack|Ink\.|ApplicationCompatibilityEnhancements|WidgetsPlatformRuntime)|MicrosoftCorporationII\.WinAppRuntime|MicrosoftWindows\.|windows\.)/i

/**
 * Apps da Store que o usuário enxerga (têm atalho no Menu Iniciar) ou que são jogos.
 * Se o Windows não informou os atalhos (Get-StartApps indisponível), usa os pacotes da Store que não são infraestrutura.
 */
export function programsFromStore(packages: StorePackage[]): ProgramInfo[] {
  const out: ProgramInfo[] = []
  const haveStartInfo = packages.some((p) => p.display)
  for (const p of packages) {
    if (!p.pfn) continue
    const visible = haveStartInfo ? Boolean(p.display) || Boolean(p.isGame) : p.signature === 'Store' && !STORE_INFRA.test(p.name)
    if (!visible) continue
    const name = (p.display ?? '').trim() || humanizePackage(p.name)
    out.push({
      id: `store:${p.pfn}`,
      name,
      publisher: publisherOf(p.publisher),
      version: p.version || undefined,
      installDate: p.date ?? undefined,
      installPath: p.location || undefined,
      source: 'store',
      scope: 'user',
      uninstall: p.nonRemovable
        ? undefined
        : {
            kind: 'settings',
            value: 'ms-settings:appsfeatures',
            label: 'Desinstalar pelas Configurações do Windows',
            instructions: `Em Configurações → Aplicativos → Aplicativos instalados, procure "${name}", clique nos três pontinhos (…) → Desinstalar.`
          }
    })
  }
  return out
}

/** Nome do .exe (minúsculas) — usado para casar com o Prefetch. */
export function exeName(p: string | undefined): string | undefined {
  return p ? path.win32.basename(p).toLowerCase() : undefined
}
