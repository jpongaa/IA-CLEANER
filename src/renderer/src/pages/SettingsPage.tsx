import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Settings } from 'lucide-react'
import type { AppInfo, AppSettings } from '@shared/types/settings'
import { ErrorBox, PageHeader, Skeleton, useToast } from '../components/ui'
import { refreshAiStatus, useAiStatus } from '../components/ai'
import { ApiKeyCard } from '../components/settings/ApiKeyCard'
import { ModelCard } from '../components/settings/ModelCard'
import { CleanupPrefsCard } from '../components/settings/CleanupPrefsCard'
import { PrivacyCard, SystemCard, UsageCard } from '../components/settings/InfoCards'
import { api, errMsg } from '../lib/api'

type Totals = { inputTokens: number; outputTokens: number; costUsd: number; calls: number }

export default function SettingsPage() {
  const toast = useToast()
  const { status } = useAiStatus()
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [totals, setTotals] = useState<Totals | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setSettings(await api.settings.get())
    } catch (e) {
      setError(errMsg(e))
    }
    api.system.getAppInfo().then(setInfo).catch(() => undefined)
    api.ai.getUsageTotals().then(setTotals).catch(() => undefined)
  }, [])

  useEffect(() => {
    void load()
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current)
    }
  }, [load])

  const flashSaved = (): void => {
    setSavedAt(Date.now())
    if (savedTimer.current) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setSavedAt(null), 2500)
  }

  const update = useCallback(
    (patch: Partial<Omit<AppSettings, 'apiKeySet'>>) => {
      // Otimista: mostra a mudança na hora; desfaz se falhar.
      setSettings((cur) => (cur ? { ...cur, ...patch } : cur))
      api.settings
        .update(patch)
        .then((s) => {
          setSettings(s)
          flashSaved()
          if ('model' in patch || 'webSearch' in patch) void refreshAiStatus()
        })
        .catch((e) => {
          toast.error(`Não foi possível salvar: ${errMsg(e)}`)
          void load()
        })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load]
  )

  return (
    <div>
      <PageHeader
        title="Configurações"
        icon={Settings}
        description="Chave e modelo da IA, preferências de limpeza, privacidade e permissões. As mudanças são salvas automaticamente."
        actions={
          savedAt ? (
            <span className="flex items-center gap-1.5 text-[12.5px] text-ok">
              <CheckCircle2 className="size-4" /> Salvo
            </span>
          ) : null
        }
      />

      {error && <ErrorBox className="mb-4" error={error} onRetry={() => void load()} />}

      {!settings && !error ? (
        <div className="space-y-4">
          <Skeleton className="h-44" />
          <Skeleton className="h-64" />
          <Skeleton className="h-40" />
        </div>
      ) : settings ? (
        <div className="space-y-5">
          <ApiKeyCard
            settings={settings}
            status={status}
            onSettings={(s) => {
              setSettings(s)
              flashSaved()
            }}
          />
          <ModelCard settings={settings} update={update} />
          <div className="grid grid-cols-2 items-start gap-5">
            <div className="space-y-5">
              <CleanupPrefsCard settings={settings} update={update} />
              <PrivacyCard />
            </div>
            <div className="space-y-5">
              <UsageCard totals={totals} />
              <SystemCard info={info} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
