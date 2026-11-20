export type Skill = 'read' | 'listen' | 'write' | 'speak';
export type ItemType = 'script' | 'kanji' | 'vocab' | 'grammar' | 'sound' | 'function';
export type Status = 'unseen' | 'introduced' | 'learning' | 'known' | 'maintained' | 'leech';
export type Direction = 'positive' | 'negative';

export interface Item {
  id: string;
  language: string;
  type: ItemType;
  written: string;
  reading: string;
  gloss: string[];
  skills: Skill[];
  cluster: string;
  order: number;
  tags: { genki?: number; jlpt?: string; freq?: number };
  pos?: import('./conjugate').Pos;
}

export type EdgeKind = 'prerequisite' | 'component' | 'confusable';
export interface ItemEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface Cluster {
  id: string;
  track: string;
  order: number;
  label: string;
  requires?: string[];
  /** Taught only when wanted (looked up while reading), never by walking the cluster in order. */
  wantedOnly?: boolean;
}

/** Two words that differ in one sound feature, written in kana. `kana` lists the kana items both words use. */
export interface MinimalPair {
  id: string;
  itemId: string;
  a: { kana: string; gloss: string };
  b: { kana: string; gloss: string };
  difference: string;
  kana: string[];
}

export interface Segment {
  text: string;
  reading: string;
  itemId?: string;
}

/** A short sentence for dictation. Segments without an item id are untracked glue (particles, です). */
export interface DictationSentence {
  id: string;
  segments: Segment[];
}

/** Static tables a small catalog is built from: kana, the starter list, sound features, authored sentences. */
export interface CatalogData {
  items: Item[];
  edges: ItemEdge[];
  clusters: Cluster[];
  pairs?: MinimalPair[];
  sentences?: DictationSentence[];
  /** Retired item ids and the ids that replaced them, for logs written before the change. */
  aliases?: Record<string, string>;
}

/**
 * Reference lookups. The engine reaches items only through these, never by scanning every item,
 * so the same planner runs over a starter list or the full dictionary.
 */
export interface Catalog {
  item(id: string): Item | undefined;
  /** The current id for an item id found in the log: a retired id maps to its replacement, any other is unchanged. */
  resolve(id: string): string;
  /** Clusters (kana groups, word bands), in no particular order. A few dozen, never per item. */
  clusters(): Cluster[];
  cluster(id: string): Cluster | undefined;
  /** Members of one cluster, in their teaching order. */
  inCluster(clusterId: string): Item[];
  /** Edges pointing at an item: its components and prerequisites, and confusables. */
  edgesInto(itemId: string): ItemEdge[];
  pair(id: string): MinimalPair | undefined;
  /** Minimal pairs for a sound feature. */
  pairsFor(itemId: string): MinimalPair[];
  /** Dictation sentences that contain the item. */
  sentencesWith(itemId: string): DictationSentence[];
  /** Adds items met in stored content (words beyond the built-in list). Items already present are kept as they are. */
  extend(items: Item[]): void;
}

/** A token of stored content, mapped to an item when it is a tracked word. Offsets are in characters. */
export interface ContentToken {
  surface: string;
  /** Hiragana reading of the surface. */
  reading: string;
  begin: number;
  end: number;
  itemId?: string;
}

/**
 * A piece of text the learner reads: generated to a spec or brought by the learner. A stored output: written once,
 * never changed, and read back on replay so the model is never called again.
 */
export interface StoredContent {
  id: string;
  learnerId: string;
  createdAt: string;
  source: 'generated' | 'learner';
  promptVersion: string;
  model: string;
  title: string;
  text: string;
  /** English, shown after reading. */
  translation: string;
  tokens: ContentToken[];
  /** Every item the token map points at, so the content replays the same whatever the built-in list holds. */
  items: Item[];
  /** The words it was written around. */
  targets: string[];
  /** Share of tracked words the learner had met when it was written. */
  coverage: number;
}

export type Strand = 'input' | 'output' | 'study' | 'fluency';
export type Stage = 1 | 2 | 3 | 4;

