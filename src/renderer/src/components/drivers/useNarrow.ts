// Largura disponível para uma tabela: abaixo do limite ela usa o layout compacto (menos colunas fixas),
// para o nome do dispositivo continuar legível na janela mínima (1100×700).
import { useLayoutEffect, useState } from 'react'

/** Devolve [ref de callback, estreito?]. Mede o elemento (ResizeObserver) antes da pintura, sem "piscar". */
export function useNarrow<T extends HTMLElement = HTMLDivElement>(minWidePx: number): [(el: T | null) => void, boolean] {
  const [el, setEl] = useState<T | null>(null)
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    if (!el) return
    const update = (): void => setNarrow(el.clientWidth > 0 && el.clientWidth < minWidePx)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el, minWidePx])
  return [setEl, narrow]
}
