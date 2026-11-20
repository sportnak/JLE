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

export interface Catalog {
  items: Item[];
  edges: ItemEdge[];
  clusters: Cluster[];
  pairs?: MinimalPair[];
  sentences?: DictationSentence[];
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
