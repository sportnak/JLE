import { invoke } from '@tauri-apps/api/core';
import type { ContentStore, Dictionary, DictionaryEntry, EventStore, InteractionEvent, Llm, LlmResult, StoredContent, Token, Tokenizer } from '@jle/engine';
import { LocalStorageEventStore } from './storage';
import { getSpeed, getVoice } from './prefs';

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** The event log as the Rust host keeps it: SQLite, append-only. */
class TauriEventStore implements EventStore {
  load(learnerId: string) {
    return invoke<InteractionEvent[]>('events_load', { learnerId });
  }
  append(event: InteractionEvent) {
    return invoke<void>('events_append', { event });
  }
}

const browserStore = new LocalStorageEventStore();
export const store: EventStore = inTauri ? new TauriEventStore() : browserStore;

export async function resetLog() {
  if (inTauri) await invoke('events_reset');
  else browserStore.clear();
}

export async function exportLog(learnerId: string): Promise<string> {
  return JSON.stringify(await store.load(learnerId), null, 2);
}

/** Speaks Japanese with the system voice; falls back to the browser's speech engine. */
export async function speak(text: string, speaker: number | null = getVoice(), speed: number = getSpeed()) {
  if (inTauri) {
    try {
      await invoke('speak', { text, speaker, speed });
      return;
    } catch {
      /* fall through to the browser voice */
    }
  }
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ja-JP';
  u.rate = speed;
  const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith('ja'));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

/** Plays phrases one after another, such as both words of a minimal pair. A later request stops the rest. */
export async function speakSequence(texts: string[], gapMs = 600, speaker: number | null = getVoice(), speed: number = getSpeed()) {
  if (inTauri) {
    try {
      await invoke('speak_sequence', { texts, speaker, speed, gapMs });
      return;
    } catch {
      /* fall through to the browser voice */
    }
  }
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith('ja'));
  texts.forEach((text, i) => {
    const u = new SpeechSynthesisUtterance(i === 0 ? text : `、${text}`);
    u.lang = 'ja-JP';
    u.rate = speed;
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  });
}

/** Renders clips ahead of time so the first play starts at once. Silent when there is no host. */
export async function prepareSpeech(texts: string[], speaker: number | null = getVoice(), speed: number = getSpeed()) {
  if (!inTauri) return;
  await invoke('prepare_speech', { texts, speaker, speed }).catch(() => undefined);
}

export interface VoiceInfo {
  engine: 'voicevox' | 'system';
  version: string | null;
  speaker: string | null;
  style: string | null;
  credit: string | null;
}

export async function voiceInfo(speaker: number | null = getVoice()): Promise<VoiceInfo> {
  if (!inTauri) return { engine: 'system', version: null, speaker: null, style: null, credit: null };
  return invoke<VoiceInfo>('voice_info', { speaker });
}

export interface VoiceOption {
  id: number;
  name: string;
  style: string;
  uuid: string;
}

export async function listVoices(): Promise<VoiceOption[]> {
  if (!inTauri) return [];
  return invoke<VoiceOption[]>('voices');
}

export async function voiceTerms(uuid: string): Promise<string> {
  return invoke<string>('voice_terms', { uuid });
}

/** Morphological analysis in the host (Sudachi). Needs the desktop app and its dictionary. */
export const tokenizer: Tokenizer = {
  analyze: (text) => invoke<Token[]>('analyze', { text, mode: 'C' }),
};

/** JMdict lookups in the host's bundled reference database. */
export const dictionary: Dictionary = {
  lookup: (keys) => invoke<(DictionaryEntry | null)[]>('dictionary_lookup', { keys }),
};

/** The model, through the host. The API key never leaves the host. */
export const llm: Llm = {
  call: (route, request) => invoke<LlmResult>('llm_call', { request: { route, ...request } }),
};

/** Stored passages, kept in the host's database next to the log. */
export const contentStore: ContentStore = {
  load: (learnerId) => invoke<StoredContent[]>('content_load', { learnerId }),
  put: (content) => invoke<void>('content_put', { content }),
};

export async function apiKeyStatus(): Promise<boolean> {
  if (!inTauri) return false;
  return (await invoke<{ set: boolean }>('api_key_status')).set;
}

export const setApiKey = (key: string) => invoke<void>('api_key_set', { key });
export const clearApiKey = () => invoke<void>('api_key_clear');

export interface RouteUsage {
  route: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export async function llmUsage(): Promise<RouteUsage[]> {
  if (!inTauri) return [];
  return invoke<RouteUsage[]>('llm_usage');
}
