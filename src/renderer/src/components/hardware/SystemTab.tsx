import clsx from 'clsx'
import { AudioLines, Battery, MonitorCog, TriangleAlert } from 'lucide-react'
import type { HardwareInfo } from '@shared/types/hardware'
import { formatDate, formatNumber } from '@shared/format'
import { Card, KeyValue } from '../ui'
import { fmtUptime } from './format'

function audioKind(name: string): string | undefined {
  if (/steam streaming|virtual|broadcast|droidcam|voicemeeter|vb-audio|cable (input|output)/i.test(name)) return 'virtual (criado por programa)'
  if (/hdmi|nvidia high definition audio|amd high definition audio|intel.*display audio/i.test(name)) return 'som pelo HDMI/DisplayPort'
  if (/usb|headset|cloud|hyperx|logitech|razer|steelseries|corsair/i.test(name)) return 'USB / headset'
  if (/realtek|conexant|via hd|idt|cirrus|senary/i.test(name)) return 'som da placa-mãe'
  return undefined
}

export default function SystemTab({ info }: { info: HardwareInfo }) {
  const o = info.os
  const bat = info.battery
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card icon={MonitorCog} title="Windows" className="lg:col-span-2">
        <KeyValue
          columns={2}
          items={[
            { label: 'Sistema', value: o.caption },
            { label: 'Versão', value: o.displayVersion ? `${o.displayVersion} (${o.version})` : o.version },
            { label: 'Build', value: o.build || '—' },
            { label: 'Arquitetura', value: o.architecture || '—' },
            { label: 'Instalado em', value: formatDate(o.installDate) },
            { label: 'Ligado desde', value: o.lastBoot ? `${formatDate(o.lastBoot, true)} (${fmtUptime(o.lastBoot)})` : '—' },
            { label: 'Nome do computador', value: o.computerName || '—' },
            { label: 'Usuário', value: o.userName || '—' }
          ]}
        />
        {o.lastBoot && Date.now() - new Date(o.lastBoot).getTime() > 7 * 86_400_000 && (
          <p className="mt-3 text-[12.5px] text-muted">
            O PC está ligado há {fmtUptime(o.lastBoot)} sem reiniciar. Reiniciar de vez em quando libera memória e conclui atualizações pendentes
            (desligar com "Inicialização rápida" ativa não conta como reiniciar).
          </p>
        )}
      </Card>

      <Card icon={AudioLines} title="Áudio" subtitle="Dispositivos de som reconhecidos" className={bat ? undefined : 'lg:col-span-2'}>
        {info.audio.length === 0 ? (
          <p className="text-[13px] text-muted">Nenhum dispositivo de áudio informado.</p>
        ) : (
          <ul className={clsx('grid gap-x-8 gap-y-1.5 text-[13px]', !bat && 'md:grid-cols-2')}>
            {info.audio.map((a) => (
              <li key={a} className="flex items-center justify-between gap-3 border-b border-border/50 pb-1.5">
                <span>{a}</span>
                {audioKind(a) && <span className="shrink-0 text-[11.5px] text-faint">{audioKind(a)}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {bat && (
        <Card icon={Battery} title="Bateria">
          <KeyValue
            items={[
              { label: 'Carga atual', value: bat.chargePercent !== undefined ? `${bat.chargePercent}%` : '—' },
              { label: 'Estado', value: bat.status ?? '—' },
              { label: 'Saúde', value: bat.healthPercent !== undefined ? `${bat.healthPercent}% da capacidade original` : '—' },
              { label: 'Capacidade de fábrica', value: bat.designCapacityMwh ? `${formatNumber(bat.designCapacityMwh)} mWh` : '—' },
              { label: 'Capacidade atual (carga cheia)', value: bat.fullChargeCapacityMwh ? `${formatNumber(bat.fullChargeCapacityMwh)} mWh` : '—' }
            ]}
          />
        </Card>
      )}

      {info.warnings.length > 0 && (
        <Card icon={TriangleAlert} title="O que não foi possível ler" className="lg:col-span-2">
          <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted">
            {info.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
