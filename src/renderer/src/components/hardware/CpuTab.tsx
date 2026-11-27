import { Cpu, ExternalLink, Layers, Thermometer } from 'lucide-react'
import type { HardwareInfo } from '@shared/types/hardware'
import { Badge, Button, Card, KeyValue, useToast } from '../ui'
import { api, errMsg } from '../../lib/api'
import { fmtMhz, fmtPct } from './format'
import { Chips, Hint, LiveTag, SubTitle, UsageBar } from './parts'
import type { LiveState } from './useLiveStats'

const CACHE_TYPE = { data: 'dados', instruction: 'instruções', unified: '' } as const

function hex(n: number | undefined): string {
  return n === undefined ? '—' : `${n} (${n.toString(16).toUpperCase()}h)`
}

export default function CpuTab({ info, live }: { info: HardwareInfo; live: LiveState }) {
  const toast = useToast()
  const c = info.cpu
  const l = live.latest
  const virtLabel = c.vendor === 'AMD' ? 'AMD-V' : c.vendor === 'Intel' ? 'VT-x' : 'virtualização'
  const hasAvx2 = c.instructions.includes('AVX2')

  const openHwinfo = (): void => {
    api.system.openExternal('https://www.hwinfo.com/download/').catch((e) => toast.error(errMsg(e)))
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2" icon={Cpu} title="Processador" actions={<LiveTag waiting={!l} />}>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <p className="selectable mr-1 text-[17px] font-semibold">{c.name}</p>
          <Badge tone="accent">{c.vendor}</Badge>
          {c.codename && <Badge tone="ai">{c.codename}</Badge>}
          {c.technology && <Badge>{c.technology}</Badge>}
        </div>
        <KeyValue
          columns={2}
          items={[
            { label: 'Fabricante', value: c.vendor },
            { label: 'Codinome', value: c.codename ?? 'não reconhecido' },
            { label: 'Soquete', value: c.socket ?? '—' },
            { label: 'Tecnologia', value: c.technology ?? '—' },
            { label: 'Núcleos / threads', value: `${c.cores} / ${c.threads}` },
            { label: 'Arquitetura', value: c.architecture },
            { label: 'Clock base', value: fmtMhz(c.baseMhz) },
            { label: 'Clock agora', value: l?.cpuMhz ? fmtMhz(l.cpuMhz) : l ? 'indisponível' : 'medindo...' },
            { label: 'Família', value: hex(c.family) },
            { label: 'Modelo / stepping', value: c.model !== undefined ? `${hex(c.model)} / ${c.stepping ?? '—'}` : '—' },
            {
              label: 'Virtualização',
              value:
                c.virtualizationEnabled === undefined ? '—' : c.virtualizationEnabled ? `Ativada (${virtLabel})` : <span className="text-warn">Desativada na BIOS</span>
            },
            { label: 'Hipervisor ativo', value: c.hypervisorPresent ? 'Sim (Hyper-V/WSL/VBS)' : 'Não' }
          ]}
        />
        {c.sockets && c.sockets > 1 && <p className="mt-2 text-[12px] text-muted">{c.sockets} processadores físicos instalados (valores somados).</p>}

        <SubTitle>Uso agora</SubTitle>
        <UsageBar label="Processador (todos os núcleos)" value={l?.cpuPercent ?? 0} detail={l ? fmtPct(l.cpuPercent) : '—'} />

        <SubTitle>Conjuntos de instruções</SubTitle>
        <Chips items={c.instructions} empty="Não foi possível ler (leitor nativo indisponível)" />
        <Hint className="mt-3">
          O <b className="text-text">clock base</b> é a velocidade mínima garantida; quando há trabalho o processador acelera sozinho
          (Turbo Boost / Precision Boost) — por isso o valor <b className="text-text">agora</b> costuma ser maior.
          {c.instructions.length > 0 &&
            (hasAvx2
              ? ' Este processador tem AVX2, exigido por alguns jogos e programas recentes.'
              : ' Atenção: sem AVX2, alguns jogos recentes não abrem.')}
        </Hint>
      </Card>

      <div className="space-y-4">
        <Card icon={Layers} title="Memória cache" subtitle="Memória ultrarrápida dentro do processador">
          {c.caches?.length ? (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Nível</th>
                  <th className="num">Tamanho</th>
                  <th className="num">Vias</th>
                </tr>
              </thead>
              <tbody>
                {c.caches.map((k) => (
                  <tr key={`${k.level}-${k.type}`}>
                    <td>
                      L{k.level} {CACHE_TYPE[k.type]}
                    </td>
                    <td className="num">
                      {k.count > 1 ? `${k.count} × ` : ''}
                      {k.sizeKb >= 1024 ? `${k.sizeKb / 1024} MB` : `${k.sizeKb} KB`}
                    </td>
                    <td className="num">{k.ways ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <KeyValue
              items={[
                { label: 'L1 (total)', value: c.l1Kb ? `${c.l1Kb} KB` : '—' },
                { label: 'L2 (total)', value: c.l2Kb ? `${c.l2Kb} KB` : '—' },
                { label: 'L3 (total)', value: c.l3Kb ? `${c.l3Kb / 1024} MB` : '—' }
              ]}
            />
          )}
          {c.l3Kb && <p className="mt-2 text-[12px] text-muted">Cache L3 grande ajuda bastante em jogos.</p>}
        </Card>

        <Card icon={Thermometer} title="Temperatura do processador">
          <p className="text-[13px] leading-relaxed text-muted">
            O Windows <b className="text-text">não informa a temperatura real do processador</b> sem um driver especial de terceiros — por isso o IA
            Cleaner não mostra um número inventado. Para ver temperatura, voltagens e velocidade das ventoinhas, use o <b className="text-text">HWiNFO</b>{' '}
            (gratuito e confiável).
          </p>
          <Button size="sm" className="mt-3" icon={ExternalLink} onClick={openHwinfo}>
            Abrir site oficial do HWiNFO
          </Button>
          <p className="mt-2 text-[11.5px] text-faint">Referência: em jogos, até ~80 °C é normal; acima de 90 °C vale limpar o pó e revisar a pasta térmica.</p>
        </Card>
      </div>
    </div>
  )
}
