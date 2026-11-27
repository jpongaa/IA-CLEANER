# Contributing to IA Cleaner

IA Cleaner is a Windows desktop app (Electron 44 + React 19 + TypeScript + Tailwind 4) that analyzes drives, safely
cleans junk, diagnoses slowness, shows hardware (CPU-Z style) and drivers, and uses AI (Claude, or any OpenAI-compatible provider: ChatGPT, Gemini, Grok, local models...) to recommend.
The **user interface is 100% Brazilian Portuguese**; the target user is a non-expert or intermediate user, often a gamer.

## Environment
- Windows 10/11 64-bit. The app must work on Windows in **any display language** — performance counter names and
  command output are LOCALIZED (on a pt-BR Windows, for example, everything comes back translated).
- **Node 22+** and the **.NET 8 SDK** (only to build the `native/scanner` disk-scanning helper).
- The app runs as a regular user; anything that needs admin rights asks for UAC at that moment.

## SAFETY — non-negotiable rules
1. **Never change the PC while developing/testing**: don't delete files (except your own under
   `%TEMP%\iacleaner-test-<domain>\`), don't write to the registry (only under `HKCU\Software\IACleanerTest`), don't
   change services/power plan/hibernation, don't uninstall anything, don't create restore points, **don't trigger UAC**
   (never call `runPowerShellElevated` in tests), don't empty the Recycle Bin. Read-only collection (WMI/CIM, registry
   reads, folder listings) is fine.
2. Executors (cleanup, optimizations) are tested only against a sandbox folder under `%TEMP%\iacleaner-test-<domain>\`,
   or with a dry run.
3. In the app, every action that changes the PC: (a) only happens after explicit user confirmation in the UI
   (`ConfirmDialog`), (b) is logged to History (`core/actionLog.logAction`, with `undo` when reversible),
   (c) deletions ALWAYS go through `src/main/safety/guard.ts` (`checkPath`) and never follow junctions/symlinks.
4. The AI never executes anything: it only recommends items that already exist in the collected data (refs). The user
   executes. The AI can never be less cautious than the app's own rules (a "keep" item stays "keep").
5. Uninstalling games/programs: only through the official uninstaller / launcher / Windows Settings. Never delete a
   program/game folder directly. Drivers: only open official vendor sites / Windows Update. Never download or install
   executables.
6. Privacy: only names, sizes and specs go to the AI (never file contents). With "Anonymize paths", the user folder is
   replaced by `%USERPROFILE%` (`src/main/ai/refs.ts`). The API key is stored encrypted (DPAPI via `safeStorage`) and
   never sent back to the UI.

## Architecture
- `src/shared/types/*.ts`: contracts (types + the method list for each namespace). `window.api.<ns>.<method>()` in the
  renderer becomes the IPC call `'<ns>:<method>'`, handled by `createXxxApi()` in `src/main/<domain>/index.ts`.
  When you add a method to an `XxxApi`, also add its name to `XXX_METHODS`.
- Main → renderer events: `src/shared/events.ts` (`emit()` / `throttledEmitter()` from `core/events`). In the renderer: `useEvent()`.
- `src/main/core/`: `powershell.ts` (runPowerShell / runPowerShellJson / runPowerShellElevated / psQuote / isAdmin),
  `drives.ts` (getDrives), `state.ts` (getLatest/setLatest: latest results of each domain, read by the AI and the Dashboard),
  `actionLog.ts` (logAction/listActions/getAction/markUndone), `settings.ts` (getSettings, getApiKey),
  `platform.ts` (openExternal, showInExplorer, openPath, trashItem), `paths.ts` (dataDir, binPath, known.*), `store.ts`.
- `src/main/ai/`: Claude client (`client.ts`), OpenAI-compatible providers (`compat.ts`), prompts, zod schemas for structured output (`schemas.ts`), validation
  (`validate.ts`) and anonymization (`refs.ts`).
- **Domain modules do NOT import 'electron'** (use core/platform etc.), so they can run in tests with tsx.
- Imports: in main, use relative paths for `core` and the `@shared/...` alias for types. In the renderer: `@shared/...`,
  and relative paths for `../components/ui`, `../lib/api`, `../lib/nav`.

## PowerShell 5.1 — pitfalls
- Use `runPowerShellJson<T>(script)`; end the script with `ConvertTo-Json -InputObject $obj -Depth 8 -Compress`.
- Single-item arrays become objects: use `@(...)` and normalize in TS (`Array.isArray(x) ? x : x ? [x] : []`).
- `DateTime` becomes `"\/Date(…)\/"`: convert it in the script: `([DateTimeOffset]$d).ToUnixTimeMilliseconds()` or `$d.ToString('o')`.
- Enums come out as numbers: cast to `[string]` if you want the name.
- The preamble uses `$ErrorActionPreference='Stop'`: wrap each optional sub-query in `try { } catch { $warnings += '...' }`
  so one failure doesn't break the whole collection.
- **Localized Windows**: do NOT use `Get-Counter`/`typeperf` with counter names (they are translated). Output from
  `powercfg`, `fsutil` etc. is translated too: extract GUIDs/numbers with regex.
- On some machines the `Win32_PerfFormattedData_*` classes do NOT exist ("Invalid class") and PDH lacks
  PhysicalDisk/Network Interface: always have a plan B (sample `Win32_Process`, `IOCTL_DISK_PERFORMANCE`,
  `PdhAddEnglishCounter`, .NET statistics).
- `Add-Type` (compiling C#) fails if the `LIB` variable points to a missing folder: `core/powershell` already removes `LIB` from the child process.
- In PowerShell, `npm run x -- --flag` loses the `--`: pass smoke arguments without dashes, or call `npx tsx ... run.ts <domain> --flag`.
- Prefer `Get-CimInstance` over `Get-WmiObject`. Batch many queries into ONE script (each spawn costs ~0.5 s).
- Inside TS template strings: watch out for backticks (PowerShell's escape character) and `${` (JS interpolation). Use `psQuote()` for values.

## User interface (renderer)
- Everything in Brazilian Portuguese, in simple, direct language; explain the *why* (users want to understand).
- Use the `components/ui` kit (Button, Card, Badge, ProgressBar, StatCard, PageHeader, Tabs, Toggle, Checkbox, KeyValue,
  EmptyState, ErrorBox, Spinner, Skeleton, Modal, ConfirmDialog, useToast, VerdictBadge, SeverityBadge, RiskBadge, ImpactBadge)
  and `components/ai` (AiAnalyzeCard, AiRecommendationList). Icons: lucide-react. Charts: recharts.
- Colors via theme tokens: `bg-bg bg-surface bg-surface-2 bg-surface-3 border-border text-text text-muted text-faint
  text-accent text-ai text-ok text-warn text-danger text-info` (and `/10`, `/30` variants). Tables: `<table className="tbl">`.
  Inputs: `className="input"`. Dark theme.
- Pages render inside a `max-w-[1400px] px-8 py-7` container, in a 1360×860 window. Dense but breathable layouts.
- Every page has loading, error (`ErrorBox` with retry) and empty states; on open, load the last saved result
  (`getLastXxx`) so data isn't lost when switching pages. Long tasks: progress bar via events.
- Navigating between pages: `useNav().go('cleanup')`.
- Backend errors: `errMsg(e)` from `lib/api`.

## Tests
1. Types: `npm run typecheck`.
2. Backend: `scripts/smoke/<domain>.ts` exports `run()` and exercises the backend (read-only, or against the `%TEMP%`
   sandbox); run `npx tsx --tsconfig tsconfig.node.json scripts/smoke/run.ts <domain>`. The AI tests use a FAKE server on
   127.0.0.1 and cost no credits.
3. UI: `scripts/ui/*.ts` open the app with Playwright (`launchApp()` from `scripts/ui/harness.ts`) using sample data.
   **Never click buttons that change the PC** (Clean, Delete, Uninstall, Apply, Disable...).
