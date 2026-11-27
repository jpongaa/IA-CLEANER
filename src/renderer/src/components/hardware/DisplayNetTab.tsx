import { Cable, Monitor, Network, Wifi } from 'lucide-react'
import type { DisplayInfo, HardwareInfo } from '@shared/types/hardware'
import { Badge, Card, KeyValue } from '../ui'
import { fmtBits, fmtDay, fmtRate } from './format'
import { ExtLiveTag, Hint } from './parts'
import type { LiveState } from './useLiveStats'

function DisplayCard({ d }: { d: DisplayInfo }) {
  const below = d.refreshRateHz && d.maxRefreshRateHz && d.maxRefreshRateHz > d.refreshRateHz + 5
  return (
    <Card
      icon={Monitor}
      title={d.name}
      subtitle={[d.manufacturer, d.year ? `fabricado em ${d.year}` : undefined].filter(Boolean).join(' · ') || undefined}
      actions={d.isPrimary ? <Badge tone="accent">Principal</Badge> : undefined}
    >
      <KeyValue
        items={[
          { label: 'Resolução', value: d.resolution ? d.resolution.replace('x', ' × ') : '—' },
          {
            label: 'Taxa de atualização',
            value: d.refreshRateHz ? <span className={below ? 'text-warn' : undefined}>{`${d.refreshRateHz} Hz`}</span> : '—'
          },
          { label: 'Máximo nesta resolução', value: d.maxRefreshRateHz ? `${d.maxRefreshRateHz} Hz` : '—' },
          { label: 'Tamanho (informado pelo monitor)', value: d.sizeInches ? `≈ ${d.sizeInches.toLocaleString('pt-BR')}"` : '—' },
          { label: 'Conexão', value: d.connection ?? '—' },
          { label: 'Ligado na placa', value: d.adapter ?? '—' },
          { label: 'Cores', value: d.bitsPerPixel ? `${d.bitsPerPixel} bits` : '—' }
        ]}
      />
      {below && (
        <Hint tone="warn" className="mt-3">
          O monitor aceita {d.maxRefreshRateHz} Hz mas está em {d.refreshRateHz} Hz. Ajuste em Configurações &gt; Sistema &gt; Tela &gt; Tela avançada.
        </Hint>
      )}
    </Card>
  )
}

export default function DisplayNetTab({ info, live }: { info: HardwareInfo; live: LiveState }) {
  const l = live.latest
  const physical = info.network.filter((n) => !n.isVirtual)
  const virtual = info.network.filter((n) => n.isVirtual)
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {info.displays.length === 0 ? (
          <Card icon={Monitor} title="Monitores">
            <p className="text-[13px] text-muted">O Windows não informou os monitores conectados.</p>
          </Card>
        ) : (
          info.displays.map((d, i) => <DisplayCard key={`${d.name}-${i}`} d={d} />)
        )}
        {info.displays.length === 1 && (
          <Hint className="self-start">
            A taxa de atualização (Hz) é quantas imagens por segundo o monitor mostra. Monitores gamer de 144 Hz ou mais só funcionam nessa
            velocidade com o cabo certo (DisplayPort ou HDMI 2.0+) e a opção ajustada no Windows.
          </Hint>
        )}
      </div>

      <Card
        icon={Network}
        title="Rede"
        subtitle="Placas de rede físicas"
        actions={
          <span className="flex items-center gap-3 text-[12.5px] text-muted">
            <span>
              ↓ <b className="font-medium text-text tabular-nums">{fmtRate(l?.netRxBps)}</b>
            </span>
            <span>
              ↑ <b className="font-medium text-text tabular-nums">{fmtRate(l?.netTxBps)}</b>
            </span>
            <ExtLiveTag latest={l} />
          </span>
        }
      >
        {physical.length === 0 ? (
          <p className="text-[13px] text-muted">Nenhuma placa de rede física encontrada.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Adaptador</th>
                <th>Tipo</th>
                <th>Status</th>
                <th className="num">Velocidade do link</th>
                <th>Driver</th>
                <th>Endereço MAC</th>
              </tr>
            </thead>
            <tbody>
              {physical.map((n) => (
                <tr key={n.name}>
                  <td>
                    <p className="font-medium">{n.name}</p>
                    <p className="text-[12px] text-muted">{n.description}</p>
                  </td>
                  <td>
                    <span className="inline-flex items-center gap-1.5">
                      {n.isWifi ? <Wifi className="size-4 text-accent" /> : <Cable className="size-4 text-accent" />}
                      {n.isWifi ? 'Wi-Fi' : 'Cabo'}
                    </span>
                  </td>
                  <td>
                    <Badge tone={n.connected ? 'ok' : 'neutral'}>{n.status}</Badge>
                  </td>
                  <td className="num">{n.connected ? fmtBits(n.linkSpeedBps) : '—'}</td>
                  <td>
                    <p>{n.driverVersion ?? '—'}</p>
                    {n.driverDate && <p className="text-[12px] text-muted">{fmtDay(n.driverDate)}</p>}
                  </td>
                  <td className="selectable font-mono text-[12px] text-muted">{n.macAddress ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {virtual.length > 0 && (
          <p className="mt-3 text-[12px] text-faint">
            Adaptadores virtuais (VPN, Hyper-V, jogos em rede): {virtual.map((n) => `${n.name} (${n.status.toLowerCase()})`).join(' · ')}
          </p>
        )}
        <p className="mt-2 text-[12px] text-faint">A taxa ao vivo soma só as placas físicas. "Velocidade do link" é o limite da conexão com o roteador, não a velocidade da internet.</p>
      </Card>
    </div>
  )
}
