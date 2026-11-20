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

/** One step of a grammar point's token pattern: data, matched against tokenizer output (architecture §6.2). */
export interface TokenPattern {
  surface?: string;
  lemma?: string;
  /** First part-of-speech level, as Sudachi gives it (助詞, 動詞, …). */
  pos?: string;
  /** `te`: a verb or adjective in its 連用形 followed by the particle て or で, both taken as one step. */
  form?: string;
}

/** A sentence with a gap (＿) and two forms that could fill it, only one of them right. */
export interface GrammarContrast {
  sentence: string;
  answer: string;
  other: string;
  translation: string;
}

/**
 * A grammar point as data (packages/grammar). Its fact sheet is a gate: only an approved point reaches the learner,
 * through `Catalog.grammar()`. Approval is a reviewed edit in the repo, by someone who reads Japanese well.
 */
export interface GrammarPoint {
  id: string;
  version: number;
  label: string;
  tags: { genki?: number; jlpt?: string };
  prerequisites: string[];
  confusables: string[];
  /** Alternatives; each is a sequence of steps matched against consecutive tokens. */
  matcher: TokenPattern[][];
  factSheet: { status: 'draft' | 'approved'; approvedBy?: string; approvedAt?: string; body: string };
  contrasts: GrammarContrast[];
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
  /** Grammar points, drafts included: the catalog keeps only approved ones. */
  grammar?: GrammarPoint[];
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
  /** Items written this way (any reading), most useful first. */
  byWritten(written: string): Item[];
  /** Members of one cluster, in their teaching order. */
  inCluster(clusterId: string): Item[];
  /** Edges pointing at an item: its components and prerequisites, and confusables. */
  edgesInto(itemId: string): ItemEdge[];
  pair(id: string): MinimalPair | undefined;
  /** Minimal pairs for a sound feature. */
  pairsFor(itemId: string): MinimalPair[];
  /** Dictation sentences that contain the item. */
  sentencesWith(itemId: string): DictationSentence[];
  /** Approved grammar points only. A draft never reaches the learner. */
  grammar(): GrammarPoint[];
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
  /** Dictionary form, first part-of-speech level and conjugation form, for matching grammar at read time. */
  lemma?: string;
  pos?: string;
  form?: string;
}

/** A question on a passage. It hinges on one word when `itemId` is set: answering needs that word understood. */
export interface ContentQuestion {
  prompt: string;
  options: string[];
  /** Index of the right option. */
  answer: number;
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
  /** Written for this learner by the model, brought by the learner, or taken from the built-in library. */
  source: 'generated' | 'learner' | 'library';
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
  /** Part of a longer text the learner brought, read in order. */
  series?: { id: string; part: number; of: number };
  /** Multiple-choice questions on the passage, asked right after it is read. */
  questions?: ContentQuestion[];
  /** The second model's verdict, when the passage was reviewed. */
  review?: { model: string; natural: boolean; translationMatches: boolean; problems: string[] };
}

/** Kinds of error the grader may report. Closed list, so evidence and error hunt can rely on it. */
export const ERROR_TYPES = ['particle', 'conjugation', 'word_choice', 'spelling', 'word_order', 'politeness', 'missing_word', 'extra_word', 'other'] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

/**
 * One finding from the grader, as the model returned it (the grading contract, architecture §6.3). The model never
 * gives item ids: it quotes the learner's text and names a lemma or a grammar-point id from the list it was given.
 */
export interface RawFinding {
  /** Exact text from the learner's answer that is wrong. */
  quote: string;
  /** Dictionary form of the word concerned, when the error is about a word. */
  lemma: string | null;
  /** A grammar-point id from the list sent, when the error is about grammar. */
  grammarPoint: string | null;
  errorType: ErrorType;
  /** What the quote should be. */
  correction: string;
  /** One or two plain English sentences. */
  explanation: string;
  confidence: 'high' | 'medium' | 'low';
}

/** A finding after code has mapped it. `itemId` absent means it could not be mapped: logged, no evidence. */
export interface Finding extends RawFinding {
  /** Character span of the quote in the answer, or null when the quote is not in it. */
  begin: number | null;
  end: number | null;
  itemId?: string;
  /** The answer's sentence holding this error with every other correction applied, so it shows exactly one error. */
  singleErrorSentence?: string;
}

/**
 * A graded piece of free writing: a stored output, written once and read back on replay (architecture §4.3), so the
 * model is never called again. Evidence is applied from it when its `writing_graded` event is replayed.
 */
export interface StoredGrade {
  id: string;
  learnerId: string;
  activityId: string;
  createdAt: string;
  promptVersion: string;
  model: string;
  /** The learner's answer, exactly as graded. */
  answer: string;
  /** The answer with every correction applied. */
  corrected: string;
  /** Target words the grader says were used correctly, as item ids (mapped in code). */
  targetsUsed: string[];
  /** Words in the answer the tokenizer mapped to items, for light evidence on words used without error. */
  usedItems: string[];
  findings: Finding[];
  /** A short encouraging comment in English. */
  comment: string;
}

/** An error the learner has made, derived from grades on replay; error hunt draws on these (step 3). */
export interface LearnerError {
  itemId: string;
  errorType: ErrorType;
  quote: string;
  correction: string;
  sentence: string;
  singleErrorSentence: string;
  gradeId: string;
  confidence: RawFinding['confidence'];
  timesSeen: number;
  lastAt: string;
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
      type: 'transformation';
      itemId: string;
      purpose: 'practice';
      /** The form asked for, as the conjugator labels it ("polite past"). */
      form: string;
      /** Accepted answers: the form built from the written word and from its reading. */
      expected: string[];
    }
  | {
      type: 'cloze';
      itemId: string;
      purpose: Exclude<Purpose, 'first_listen'>;
      contentId: string;
      /** The kept sentence, and where the blank is in it (character offsets). */
      sentence: string;
      blankBegin: number;
      blankEnd: number;
      /** The word as it stands in the sentence, written and in kana. */
      answers: string[];
    }
  | {
      type: 'contrast';
      /** The grammar point's item (`grammar:<id>`). */
      itemId: string;
      purpose: 'practice';
      pointId: string;
      /** The fact sheet version the example came from. */
      version: number;
      example: number;
      sentence: string;
      translation: string;
      /** Both forms, in the order shown. */
      options: [string, string];
      answer: string;
    }
  | {
      type: 'writing';
      /** The first target word (for display and planning); evidence lands on every word the grader maps. */
      itemId: string;
      purpose: 'practice';
      /** The task, in English, chosen in code from a fixed list. */
      task: string;
      /** Words to use, as item ids. */
      targets: string[];
      /** Sentences asked for, a rough length. */
      sentences: number;
    }
  | {
      type: 'comprehension';
      /** The word the question hinges on, or for a question with no hinge, the passage's first word (no evidence). */
      itemId: string;
      purpose: 'practice';
      contentId: string;
      question: number;
      prompt: string;
      /** Options in the order shown. */
      options: string[];
      answer: string;
      hinge: boolean;
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
    | { kind: 'keep_sentence'; contentId: string; begin: number; end: number }
    | { kind: 'writing_graded'; activityId: string; gradeId: string }
    | { kind: 'unkeep_sentence'; contentId: string; begin: number }
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
