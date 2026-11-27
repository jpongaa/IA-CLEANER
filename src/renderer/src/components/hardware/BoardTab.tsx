import { CircuitBoard, Cpu, PcCase, ShieldCheck } from 'lucide-react'
import type { HardwareInfo } from '@shared/types/hardware'
import { formatRelative } from '@shared/format'
import { Badge, Card, KeyValue } from '../ui'
import { fmtDay, systemLabel } from './format'
import { Hint } from './parts'

/** Explicação curta do chipset (o que ele permite) para os mais comuns. */
function chipsetNote(chipset: string | undefined): string | undefined {
  if (!chipset) return undefined
  const c = chipset.toUpperCase()
  if (/^A\d{3}/.test(c)) return 'Chipset de entrada: não permite overclock do processador; a memória ainda pode usar XMP/DOCP.'
  if (/^B\d{3}/.test(c)) return 'Chipset intermediário: bom custo-benefício, com suporte a XMP/DOCP/EXPO para a memória.'
  if (/^[XZ]\d{3}/.test(c)) return 'Chipset topo de linha: mais conexões e suporte completo a overclock.'
  if (/^H\d{3}/.test(c)) return 'Chipset básico da Intel: geralmente sem overclock da memória em gerações antigas.'
  return undefined
}

export default function BoardTab({ info }: { info: HardwareInfo }) {
  const b = info.motherboard
  const bios = info.bios
  const note = chipsetNote(b.chipset)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card icon={CircuitBoard} title="Placa-mãe">
        <p className="selectable mb-4 text-[17px] font-semibold">
          {b.manufacturer} {b.product}
        </p>
        <KeyValue
          items={[
            { label: 'Fabricante', value: b.manufacturer },
            { label: 'Modelo', value: b.product },
            { label: 'Revisão', value: b.version ?? '—' },
            { label: 'Chipset', value: b.chipset ?? 'não identificado' },
            { label: 'Número de série', value: b.serial ?? '—' }
          ]}
        />
        {note && <Hint className="mt-3">{note}</Hint>}
      </Card>

      <Card
        icon={ShieldCheck}
        title="BIOS / UEFI"
        subtitle="O programa da placa-mãe que liga o PC antes do Windows"
        actions={
          bios.mode !== 'Unknown' ? (
            <Badge tone={bios.mode === 'UEFI' ? 'ok' : 'warn'}>{bios.mode === 'UEFI' ? 'Modo UEFI' : 'Modo Legacy'}</Badge>
          ) : undefined
        }
      >
        <KeyValue
          items={[
            { label: 'Fabricante', value: bios.vendor },
            { label: 'Versão', value: bios.version },
            { label: 'Data', value: bios.releaseDate ? `${fmtDay(bios.releaseDate)} (${formatRelative(bios.releaseDate)})` : '—' },
            { label: 'Modo de inicialização', value: bios.mode === 'Unknown' ? '—' : bios.mode },
            {
              label: 'Secure Boot',
              value:
                bios.secureBoot === undefined ? (
                  '—'
                ) : bios.secureBoot ? (
                  <Badge tone="ok">Ativado</Badge>
                ) : (
                  <Badge tone="warn">Desativado</Badge>
                )
            }
          ]}
        />
        <Hint className="mt-3">
          Atualizar a BIOS só é recomendado com um motivo (instabilidade, processador novo, correção de segurança). Use sempre o site oficial
          da {b.manufacturer} e nunca desligue o PC durante a atualização.
        </Hint>
      </Card>

      <Card icon={PcCase} title="Computador" className="lg:col-span-2">
        <KeyValue
          columns={2}
          items={[
            { label: 'Identificação', value: systemLabel(info) },
            { label: 'Tipo', value: info.system.isLaptop ? 'Notebook' : (info.system.chassis ?? 'Desktop') },
            { label: 'Fabricante do sistema', value: info.system.manufacturer },
            { label: 'Modelo do sistema', value: info.system.model === 'Desconhecido' ? 'não informado (PC montado)' : info.system.model },
            { label: 'Processador', value: info.cpu.name },
            { label: 'Soquete', value: info.cpu.socket ?? '—' }
          ]}
        />
        {info.cpu.socket && (
          <p className="mt-3 flex items-center gap-2 text-[12.5px] text-muted">
            <Cpu className="size-4 text-accent" />
            Para trocar o processador sem trocar a placa, ele precisa ser do soquete {info.cpu.socket} e estar na lista de compatibilidade da placa
            {b.product !== 'Desconhecida' ? ` ${b.product}` : ''} (site do fabricante).
          </p>
        )}
      </Card>
    </div>
  )
}
