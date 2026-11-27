// Preferências de limpeza/varredura: modo padrão de exclusão e pastas ignoradas na varredura.
import { useState } from 'react'
import { FolderMinus, FolderOpen, FolderX, Plus, Recycle, ShieldAlert, Trash2, X } from 'lucide-react'
import type { AppSettings } from '@shared/types/settings'
import { api } from '../../lib/api'
import { Button, Card, ConfirmDialog } from '../ui'
import { Segmented, SettingRow } from './Segmented'

const ABS_PATH = /^[a-zA-Z]:\\(?:[^<>:"/\\|?*\r\n]+\\?)*$/

export function CleanupPrefsCard({ settings, update }: { settings: AppSettings; update: (patch: Partial<Omit<AppSettings, 'apiKeySet'>>) => void }) {
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [confirmPermanent, setConfirmPermanent] = useState(false)
  const list = settings.scanExclusions ?? []

  const pick = async (): Promise<void> => {
    const chosen = await api.system.pickFolder('Pasta para a varredura ignorar').catch(() => null)
    if (chosen) add(chosen)
  }

  const add = (value: string = path): void => {
    let p = value.trim().replace(/^"+|"+$/g, '').replace(/\//g, '\\')
    if (p.length > 3) p = p.replace(/\\+$/, '')
    if (/^[a-zA-Z]:$/.test(p)) p += '\\'
    if (!ABS_PATH.test(p)) {
      setError('Informe um caminho completo de pasta, por exemplo: D:\\Backups ou C:\\Users\\voce\\Videos\\Gravacoes')
      return
    }
    if (list.some((x) => x.toLowerCase() === p.toLowerCase())) {
      setError('Essa pasta já está na lista.')
      return
    }
    update({ scanExclusions: [...list, p] })
    setPath('')
    setError(null)
  }

  return (
    <Card title="Limpeza e varredura" icon={FolderMinus} subtitle="Como o app apaga arquivos que você escolher e o que a varredura deve ignorar.">
      <SettingRow
        label="Arquivos escolhidos por você vão para..."
        description={
          settings.deleteMode === 'recycle' ? (
            'Lixeira: dá para recuperar depois. Recomendado.'
          ) : (
            <span className="text-warn">Apagar de vez: libera espaço na hora, mas NÃO dá para recuperar.</span>
          )
        }
      >
        <Segmented
          ariaLabel="Modo de exclusão"
          value={settings.deleteMode}
          options={[
            { value: 'recycle', label: 'Lixeira', icon: Recycle },
            { value: 'permanent', label: 'Apagar de vez', icon: Trash2 }
          ]}
          onChange={(v) => (v === 'permanent' ? setConfirmPermanent(true) : update({ deleteMode: 'recycle' }))}
        />
      </SettingRow>
      <p className="-mt-1 mb-3 text-[11.5px] text-faint">Vale para arquivos que você escolhe apagar (arquivos grandes, duplicados). Você sempre confirma antes.</p>

      <div className="border-t border-border/60 pt-3.5">
        <p className="text-[13px] font-medium">Pastas ignoradas na varredura</p>
        <p className="mt-0.5 text-[12px] text-muted">A Análise de Discos não entra nessas pastas (útil para backups enormes ou pastas de trabalho).</p>
        <div className="mt-2.5 flex gap-2">
          <input
            className="input flex-1 font-mono"
            placeholder="D:\Backups"
            value={path}
            onChange={(e) => {
              setPath(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
            aria-label="Pasta a ignorar"
          />
          <Button icon={FolderOpen} onClick={() => void pick()} title="Escolher a pasta numa janela">
            Escolher…
          </Button>
          <Button icon={Plus} onClick={() => add()} disabled={!path.trim()}>
            Adicionar
          </Button>
        </div>
        {error && <p className="mt-1.5 text-[12px] text-danger">{error}</p>}
        <ul className="mt-2.5 space-y-1">
          {list.length === 0 && <li className="text-[12.5px] text-faint">Nenhuma pasta ignorada.</li>}
          {list.map((p) => (
            <li key={p} className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5">
              <FolderX className="size-3.5 shrink-0 text-faint" />
              <span className="selectable min-w-0 flex-1 truncate font-mono text-[12px]" title={p}>
                {p}
              </span>
              <button
                type="button"
                onClick={() => update({ scanExclusions: list.filter((x) => x !== p) })}
                className="rounded p-0.5 text-faint hover:bg-surface-3 hover:text-text"
                aria-label={`Remover ${p}`}
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </div>

      <ConfirmDialog
        open={confirmPermanent}
        title="Apagar de vez por padrão?"
        message={
          <div className="flex items-start gap-2">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" />
            <span>Arquivos que você escolher apagar (arquivos grandes, duplicados) não irão para a Lixeira e não poderão ser recuperados. Você ainda confirma cada exclusão.</span>
          </div>
        }
        confirmLabel="Usar 'Apagar de vez'"
        tone="danger"
        onConfirm={() => {
          update({ deleteMode: 'permanent' })
          setConfirmPermanent(false)
        }}
        onCancel={() => setConfirmPermanent(false)}
      />
    </Card>
  )
}
