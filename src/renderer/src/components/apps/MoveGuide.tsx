// Guia "Mover jogo para outro disco": passo a passo por launcher + sugestão de disco de destino.
// O app NÃO move arquivos sozinho: o launcher precisa saber o novo local (senão o jogo "some" e baixa de novo).
import clsx from 'clsx'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowRightLeft, CheckCircle2, Gamepad2, HardDrive, Lightbulb, TriangleAlert } from 'lucide-react'
import type { DriveInfo } from '@shared/types/common'
import type { GameInfo, Launcher, LauncherInfo } from '@shared/types/apps'
import { formatBytes, formatPercent, formatRelative } from '@shared/format'
import { Badge, Modal, ProgressBar, Button, usageTone } from '../ui'
import { DAY_MS, driveKindLabel, LAUNCHERS, launcherLabel, usedPercent } from './meta'
import { LauncherBadge } from './bits'

interface Guide {
  intro: string
  steps: ReactNode[]
  note?: string
  native: boolean
}

function guideFor(launcher: Launcher, steamLibraries: string[]): Guide {
  switch (launcher) {
    case 'steam':
      return {
        native: true,
        intro: 'A Steam move o jogo sozinha, sem baixar nada de novo.',
        steps: [
          <>
            Se ainda não houver uma biblioteca da Steam no disco de destino: <b>Steam → Configurações → Armazenamento</b> → clique no nome do disco no topo →{' '}
            <b>Adicionar unidade</b> → escolha o disco.
            {steamLibraries.length > 1 && (
              <span className="mt-1 block text-muted">
                Você já tem bibliotecas em: <span className="selectable font-mono text-[12px] text-text">{steamLibraries.join(' · ')}</span>
              </span>
            )}
          </>,
          <>
            Na Biblioteca, clique com o botão direito no jogo → <b>Propriedades</b> → <b>Arquivos instalados</b> → <b>Mover pasta de instalação</b>.
          </>,
          <>
            Escolha o disco de destino e clique em <b>Mover</b>. A Steam copia os arquivos e apaga a pasta antiga sozinha.
          </>
        ],
        note: 'Feche o jogo antes e não desligue o PC durante a cópia. Para HDD, jogos grandes podem levar vários minutos.'
      }
    case 'xbox':
      return {
        native: true,
        intro: 'Jogos do app Xbox / Microsoft Store podem ser movidos pelo próprio Windows.',
        steps: [
          <>
            No app <b>Xbox</b>: botão direito no jogo → <b>Gerenciar</b> → aba <b>Arquivos</b> → <b>Mover</b> → escolha o disco.
          </>,
          <>
            Ou em <b>Configurações → Aplicativos → Aplicativos instalados</b> → três pontinhos (…) do jogo → <b>Mover</b>.
          </>
        ]
      }
    case 'epic':
      return {
        native: false,
        intro: 'A Epic Games não tem botão de "mover". Há dois caminhos:',
        steps: [
          <>
            <b>Mais simples:</b> desinstale pela Epic e instale de novo escolhendo uma pasta no outro disco (ex.: <span className="font-mono">D:\Epic Games</span>). O
            jogo é baixado outra vez.
          </>,
          <>
            <b>Sem baixar tudo de novo (avançado):</b> feche a Epic, recorte a pasta do jogo e cole no outro disco pelo Explorer. Abra a Epic, clique em{' '}
            <b>Instalar</b> no jogo e escolha a pasta que <i>contém</i> a pasta do jogo no novo disco. A Epic verifica os arquivos que já estão lá e só baixa o que
            faltar.
          </>
        ],
        note: 'Se a Epic começar a baixar o jogo inteiro, pause e confira se escolheu a pasta certa.'
      }
    case 'ea':
      return {
        native: false,
        intro: 'O EA app nem sempre oferece a opção de mover.',
        steps: [
          <>
            Abra o <b>EA app → Biblioteca</b>, passe o mouse no jogo e clique nos três pontinhos (…). Se houver a opção <b>Mover</b>, use-a.
          </>,
          <>
            Se não houver: desinstale e instale de novo escolhendo o outro disco (o EA app pergunta o local na instalação; o padrão fica em{' '}
            <b>Configurações → Download</b>).
          </>
        ]
      }
    case 'ubisoft':
      return {
        native: false,
        intro: 'Dá para mover sem baixar de novo:',
        steps: [
          <>Feche o Ubisoft Connect. Recorte a pasta do jogo e cole no outro disco pelo Explorer.</>,
          <>
            Abra o <b>Ubisoft Connect → Jogos</b> → abra o jogo. Abaixo do botão de baixar, clique em <b>Localizar jogo instalado</b> e aponte a nova pasta.
          </>,
          <>O Ubisoft Connect verifica os arquivos e o jogo volta a ficar disponível.</>
        ]
      }
    case 'battlenet':
      return {
        native: false,
        intro: 'Dá para mover sem baixar de novo:',
        steps: [
          <>Feche o Battle.net. Recorte a pasta do jogo e cole no outro disco pelo Explorer.</>,
          <>
            Abra o Battle.net e selecione o jogo. Abaixo do botão <b>Instalar</b>, clique em <b>Localizar o jogo</b> e aponte a nova pasta.
          </>
        ]
      }
    case 'gog':
      return {
        native: false,
        intro: 'Jogos da GOG costumam funcionar direto da nova pasta:',
        steps: [
          <>Feche o GOG Galaxy (se usar). Recorte a pasta do jogo e cole no outro disco pelo Explorer.</>,
          <>
            No GOG Galaxy: abra o jogo → ajustes ao lado de Instalar → <b>Gerenciar instalação → Importar pasta</b> e aponte a nova pasta. Sem o Galaxy, basta criar
            um novo atalho para o .exe do jogo.
          </>
        ]
      }
    default:
      return {
        native: false,
        intro: `O ${launcherLabel(launcher)} não move jogos entre discos.`,
        steps: [<>Desinstale pelo launcher e instale de novo escolhendo uma pasta no outro disco.</>]
      }
  }
}

