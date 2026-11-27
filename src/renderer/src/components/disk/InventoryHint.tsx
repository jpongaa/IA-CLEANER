// Aviso: sem o inventário de Jogos & Programas, o guard só reconhece jogos/programas em pastas padrão
// (Steam, Epic, Program Files...). Jogos em pastas próprias (ex.: D:\Jogos) só ganham o cadeado depois dele.
import { useEffect, useState } from 'react'
import { Gamepad2, Info } from 'lucide-react'
import { Button } from '../ui'
import { api } from '../../lib/api'
import { useNav } from '../../lib/nav'

export function InventoryHint() {
  const nav = useNav()
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let alive = true
    api.apps
      .getLastInventory()
      .then((inv) => alive && setMissing(!inv))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  if (!missing) return null
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-[12.5px]" data-testid="inventory-hint">
      <Info className="size-4 shrink-0 text-info" />
      <p className="flex-1">
        O app ainda não conhece os jogos e programas instalados neste PC. Arquivos deles em pastas próprias (ex.: <span className="font-mono">D:\Jogos</span>)
        só ganham o cadeado depois que você abrir <b>Jogos & Programas</b> uma vez.
      </p>
      <Button size="sm" variant="ghost" icon={Gamepad2} onClick={() => nav.go('apps')}>
        Abrir Jogos & Programas
      </Button>
    </div>
  )
}
