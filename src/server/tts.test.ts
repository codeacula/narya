import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { saveAppConfig } from './appConfig';
import { getTtsEngineStatus, getTtsSettings, getTtsVoices, speakText, updateTtsSettings } from './tts';

const realFetch = globalThis.fetch;

type Call = { url: string; init: RequestInit | undefined };

let calls: Call[] = [];
let respond: (url: string) => Response;

function stubFetch() {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url);
  }) as typeof fetch;
}

function enable(voiceProfileId = 'usFemale') {
  updateTtsSettings({ enabled: true, voiceProfileId, languageId: 'en', volume: 0.8 });
}

function disable() {
  updateTtsSettings({ enabled: false, voiceProfileId: 'usFemale', languageId: 'en', volume: 0.8 });
}

beforeEach(() => {
  stubFetch();
  respond = () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  saveAppConfig({ tengwarBaseUrl: 'http://tengwar.test:8008', clearTengwarApiKey: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * The whole point of the enabled flag: an operator who turns TTS off expects narya
 * to stop talking to the speech service, not to keep probing it quietly. Every one
 * of these asserts on the absence of a network call, not just on the return value.
 */
describe('TTS is not contacted while disabled', () => {
  beforeEach(() => { disable(); });

  test('the status probe reports disabled without reaching the network', async () => {
    const status = await getTtsEngineStatus();
    expect(status).toEqual({ ok: false, disabled: true, baseUrl: 'http://tengwar.test:8008' });
    expect(calls).toHaveLength(0);
  });

  test('the voice list is empty without reaching the network', async () => {
    expect(await getTtsVoices()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('speakText is a no-op without reaching the network', async () => {
    await speakText('hello');
    expect(calls).toHaveLength(0);
  });
});

describe('getTtsEngineStatus', () => {
  beforeEach(() => { enable(); });

  // /health is the unauthenticated endpoint, so a wrong API key reads as a bad key
  // rather than as an unreachable service.
  test('probes /health', async () => {
    const status = await getTtsEngineStatus();
    expect(calls[0]?.url).toBe('http://tengwar.test:8008/health');
    expect(status.ok).toBe(true);
    expect(status.disabled).toBeUndefined();
  });

  test('reports an unreachable service instead of throwing', async () => {
    respond = () => { throw new Error('connect ECONNREFUSED'); };
    const status = await getTtsEngineStatus();
    expect(status.ok).toBe(false);
    expect(status.error).toContain('ECONNREFUSED');
  });

  test('bounds the probe with a timeout signal', async () => {
    await getTtsEngineStatus();
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('getTtsVoices', () => {
  beforeEach(() => { enable(); });

  test('maps the {voices:[{id,name}]} contract onto TtsVoice', async () => {
    respond = () => Response.json({
      voices: [{ id: 'usMale', name: 'US male' }, { id: 'ukFemale', name: 'UK female' }],
    });
    const voices = await getTtsVoices();
    expect(calls[0]?.url).toBe('http://tengwar.test:8008/voices');
    expect(voices).toEqual([
      { id: 'usMale', name: 'US male', category: 'tengwar', languageId: 'en', createdAt: null },
      { id: 'ukFemale', name: 'UK female', category: 'tengwar', languageId: 'en', createdAt: null },
    ]);
  });

  test('rejects a response whose entries have no id', async () => {
    respond = () => Response.json({ voices: ['usMale'] });
    await expect(getTtsVoices()).rejects.toThrow('invalid voices response');
  });
});

describe('synthesis', () => {
  beforeEach(() => { enable('ukMale'); });

  test('POSTs /synthesize with the tengwar body shape', async () => {
    respond = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    await speakText('hello there');
    const call = calls[0];
    expect(call?.url).toBe('http://tengwar.test:8008/synthesize');
    expect(call?.init?.method).toBe('POST');
    // speakerId, not voiceId — and none of the Chatterbox tuning knobs.
    expect(JSON.parse(String(call?.init?.body))).toEqual({ text: 'hello there', speakerId: 'ukMale' });
  });

  test('surfaces a 400 for an unknown speaker as an error', async () => {
    respond = () => Response.json({ error: 'unknown speakerId' }, { status: 400 });
    await expect(speakText('hello')).rejects.toThrow('unknown speakerId');
  });
});

describe('the API key header', () => {
  beforeEach(() => { enable(); });

  // An unkeyed Tengwar accepts requests with no header at all, so sending an empty
  // one would be strictly worse than sending none.
  test('is omitted when no key is configured', async () => {
    respond = () => Response.json({ voices: [] });
    await getTtsVoices();
    expect(calls[0]?.init?.headers).not.toHaveProperty('X-Api-Key');
  });

  test('is sent on data endpoints when a key is configured', async () => {
    saveAppConfig({ tengwarApiKey: 'sekrit' });
    respond = () => Response.json({ voices: [] });
    await getTtsVoices();
    expect((calls[0]?.init?.headers as Record<string, string>)['X-Api-Key']).toBe('sekrit');

    calls = [];
    respond = () => new Response(new Uint8Array([1]), { status: 200 });
    await speakText('hi');
    expect((calls[0]?.init?.headers as Record<string, string>)['X-Api-Key']).toBe('sekrit');
  });
});

describe('voice profile ids', () => {
  // Rows written under Chatterbox hold ids Tengwar rejects; remapping on read keeps
  // an untouched install speaking instead of 400ing on every line.
  test('the Chatterbox-era default is remapped to a real Tengwar speaker', () => {
    expect(updateTtsSettings({
      enabled: false, voiceProfileId: 'zombiechicken', languageId: 'en', volume: 0.8,
    }).voiceProfileId).toBe('usFemale');
    expect(getTtsSettings().voiceProfileId).toBe('usFemale');
  });

  test('a real speaker id is kept as-is', () => {
    expect(updateTtsSettings({
      enabled: false, voiceProfileId: 'ukFemale', languageId: 'en', volume: 0.8,
    }).voiceProfileId).toBe('ukFemale');
  });
});
