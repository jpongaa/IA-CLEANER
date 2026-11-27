# IA Cleaner — Guia de desenvolvimento

App desktop Windows (Electron 44 + React 19 + TypeScript + Tailwind 4) que analisa discos, limpa lixo com segurança,
diagnostica lentidão, mostra hardware (estilo CPU-Z), drivers, e usa a IA Claude (Anthropic) para recomendar.
Interface 100% em **português do Brasil**. O usuário final é leigo/intermediário e muitas vezes gamer.

## Ambiente
- Windows 10/11 64-bit. O app precisa funcionar em Windows em **qualquer idioma** (nomes de contadores de desempenho e
  saídas de comandos são LOCALIZADOS: em pt-BR, por exemplo, tudo vem traduzido).
- **Node 22+** e **.NET SDK 8** (só para compilar o helper de varredura `native/scanner`).
- O app roda como usuário comum; o que precisa de administrador pede o UAC na hora.

## SEGURANÇA — regras invioláveis
1. **Nunca altere o PC durante o desenvolvimento/testes**: não apague arquivos (exceto os seus próprios em
   `%TEMP%\iacleaner-test-<dominio>\`), não grave no registro (só sob `HKCU\Software\IACleanerTest`), não mude
   serviços/plano de energia/hibernação, não desinstale nada, não crie ponto de restauração, **não dispare UAC**
   (nunca chame `runPowerShellElevated` em testes), não esvazie a Lixeira. Coletas somente-leitura (WMI/CIM, leitura de
   registro, listar pastas) são permitidas.
2. Executores (limpeza, otimizações) são testados apenas contra uma pasta sandbox em `%TEMP%\iacleaner-test-<dominio>\`,
   ou por "dry-run".
3. No app, toda ação que altera o PC: (a) só acontece após confirmação explícita do usuário na interface
   (`ConfirmDialog`), (b) registra no histórico (`core/actionLog.logAction`, com `undo` quando reversível),
   (c) exclusões passam SEMPRE por `src/main/safety/guard.ts` (`checkPath`), nunca seguem junctions/symlinks.
4. A IA nunca executa nada: só recomenda itens que já existem nos dados coletados (refs). Quem executa é o usuário.
   A IA nunca pode ser menos cautelosa que as regras do app (um item "manter" continua "manter").
5. Desinstalação de jogos/programas: só pelo desinstalador oficial / launcher / Configurações do Windows.
   Nunca apagar pasta de programa/jogo diretamente. Drivers: só abrir sites oficiais / Windows Update. Nunca baixar/instalar
   executáveis.
6. Privacidade: para a IA vão só nomes, tamanhos e especificações (nunca o conteúdo de arquivos). Com "Anonimizar
   caminhos", a pasta do usuário é trocada por `%USERPROFILE%` (`src/main/ai/refs.ts`). A chave da API é guardada
   criptografada (DPAPI via `safeStorage`) e nunca volta para a interface.

## Arquitetura
- `src/shared/types/*.ts`: contratos (tipos + lista de métodos por namespace). `window.api.<ns>.<metodo>()` no renderer
  vira IPC `'<ns>:<metodo>'` tratado por `createXxxApi()` em `src/main/<dominio>/index.ts`.
  Ao adicionar um método a uma `XxxApi`, adicione o nome também em `XXX_METHODS`.
- Eventos main→renderer: `src/shared/events.ts` (`emit()` / `throttledEmitter()` de `core/events`). No renderer: `useEvent()`.
- `src/main/core/`: `powershell.ts` (runPowerShell / runPowerShellJson / runPowerShellElevated / psQuote / isAdmin),
  `drives.ts` (getDrives), `state.ts` (getLatest/setLatest: últimos resultados de cada domínio, lidos pela IA e Painel),
  `actionLog.ts` (logAction/listActions/getAction/markUndone), `settings.ts` (getSettings, getApiKey),
  `platform.ts` (openExternal, showInExplorer, openPath, trashItem), `paths.ts` (dataDir, binPath, known.*), `store.ts`.
- `src/main/ai/`: cliente da API (`client.ts`), prompts, esquemas zod da saída estruturada (`schemas.ts`), validação
  (`validate.ts`) e anonimização (`refs.ts`).
- **Módulos de domínio NÃO importam 'electron'** (use core/platform etc.), para rodarem nos testes com tsx.
- Imports: no main use caminhos relativos para `core` e alias `@shared/...` para tipos. No renderer: `@shared/...`,
  relativos para `../components/ui`, `../lib/api`, `../lib/nav`.

## PowerShell 5.1 — armadilhas
- Use `runPowerShellJson<T>(script)`; termine o script com `ConvertTo-Json -InputObject $obj -Depth 8 -Compress`.
- Arrays de 1 item viram objeto: use `@(...)` e, no TS, normalize (`Array.isArray(x) ? x : x ? [x] : []`).
- `DateTime` vira `"\/Date(…)\/"`: converta no script: `([DateTimeOffset]$d).ToUnixTimeMilliseconds()` ou `$d.ToString('o')`.
- Enums saem como número: faça cast `[string]` se quiser o nome.
- O preâmbulo usa `$ErrorActionPreference='Stop'`: envolva cada sub-consulta opcional em `try { } catch { $warnings += '...' }`
  para uma falha não derrubar a coleta inteira.
- **Windows localizado**: NÃO use `Get-Counter`/`typeperf` com nomes de contadores (são traduzidos). Saídas de `powercfg`,
  `fsutil` etc. também: extraia GUIDs/números com regex.
- Em algumas máquinas as classes `Win32_PerfFormattedData_*` NÃO existem ("Classe inválida") e o PDH não tem
  PhysicalDisk/Network Interface: sempre tenha plano B (amostrar `Win32_Process`, `IOCTL_DISK_PERFORMANCE`,
  `PdhAddEnglishCounter`, estatísticas .NET).
- `Add-Type` (compilar C#) falha se a variável `LIB` aponta para pasta inexistente: `core/powershell` já remove `LIB` do processo filho.
- No PowerShell, `npm run x -- --flag` perde o `--`: passe argumentos de smoke sem traços ou chame `npx tsx ... run.ts <dominio> --flag`.
- Prefira `Get-CimInstance` a `Get-WmiObject`. Agrupe muitas consultas em UM script (cada spawn custa ~0,5 s).
- Dentro de template strings do TS: cuidado com crase (escape do PS) e `${` (interpolação do JS). Use `psQuote()` para valores.

## Interface (renderer)
- Tudo em PT-BR, linguagem simples e direta; explique o porquê das coisas (o usuário quer entender).
- Use o kit `components/ui` (Button, Card, Badge, ProgressBar, StatCard, PageHeader, Tabs, Toggle, Checkbox, KeyValue,
  EmptyState, ErrorBox, Spinner, Skeleton, Modal, ConfirmDialog, useToast, VerdictBadge, SeverityBadge, RiskBadge, ImpactBadge)
  e `components/ai` (AiAnalyzeCard, AiRecommendationList). Ícones: lucide-react. Gráficos: recharts.
- Cores via tokens do tema: `bg-bg bg-surface bg-surface-2 bg-surface-3 border-border text-text text-muted text-faint
  text-accent text-ai text-ok text-warn text-danger text-info` (e variações `/10`, `/30`). Tabelas: `<table className="tbl">`.
  Inputs: `className="input"`. Tema escuro.
- A página é renderizada num container `max-w-[1400px] px-8 py-7`, janela 1360×860. Layouts densos mas respiráveis.
- Toda página: estado de carregamento, erro (`ErrorBox` com tentar de novo), vazio; ao abrir, carregue o último resultado
  salvo (`getLastXxx`) para não perder dados ao trocar de página. Tarefas longas: barra de progresso via eventos.
- Navegação entre páginas: `useNav().go('cleanup')`.
- Erros vindos do backend: `errMsg(e)` de `lib/api`.

## Testes
1. Tipos: `npm run typecheck`.
2. Backend: `scripts/smoke/<dominio>.ts` exporta `run()` e exercita o backend (somente leitura, ou contra a sandbox em
   `%TEMP%`); rode `npx tsx --tsconfig tsconfig.node.json scripts/smoke/run.ts <dominio>`. Os testes da IA usam um
   servidor FALSO em 127.0.0.1 e não gastam créditos.
3. Interface: `scripts/ui/*.ts` abrem o app com Playwright (`launchApp()` de `scripts/ui/harness.ts`) usando dados de
   exemplo. **Nunca clique em botões que alteram o PC** (Limpar, Apagar, Desinstalar, Aplicar, Desativar...).