interface Candidate {
  drive: DriveInfo
  fits: boolean
  recommended: boolean
  why: string
}

function candidatesFor(game: GameInfo | null, drives: DriveInfo[]): Candidate[] {
  const fixed = drives.filter(
    (d) => d.driveType === 'fixed' && (game ? d.letter.toUpperCase() !== game.drive.toUpperCase() : !d.isSystem)
  )
  const need = game ? game.bytes * 1.05 + 2 * 1024 ** 3 : 0
  const recent = game?.lastPlayed ? Date.now() - game.lastPlayed < 60 * DAY_MS : false
  const list = fixed.map((d) => ({ drive: d, fits: !game || d.freeBytes >= need, recommended: false, why: '' }))
  const ssd = list.filter((c) => c.fits && c.drive.mediaType !== 'HDD' && !c.drive.isSystem).sort((a, b) => b.drive.freeBytes - a.drive.freeBytes)
  const hdd = list.filter((c) => c.fits && c.drive.mediaType === 'HDD').sort((a, b) => b.drive.freeBytes - a.drive.freeBytes)
  let best: Candidate | undefined
  if (game) {
    best = recent ? (ssd[0] ?? hdd[0]) : (hdd[0] ?? ssd[0])
    if (best) {
      best.recommended = true
      best.why =
        best.drive.mediaType === 'HDD'
          ? recent
            ? 'É o único disco com espaço. HDD carrega mais devagar, mas o jogo roda.'
            : 'Você não joga este há um tempo: o HDD guarda bem jogos pouco usados e deixa o SSD livre.'
          : recent
            ? 'Você joga este com frequência: em SSD ele carrega rápido.'
            : 'Tem espaço de sobra e é rápido.'
    }
  }
  for (const c of list) {
    if (!c.why) c.why = !c.fits ? 'Sem espaço suficiente para este jogo.' : c.drive.mediaType === 'HDD' ? 'HDD: mais lento para carregar.' : 'SSD: carrega rápido.'
  }
  return list.sort((a, b) => Number(b.recommended) - Number(a.recommended) || b.drive.freeBytes - a.drive.freeBytes)
}

