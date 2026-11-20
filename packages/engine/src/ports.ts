import type { InteractionEvent, StoredContent, StoredGrade } from './types';

export interface Clock {
  now(): Date;
}

export interface Ids {
  next(): string;
}

export interface EventStore {
  load(learnerId: string): Promise<InteractionEvent[]>;
  append(event: InteractionEvent): Promise<void>;
}

export type LlmRoute = 'generate' | 'grade' | 'tutor' | 'explain' | 'review';

/** One request on a route. The host picks the model for the route, caches `system`, and asks for JSON matching `schema`. */
export interface LlmRequest {
  promptVersion: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  effort: 'low' | 'medium' | 'high';
  sessionId?: string;
}

export interface LlmResult {
  output: unknown;
  stopReason: string;
  /** The model that answered, which may be a fallback. */
  model: string;
  callId: string;
}

/** The model, behind the host. One interface, five routes. Code-graded activities never see it. */
export interface Llm {
  call(route: LlmRoute, request: LlmRequest): Promise<LlmResult>;
}

/** A token from the host's tokenizer (Sudachi). Readings are hiragana; offsets are characters. */
export interface Token {
  surface: string;
  dictionaryForm: string;
  normalizedForm: string;
  reading: string;
  dictionaryReading: string;
  pos: string[];
  begin: number;
  end: number;
  oov: boolean;
}

export interface Tokenizer {
  analyze(text: string): Promise<Token[]>;
}

/** A JMdict entry from the host's reference database. */
export interface DictionaryEntry {
  id: number;
  written: string;
  reading: string;
  freqRank: number | null;
  pos: string[];
  gloss: string[];
}

export interface Dictionary {
  /** One result per key, in order; null when no entry matches. */
  lookup(keys: { lemma: string; reading?: string }[]): Promise<(DictionaryEntry | null)[]>;
}

/** Stored outputs the engine writes once and reads back on replay. */
export interface ContentStore {
  load(learnerId: string): Promise<StoredContent[]>;
  put(content: StoredContent): Promise<void>;
}

/** Graded writing, stored once and read back on replay. */
export interface GradeStore {
  load(learnerId: string): Promise<StoredGrade[]>;
  put(grade: StoredGrade): Promise<void>;
}

export class MemoryGradeStore implements GradeStore {
  grades: StoredGrade[] = [];
  async load(learnerId: string) {
    return this.grades.filter((g) => g.learnerId === learnerId);
  }
  async put(grade: StoredGrade) {
    if (this.grades.some((g) => g.id === grade.id)) throw new Error(`grade ${grade.id} already stored`);
    this.grades.push(grade);
  }
}

/** An explanation written once from an approved fact sheet and reused by key. */
export interface StoredExplanation {
  key: string;
  createdAt: string;
  promptVersion: string;
  model: string;
  text: string;
}

export interface ExplanationStore {
  get(key: string): Promise<StoredExplanation | null>;
  put(explanation: StoredExplanation): Promise<void>;
}

export class MemoryExplanationStore implements ExplanationStore {
  readonly entries = new Map<string, StoredExplanation>();
  async get(key: string) {
    return this.entries.get(key) ?? null;
  }
  async put(e: StoredExplanation) {
    if (this.entries.has(e.key)) throw new Error(`explanation ${e.key} already stored`);
    this.entries.set(e.key, e);
  }
}

export class MemoryContentStore implements ContentStore {
  contents: StoredContent[] = [];
  async load(learnerId: string) {
    return this.contents.filter((c) => c.learnerId === learnerId);
  }
  async put(content: StoredContent) {
    if (this.contents.some((c) => c.id === content.id)) throw new Error(`content ${content.id} already stored`);
    this.contents.push(content);
  }
}

export const systemClock: Clock = { now: () => new Date() };

export const randomIds: Ids = { next: () => crypto.randomUUID() };

export class MemoryEventStore implements EventStore {
  events: InteractionEvent[] = [];
  async load(learnerId: string) {
    return this.events.filter((e) => e.learnerId === learnerId);
  }
  async append(event: InteractionEvent) {
    this.events.push(event);
  }
}
