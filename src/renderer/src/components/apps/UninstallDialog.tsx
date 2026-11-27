// Confirmação de desinstalação: explica que só abre o desinstalador OFICIAL e o que acontece com os saves.
import { useState, type ReactNode } from 'react'
import { Cloud, Eye, HardDrive, Info, ListChecks, RotateCcw, ShieldAlert } from 'lucide-react'
import type { DriveInfo } from '@shared/types/common'
import type { GameInfo, ProgramInfo } from '@shared/types/apps'
import { formatBytes } from '@shared/format'
import { ConfirmDialog } from '../ui'
import { driveKindLabel, LAUNCHERS, launcherLabel } from './meta'
import type { UninstallRequest } from './useUninstallTracks'

export type UninstallTarget = { kind: 'game'; item: GameInfo } | { kind: 'program'; item: ProgramInfo }

function Row({ icon: Icon, children, tone = 'text-muted' }: { icon: typeof Info; children: ReactNode; tone?: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} />
      <span className="text-[13px] leading-relaxed text-text">{children}</span>
    </li>
  )
}

/** Pedido de desinstalação a partir de um jogo/programa do inventário. */
export function requestFor(t: UninstallTarget): UninstallRequest {
  return {
    itemId: t.item.id,
    name: t.item.name,
    kind: t.kind,
    launcher: t.kind === 'game' ? t.item.launcher : undefined,
    methodKind: t.item.uninstall?.kind
  }
}

export function UninstallDialog({
  target,
  drives,
  onClose,
  onStart,
  tracking
}: {
  target: UninstallTarget | null
  drives: DriveInfo[]
  onClose: () => void
  /** Abre o desinstalador oficial e começa o acompanhamento (os avisos ficam por conta de quem chama). */
  onStart: (req: UninstallRequest) => Promise<boolean>
  /** O backend acompanha a desinstalação (o item some da lista sozinho). */
  tracking?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const item = target?.item
  const method = item?.uninstall
  const game = target?.kind === 'game' ? target.item : null
  const program = target?.kind === 'program' ? target.item : null
  const bytes = game ? (game.exists ? game.bytes : 0) : (program?.bytes ?? 0)
  const driveLetter = game?.drive ?? (program?.installPath ? program.installPath.slice(0, 2).toUpperCase() : '')
  const drive = drives.find((d) => d.letter.toUpperCase() === driveLetter)
  const kind = driveKindLabel(drive)
  // Aviso de UAC só quando o desinstalador exige administrador DE VERDADE: programa instalado para todos os usuários
  // (HKLM / Arquivos de Programas). Programa por usuário (HKCU, ex.: Hydra em AppData) abre sem UAC.
  const machineWide = program ? program.scope === 'machine' || /^reg:HKLM/i.test(program.id) : true
  const adminWarning = Boolean(method?.requiresAdmin) && machineWide

  const confirm = async (): Promise<void> => {
    if (!target) return
    setBusy(true)
    try {
      await onStart(requestFor(target))
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const name = item?.name ?? ''
  const via = !method
    ? ''
    : method.kind === 'settings'
      ? 'via Configurações do Windows'
      : game
        ? `via ${launcherLabel(game.launcher)}`
        : 'do próprio programa'
  return (
    <ConfirmDialog
      open={Boolean(target)}
      title={`Desinstalar "${name}"?`}
      tone="danger"
      confirmLabel={method ? 'Abrir desinstalador oficial' : 'Entendi'}
      loading={busy}
      onCancel={() => !busy && onClose()}
      onConfirm={() => (method ? void confirm() : onClose())}
      message={
        method ? (
          <p className="text-muted">
            Vamos abrir o <b className="text-text">desinstalador oficial</b> ({via}). O IA Cleaner{' '}
            <b className="text-text">não apaga nenhuma pasta sozinho</b>: você confirma (ou cancela) na janela que abrir.
          </p>
        ) : (
          <p className="text-muted">Este item não tem um desinstalador registrado. Tente em Configurações → Aplicativos → Aplicativos instalados.</p>
        )
      }
      details={
        item && method ? (
          <ul className="space-y-2.5">
            {bytes > 0 && (
              <Row icon={HardDrive} tone="text-accent">
                Libera cerca de <b>{formatBytes(bytes)}</b>
                {driveLetter && (
                  <>
                    {' '}
                    no <b>{driveLetter}</b>
                    {kind ? ` (${kind})` : ''}
                  </>
                )}
                {game?.workshopBytes ? `, incluindo ${formatBytes(game.workshopBytes)} de mods da Oficina Steam` : ''}.
              </Row>
            )}
            {game && !game.exists && (
              <Row icon={Info} tone="text-info">
                A pasta deste jogo não existe mais: o {launcherLabel(game.launcher)} só ficou com o registro. Desinstalar por ele limpa essa entrada (não libera
                espaço).
              </Row>
            )}
            {method.instructions && <Row icon={ListChecks}>{method.instructions}</Row>}
            {tracking && (
              <Row icon={Eye} tone="text-accent">
                Depois que você confirmar na janela do desinstalador, o IA Cleaner <b>confere sozinho</b> se {game ? 'o jogo' : 'o programa'} saiu de verdade: ele
                some desta lista e mostramos o espaço liberado (e se sobrou alguma pasta).
              </Row>
            )}
            {game && <Row icon={Cloud}>{LAUNCHERS[game.launcher]?.saves ?? LAUNCHERS.other.saves}</Row>}
            {program && (
              <Row icon={Cloud}>
                O desinstalador remove o programa e, às vezes, as configurações dele. Arquivos que você criou (documentos, projetos, fotos) não são apagados.
              </Row>
            )}
            {adminWarning && (
              <Row icon={ShieldAlert} tone="text-warn">
                {method.kind === 'command' && program
                  ? 'Programa instalado para todos os usuários: o Windows vai pedir permissão de administrador (UAC) antes de abrir o desinstalador. Aceite para ele conseguir remover tudo.'
                  : 'O Windows pode pedir permissão de administrador (UAC). Isso é normal em desinstaladores.'}
              </Row>
            )}
            {game && (
              <Row icon={RotateCcw}>
                Para jogar de novo, é só reinstalar: o jogo continua na sua biblioteca ({launcherLabel(game.launcher)})
                {bytes > 0 ? `, mas o download de ~${formatBytes(bytes)} será feito outra vez` : ''}.
              </Row>
            )}
          </ul>
        ) : undefined
      }
    />
  )
}
