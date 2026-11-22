import { invoke } from '@tauri-apps/api/core';
import type { ContentStore, Dictionary, DictionaryEntry, EventStore, ExplanationStore, GradeStore, InteractionEvent, Llm, LlmResult, StoredContent, StoredExplanation, StoredGrade, Token, Tokenizer } from '@jle/engine';
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

export interface TransferSummary {
  events: number;
  content: number;
  grades: number;
  explanations: number;
  /** Export: the file written. Import: where this machine's previous data was copied. */
  path: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Saves all progress (the log and every stored passage, grade and explanation) to a file the learner picks.
 * Returns null when the save dialog is cancelled. In the browser, the log alone is downloaded in the same format.
 */
export async function exportProgress(learnerId: string): Promise<TransferSummary | null> {
  if (inTauri) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: `jle-progress-${today()}.json`, filters: [{ name: 'Progress', extensions: ['json'] }] });
    if (!path) return null;
    return invoke<TransferSummary>('export_progress', { path, exportedAt: new Date().toISOString() });
  }
  const events = await store.load(learnerId);
  const file = { format: 'jle-progress', version: 1, schemaVersion: 0, exportedAt: new Date().toISOString(), events, content: [], grades: [], explanations: [] };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
  a.download = `jle-progress-${today()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  return { events: events.length, content: 0, grades: 0, explanations: 0, path: a.download };
}

/** Lets the learner pick a progress file. Returns its path (desktop) or the file (browser), or null when cancelled. */
export async function pickProgressFile(): Promise<string | File | null> {
  if (inTauri) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ multiple: false, directory: false, filters: [{ name: 'Progress', extensions: ['json'] }] });
    return typeof path === 'string' ? path : null;
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/**
 * Replaces this machine's progress with a progress file. On the desktop the host checks the whole file first and
 * copies the current data aside before swapping; a bad file changes nothing.
 */
export async function importProgress(file: string | File): Promise<TransferSummary> {
  if (typeof file === 'string') return invoke<TransferSummary>('import_progress', { path: file });
  let parsed: { format?: string; events?: InteractionEvent[] };
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  if (parsed.format !== 'jle-progress' || !Array.isArray(parsed.events)) throw new Error('This is not a progress file from this app.');
  const backup = browserStore.exportJson();
  browserStore.replace(parsed.events);
  return { events: parsed.events.length, content: 0, grades: 0, explanations: 0, path: `browser storage (previous log kept under jle.events.backup, ${backup.length} bytes)` };
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

/** Explanations of mistakes, stored once in the host's database and reused. */
export const explanationStore: ExplanationStore = {
  get: (key) => invoke<StoredExplanation | null>('explanation_get', { key }),
  put: (explanation) => invoke<void>('explanation_put', { explanation }),
};

/** Graded writing, stored once in the host's database and read back on replay. */
export const gradeStore: GradeStore = {
  load: (learnerId) => invoke<StoredGrade[]>('grade_load', { learnerId }),
  put: (grade) => invoke<void>('grade_put', { grade }),
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
