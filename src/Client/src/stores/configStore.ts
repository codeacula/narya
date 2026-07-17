import { defineStore } from 'pinia'

import { getConfig, getHealth } from '../services/api'
import { onEvent } from '../services/realtime'
import type { AppConfigResponse, HealthResponse } from '../types'

const SETTINGS_UPDATED_EVENT = 'settings:updated'

interface ConfigStoreState {
  config: AppConfigResponse | null
  health: HealthResponse | null
}

export const useConfigStore = defineStore('config', {
  state: (): ConfigStoreState => ({
    config: null,
    health: null,
  }),
  actions: {
    /** Fetch health + config via REST. Call once on mount; live updates after that come via subscribe(). */
    async load(): Promise<void> {
      const [health, config] = await Promise.all([getHealth(), getConfig()])
      this.health = health
      this.config = config
    },

    /**
     * Subscribe to settings:updated and replace `config` in place with the
     * broadcast payload — no re-fetch. The broadcast payload is the same
     * masked AppConfigResponse shape GET/PUT /api/config return (see
     * RealtimePublisher / AppConfigUpdatedNotification), so it's safe to use
     * directly. Returns an unsubscribe function.
     */
    subscribeToUpdates(): () => void {
      return onEvent(SETTINGS_UPDATED_EVENT, (payload) => {
        this.config = payload as AppConfigResponse
      })
    },
  },
})
