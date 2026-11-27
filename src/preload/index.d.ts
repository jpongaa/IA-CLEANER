import type { ExposedApi } from '../shared/api'

declare global {
  interface Window {
    api: ExposedApi
  }
}

export {}