export function MoveGuide({
  open,
  game,
  games,
  drives,
  launchers,
  onClose
}: {
  open: boolean
  /** Jogo específico (ou null para o guia geral) */
  game: GameInfo | null
  games: GameInfo[]
  drives: DriveInfo[]
  launchers: LauncherInfo[]
  onClose: () => void
}) {
  const present = useMemo(() => {
    const set = new Set<Launcher>(games.filter((g) => g.exists).map((g) => g.launcher))
    const order: Launcher[] = ['steam', 'xbox', 'epic', 'ea', 'ubisoft', 'battlenet', 'gog', 'riot', 'rockstar', 'other']
    const list = order.filter((l) => set.has(l))
    return list.length ? list : (['steam'] as Launcher[])
  }, [games])
  const [tab, setTab] = useState<Launcher>(present[0])
  // jogo escolhido: o recebido por props ou um escolhido na lista "maiores jogos no C:"
  const [picked, setPicked] = useState<GameInfo | null>(game)
  useEffect(() => {
    if (open) {
      setTab(game?.launcher ?? present[0])
      setPicked(game)
    }
  }, [open, game, present])

  const steamLibraries = launchers.find((l) => l.launcher === 'steam')?.libraries ?? []
  const sel = picked
  const launcher = sel?.launcher ?? tab
  const guide = guideFor(launcher, steamLibraries)
  const cands = candidatesFor(sel, drives)
  const sys = drives.find((d) => d.isSystem)
  const bigOnSys = useMemo(
    () =>
      games
        .filter((g) => g.exists && g.bytes > 0 && g.drive.toUpperCase() === (sys?.letter ?? 'C:').toUpperCase())
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 6),
    [games, sys]
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <ArrowRightLeft className="size-4 text-accent" />
          {sel ? `Mover "${sel.name}" para outro disco` : 'Como mover jogos para outro disco'}
        </span>
      }
      footer={<Button onClick={onClose}>Fechar</Button>}
    >
      <div className="space-y-5 text-[13px]">
        <div className="flex items-start gap-3 rounded-lg border border-info/30 bg-info/10 p-3">
          <Lightbulb className="mt-0.5 size-4 shrink-0 text-info" />
          <p className="text-text">
            Mover não apaga o jogo nem o seu progresso: ele só passa a ocupar outro disco.
            {sys && usedPercent(sys) >= 85 && (
              <>
                {' '}
                Seu <b>{sys.letter}</b> está {formatPercent(usedPercent(sys))} cheio — quando o disco do Windows passa de ~90%, atualizações falham e tudo fica mais
                lento.
              </>
            )}{' '}
            Faça pelo próprio launcher: se a pasta for movida “na mão”, ele pode achar que o jogo sumiu e baixar tudo de novo.
          </p>
        </div>

        {sel && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-surface-2 p-3">
            <LauncherBadge launcher={sel.launcher} />
            <span className="font-medium">{sel.name}</span>
            <span className="text-muted">
              {formatBytes(sel.bytes)} em <b className="text-text">{sel.drive}</b>
            </span>
            <span className="selectable min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint" title={sel.installPath}>
              {sel.installPath}
            </span>
            {!game && (
              <button type="button" className="text-[12px] text-accent hover:underline" onClick={() => setPicked(null)}>
                ← ver todos
              </button>
            )}
          </div>
        )}

        {!sel && bigOnSys.length > 0 && (
          <section>
            <h3 className="mb-2 flex items-center gap-2 font-semibold">
              <Gamepad2 className="size-4 text-accent" /> Maiores jogos no {sys?.letter ?? 'C:'}
            </h3>
            <ul className="divide-y divide-border/60 rounded-lg border border-border bg-surface-2">
              {bigOnSys.map((g) => (
                <li key={g.id} className="flex items-center gap-3 px-3 py-2">
                  <LauncherBadge launcher={g.launcher} />
                  <span className="min-w-0 flex-1 truncate font-medium">{g.name}</span>
                  <span className="text-[12px] text-muted">{g.lastPlayed ? `jogado ${formatRelative(g.lastPlayed)}` : 'sem registro de uso'}</span>
                  <span className="w-20 text-right font-medium tabular-nums">{formatBytes(g.bytes)}</span>
                  <Button size="sm" variant="ghost" icon={ArrowRightLeft} onClick={() => setPicked(g)}>
                    Como mover
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {cands.length > 0 && (
          <section>
            <h3 className="mb-2 flex items-center gap-2 font-semibold">
              <HardDrive className="size-4 text-accent" /> {sel ? 'Para onde mover' : 'Seus outros discos'}
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {cands.map((c) => {
                const pct = usedPercent(c.drive)
                return (
                  <div
                    key={c.drive.letter}
                    className={clsx('rounded-lg border p-3', c.recommended ? 'border-ok/50 bg-ok/5' : 'border-border bg-surface-2', !c.fits && 'opacity-60')}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">
                        {c.drive.letter} <span className="font-normal text-muted">{c.drive.label || ''}</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        <Badge tone={c.drive.mediaType === 'HDD' ? 'warn' : 'info'}>{driveKindLabel(c.drive) || '?'}</Badge>
                        {c.recommended && (
                          <Badge tone="ok" icon={CheckCircle2}>
                            Sugerido
                          </Badge>
                        )}
                      </span>
                    </div>
                    <ProgressBar value={pct} tone={usageTone(pct)} size="sm" className="mt-2" />
                    <p className="mt-1.5 text-[12px] text-muted">
                      {formatBytes(c.drive.freeBytes)} livres de {formatBytes(c.drive.totalBytes)} · {c.why}
                    </p>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        <section>
          {!sel && present.length > 1 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {present.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setTab(l)}
                  className={clsx(
                    'rounded-lg border px-2.5 py-1 text-[12.5px] font-medium',
                    tab === l ? 'border-accent/50 bg-accent/10 text-text' : 'border-border text-muted hover:text-text'
                  )}
                >
                  <span className="mr-1.5 inline-block size-2 rounded-full" style={{ backgroundColor: LAUNCHERS[l].color }} />
                  {launcherLabel(l)}
                </button>
              ))}
            </div>
          )}
          <h3 className="mb-1 flex items-center gap-2 font-semibold">
            Passo a passo no {launcherLabel(launcher)}
            {guide.native ? <Badge tone="ok">Recurso oficial</Badge> : <Badge tone="warn">Sem botão de mover</Badge>}
          </h3>
          <p className="mb-2 text-muted">{guide.intro}</p>
          <ol className="space-y-2">
            {guide.steps.map((s, i) => (
              <li key={i} className="flex gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/15 text-[12px] font-semibold text-accent">{i + 1}</span>
                <span className="pt-0.5 leading-relaxed">{s}</span>
              </li>
            ))}
          </ol>
          {guide.note && (
            <p className="mt-3 flex items-start gap-2 text-[12.5px] text-muted">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" /> {guide.note}
            </p>
          )}
        </section>
      </div>
    </Modal>
  )
}