export type Cue = 'kana_to_reading' | 'ja_to_en' | 'en_to_ja';

export const CUE_SKILL: Record<Cue, Skill> = {
  kana_to_reading: 'read',
  ja_to_en: 'read',
  en_to_ja: 'write',
};

export type Purpose = 'review' | 'probe' | 'placement' | 'practice' | 'confirm' | 'first_listen';

export type ActivitySpec =
  | { type: 'introduce'; itemId: string; pairId?: string }
  | {
      type: 'retrieval';
      itemId: string;
      cue: Cue;
      purpose: Exclude<Purpose, 'first_listen'>;
      showFurigana: boolean;
    }
  | {
      type: 'minimal_pair';
      itemId: string;
      purpose: Purpose;
      pairId: string;
      /** Both words, in the order shown. */
      options: [string, string];
      /** The word that is played. */
      answer: string;
    }
  | {
      type: 'reading';
      /** The passage's first target word; evidence lands on every tracked word in it. */
      itemId: string;
      purpose: 'practice';
      contentId: string;
      /** Characters in the passage, for its expected time. */
      chars: number;
    }
  | {
      type: 'dictation';
      /** The word the dictation was chosen for. Every tracked segment gets evidence. */
      itemId: string;
      purpose: Purpose;
      sentenceId: string;
      segments: Segment[];
    };

export type ActivityTypeId = ActivitySpec['type'];

interface Base {
  id: string;
  seq: number;
  at: string;
  learnerId: string;
  language: string;
}

export type InteractionEvent = Base &
  (
    | { kind: 'session_started'; sessionId: string; minutes: number; utcOffsetMinutes: number }
    | { kind: 'session_completed'; sessionId: string }
    | { kind: 'activity_started'; sessionId: string; activityId: string; spec: ActivitySpec }
    | { kind: 'activity_completed'; activityId: string }
    | { kind: 'answer'; activityId: string; text: string; latencyMs: number; attempt: number }
    | { kind: 'dont_know'; activityId: string; latencyMs: number }
    | { kind: 'choice'; activityId: string; choice: string; latencyMs: number }
    | { kind: 'skip'; activityId: string }
    | { kind: 'dispute'; activityId: string }
    | { kind: 'override'; itemId: string; claim: 'known' }
    | { kind: 'flag'; activityId: string; reason: string }
    | { kind: 'lookup'; activityId: string; itemId: string; tokenIndex: number }
    | { kind: 'reading_done'; activityId: string; latencyMs: number }
  );

export type InteractionKind = InteractionEvent['kind'];

/** Distributes Omit over a union, so each event variant keeps its own fields. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewInteraction = DistributiveOmit<InteractionEvent, 'id' | 'seq' | 'at' | 'learnerId' | 'language'>;

export interface EvidenceEvent {
  interactionId: string;
  itemId: string;
  skill: Skill;
  direction: Direction;
  strength: number;
  baseStrength: number;
  context: string;
  rulesVersion: string;
  fsrsGrade: 'again' | 'hard' | 'good' | null;
}

export interface FsrsCard {
  stability: number;
  stabilityFast: number;
  difficulty: number;
  state: number;
  scheduleStatus: string;
  dueAt: Date;
  lastReviewAt: Date | null;
  reps: number;
  lapses: number;
  scheduledDays: number;
  learningStep: number;
}

export interface ItemSkillState {
  itemId: string;
  skill: Skill;
  pos: number;
  neg: number;
  pKnown: number;
  card: FsrsCard | null;
  status: Status;
  contexts: string[];
  evidenceDays: string[];
  lastEvidenceAt: string | null;
  lastDirection: Direction | null;
  negativeStreak: number;
  lapses: number;
  confirmDueAt: string | null;
  needsExplanation: boolean;
}

export interface Grade {
  correct: boolean;
  expected: string;
  note?: string;
}

export type Feedback =
  | { kind: 'correct'; expected: string; note?: string }
  | { kind: 'incorrect'; expected: string; note?: string; canDispute: boolean }
  | { kind: 'retry'; message: string }
  | { kind: 'revealed'; expected: string }
  | { kind: 'none' };
