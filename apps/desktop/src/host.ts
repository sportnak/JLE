import { invoke } from '@tauri-apps/api/core';
import type { EventStore, InteractionEvent } from '@jle/engine';
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
