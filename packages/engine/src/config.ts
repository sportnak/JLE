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
    baseSeconds: Record<'introduce' | 'kana_to_reading' | 'ja_to_en' | 'en_to_ja' | 'minimal_pair' | 'dictation', number>;
    perCharSeconds: number;
  };
  mix: {
    /** Recognition-Known word counts where stages 2, 3 and 4 begin. */
    stageWords: [number, number, number];
    strandTargets: Record<Stage, Record<Strand, number>>;
    /** Pull toward the strand furthest below its target, in score points per unit of share. */
    strandWeight: number;
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
    baseSeconds: { introduce: 6, kana_to_reading: 4, ja_to_en: 6, en_to_ja: 7, minimal_pair: 5, dictation: 8 },
    perCharSeconds: 1,
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
    closedCap: 0.4,
    closedPenalty: 200,
  },
  placement: {
    samplesPerCluster: 3,
    knownPrior: 0.8,
    unknownPrior: 0.15,
  },
};
