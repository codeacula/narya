// Shared TTS tone presets — the tuning applied when a named tone is selected.
// Server (tts.ts) and the Settings UI must agree, so this is the single source.
export const TTS_TONE_PRESETS = {
  neutral: { exaggeration: 0.5, cfgWeight: 0.5, temperature: 0.8 },
  calm: { exaggeration: 0.35, cfgWeight: 0.65, temperature: 0.7 },
  expressive: { exaggeration: 0.7, cfgWeight: 0.35, temperature: 0.85 },
  dramatic: { exaggeration: 0.9, cfgWeight: 0.3, temperature: 0.95 },
} as const;

export type TtsTonePreset = keyof typeof TTS_TONE_PRESETS;
