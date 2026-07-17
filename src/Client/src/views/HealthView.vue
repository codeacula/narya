<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'

import { useConfigStore } from '../stores/configStore'
import { start as startRealtime } from '../services/realtime'

const store = useConfigStore()
const { config, health } = storeToRefs(store)

const loadError = ref<string | null>(null)
const realtimeError = ref<string | null>(null)

let unsubscribe: (() => void) | null = null

const configFields: Array<{ label: string; key: keyof NonNullable<typeof config.value> }> = [
  { label: 'Twitch channel', key: 'twitchChannel' },
  { label: 'Twitch client ID', key: 'twitchClientId' },
  { label: 'Twitch client secret configured', key: 'twitchClientSecretConfigured' },
  { label: 'OBS URL', key: 'obsUrl' },
  { label: 'OBS password configured', key: 'obsPasswordConfigured' },
  { label: 'OBS scene prefix', key: 'obsScenePrefix' },
  { label: 'Discord client ID', key: 'discordClientId' },
  { label: 'Discord bot token configured', key: 'discordBotTokenConfigured' },
  { label: 'Chatterbox base URL', key: 'chatterboxBaseUrl' },
  { label: 'Music poll interval (ms)', key: 'musicPollIntervalMs' },
  { label: 'Music playerctl player', key: 'musicPlayerctlPlayer' },
  { label: 'Sound volume', key: 'soundVolume' },
  { label: 'Updated at', key: 'updatedAt' },
]

onMounted(async () => {
  try {
    await store.load()
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  }

  unsubscribe = store.subscribeToUpdates()

  try {
    await startRealtime()
  } catch (err) {
    // Live updates are best-effort here: the initial REST load already
    // succeeded, so a hub connection failure degrades to "no live updates"
    // rather than blocking the page.
    realtimeError.value = err instanceof Error ? err.message : String(err)
  }
})

onUnmounted(() => {
  unsubscribe?.()
})
</script>

<template>
  <main class="health-view">
    <h1>Narya health</h1>

    <p v-if="loadError" class="error" role="alert">Failed to load: {{ loadError }}</p>
    <p v-if="realtimeError" class="warning" role="status">
      Live updates unavailable: {{ realtimeError }}
    </p>

    <section>
      <h2>Health</h2>
      <pre>{{ JSON.stringify(health, null, 2) }}</pre>
    </section>

    <section>
      <h2>Configuration</h2>
      <p v-if="!config">Loading…</p>
      <dl v-else class="config-list">
        <template v-for="field in configFields" :key="field.key">
          <dt>{{ field.label }}</dt>
          <dd>{{ config[field.key] ?? '—' }}</dd>
        </template>
      </dl>
    </section>
  </main>
</template>

<style scoped>
.health-view {
  max-width: 640px;
  margin: 0 auto;
  padding: 2rem 1rem;
  font-family: system-ui, sans-serif;
}

.error {
  color: #b00020;
}

.warning {
  color: #a15c00;
}

.config-list {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 1rem;
}

.config-list dt {
  font-weight: 600;
}

.config-list dd {
  margin: 0;
}

pre {
  background: #f4f3ec;
  padding: 0.75rem;
  border-radius: 4px;
  overflow-x: auto;
}
</style>
