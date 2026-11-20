import type { Stage, Strand } from './types';

export interface EngineConfig {
  version: string;
  rulesVersion: string;
  strengths: {
    promptedProductionCorrect: number;
    productionWrong: number;
    selfCorrect: number;
    recognitionAnswer: number;
    dontKnow: number;
    override: number;
    minimalPairChoice: number;
    dictationItem: number;
    /** Looking a word up while reading: a weak recognition miss. */
    lookup: number;
    /** Reading past a word already met without looking it up: weak recognition evidence. */
    readPast: number;
    /** A question on a passage that hinges on a word, answered right or wrong. */
    comprehension: number;
    /** Producing a form of a word: mostly a grammar check, so it weighs on the word lightly. */
    transformation: number;
  };
  modifiers: {
    supportDiscount: number;
    recentExposureMinutes: number;
    recentExposureDiscount: number;
    fastMs: Record<'read' | 'write', number>;
    slowMs: number;
    fastBonus: number;
    slowPenalty: number;
    productionToRecognition: number;
  };
  model: {
    evidenceScale: number;
    priorWeight: number;
    defaultPrior: number;
    knownThreshold: number;
    knownMinContexts: number;
    knownMinDays: number;
    maintainedStabilityDays: number;
    leechLapses: number;
    lapseMinStrength: number;
  };
  fsrs: { desiredRetention: number };
  planner: {
    newItemsPerSession: number;
    retentionLow: number;
    retentionHigh: number;
    relearnGap: number;
    maxRelearnPerSession: number;
    checkGap: number;
    probeThreshold: number;
    teachModeDontKnows: number;
    prerequisiteMin: number;
    confirmAfterDays: number;
  };
  timing: {
    baseSeconds: Record<'introduce' | 'kana_to_reading' | 'ja_to_en' | 'en_to_ja' | 'minimal_pair' | 'dictation' | 'reading' | 'comprehension' | 'transformation', number>;
    perCharSeconds: number;
    /** Reading is faster per character than typing an answer. */
    readingPerCharSeconds: number;
  };
  reading: {
    /** Words met (Introduced or further, for recognition) before generated reading starts. */
    minMetWords: number;
    /** Share of tracked words in a passage the learner must have met. */
    coverage: number;
    /** Different unmet words a passage may hold, besides its targets. */
    maxNewWords: number;
    /** Words a passage is written around. */
    targets: number;
    /** Tries after the first when a passage fails its checks. */
    retries: number;
    /** Have a second model check every generated passage (architecture §7: review is conditional; for now, always). */
    review: boolean;
    /** Lowest coverage a built-in library passage may have to be offered. */
    libraryCoverage: number;
    /** Days before a passage already read is offered again. */
    rereadAfterDays: number;
  };
  mix: {
    /** Recognition-Known word counts where stages 2, 3 and 4 begin. */
    stageWords: [number, number, number];
    strandTargets: Record<Stage, Record<Strand, number>>;
    /** Pull toward the strand furthest below its target, in score points per unit of share. */
    strandWeight: number;
    /** Weight of this session's own strand shares against the trailing week's. */
    sessionBlend: number;
    /** Session minutes before its own shares count. */
    sessionBlendAfterMinutes: number;
    /** From stage 2, closed code-graded exercises stay under this share of session time. */
    closedCap: number;
    closedPenalty: number;
  };
  placement: {
    samplesPerCluster: number;
    knownPrior: number;
    unknownPrior: number;
  };
}

export const DEFAULT_CONFIG: EngineConfig = {
  version: 'config-1',
  rulesVersion: 'rules-2',
  strengths: {
    promptedProductionCorrect: 0.7,
    productionWrong: 0.8,
    selfCorrect: 0.3,
    recognitionAnswer: 0.5,
    dontKnow: 0.7,
    override: 1.0,
    minimalPairChoice: 0.5,
    dictationItem: 0.5,
    lookup: 0.3,
    readPast: 0.2,
    comprehension: 0.4,
    transformation: 0.4,
  },
  modifiers: {
    supportDiscount: 0.6,
    recentExposureMinutes: 10,
    recentExposureDiscount: 0.5,
    fastMs: { read: 3000, write: 6000 },
    slowMs: 15000,
    fastBonus: 1.1,
    slowPenalty: 0.85,
    productionToRecognition: 0.5,
  },
  model: {
    evidenceScale: 3,
    priorWeight: 2,
    defaultPrior: 0.3,
    knownThreshold: 0.85,
    knownMinContexts: 2,
    knownMinDays: 2,
    maintainedStabilityDays: 30,
    leechLapses: 4,
    lapseMinStrength: 0.5,
  },
  fsrs: { desiredRetention: 0.9 },
  planner: {
    newItemsPerSession: 10,
    retentionLow: 0.85,
    retentionHigh: 0.92,
    relearnGap: 3,
    maxRelearnPerSession: 2,
    checkGap: 5,
    probeThreshold: 0.6,
    teachModeDontKnows: 3,
    prerequisiteMin: 0.6,
    confirmAfterDays: 1,
  },
  timing: {
    baseSeconds: { introduce: 6, kana_to_reading: 4, ja_to_en: 6, en_to_ja: 7, minimal_pair: 5, dictation: 8, reading: 15, comprehension: 10, transformation: 9 },
    perCharSeconds: 1,
    readingPerCharSeconds: 0.4,
  },
  reading: {
    minMetWords: 20,
    coverage: 0.8,
    maxNewWords: 3,
    targets: 3,
    retries: 2,
    review: true,
    libraryCoverage: 0.6,
    rereadAfterDays: 3,
  },
  mix: {
    stageWords: [300, 800, 1700],
    strandTargets: {
      1: { study: 0.5, input: 0.3, output: 0.1, fluency: 0.1 },
      2: { study: 0.35, input: 0.3, output: 0.25, fluency: 0.1 },
      3: { study: 0.25, input: 0.25, output: 0.25, fluency: 0.25 },
      4: { study: 0.15, input: 0.35, output: 0.3, fluency: 0.2 },
    },
    strandWeight: 50,
    sessionBlend: 0.5,
    sessionBlendAfterMinutes: 1,
    closedCap: 0.4,
    closedPenalty: 200,
  },
  placement: {
    samplesPerCluster: 3,
    knownPrior: 0.8,
    unknownPrior: 0.15,
  },
};
