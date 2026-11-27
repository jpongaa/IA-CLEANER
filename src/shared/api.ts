// API completa exposta ao renderer como window.api.<namespace>.<método>(...).
// Canal IPC de cada método: '<namespace>:<método>'.
import { DISK_METHODS, type DiskApi } from './types/disk'
import { CLEANUP_METHODS, type CleanupApi } from './types/cleanup'
import { APPS_METHODS, type AppsApi } from './types/apps'
import { PERFORMANCE_METHODS, type PerformanceApi } from './types/performance'
import { HARDWARE_METHODS, type HardwareApi } from './types/hardware'
import { DRIVERS_METHODS, type DriversApi } from './types/drivers'
import { AI_METHODS, type AiApi } from './types/ai'
import { DISCOVER_METHODS, type DiscoverApi } from './types/discover'
import { REPAIR_METHODS, type RepairApi } from './types/repair'
import { SETTINGS_METHODS, SYSTEM_METHODS, type SettingsApi, type SystemApi } from './types/settings'
import type { EventMap, EventName } from './events'

export interface IaCleanerApi {
  disk: DiskApi
  cleanup: CleanupApi
  apps: AppsApi
  performance: PerformanceApi
  hardware: HardwareApi
  drivers: DriversApi
  ai: AiApi
  discover: DiscoverApi
  repair: RepairApi
  settings: SettingsApi
  system: SystemApi
}

export type Namespace = keyof IaCleanerApi

export const API_METHODS: { [K in Namespace]: readonly (keyof IaCleanerApi[K])[] } = {
  disk: DISK_METHODS,
  cleanup: CLEANUP_METHODS,
  apps: APPS_METHODS,
  performance: PERFORMANCE_METHODS,
  hardware: HARDWARE_METHODS,
  drivers: DRIVERS_METHODS,
  ai: AI_METHODS,
  discover: DISCOVER_METHODS,
  repair: REPAIR_METHODS,
  settings: SETTINGS_METHODS,
  system: SYSTEM_METHODS
}

/** O que o preload expõe em window.api */
export interface ExposedApi extends IaCleanerApi {
  /** Assina um evento main->renderer. Retorna função para cancelar a assinatura. */
  on<E extends EventName>(event: E, listener: (payload: EventMap[E]) => void): () => void
}
