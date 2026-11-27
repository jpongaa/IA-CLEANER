// Navegação simples entre páginas (sem roteador).
import { createContext, useContext } from 'react'

export type PageId =
  | 'dashboard'
  | 'disk'
  | 'cleanup'
  | 'apps'
  | 'discover'
  | 'performance'
  | 'repair'
  | 'hardware'
  | 'drivers'
  | 'assistant'
  | 'history'
  | 'settings'

export interface NavContextValue {
  page: PageId
  go: (page: PageId) => void
}

export const NavContext = createContext<NavContextValue>({ page: 'dashboard', go: () => undefined })

export function useNav(): NavContextValue {
  return useContext(NavContext)
}
