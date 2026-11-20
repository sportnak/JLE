import type { ActivitySpec, ActivityTypeId } from '../types';
import { comprehension } from './comprehension';
import { dictation } from './dictation';
import { introduce } from './introduce';
import { minimalPair } from './minimalPair';
import { reading } from './reading';
import { retrieval } from './retrieval';
import { transformation } from './transformation';
import type { ActivityType, Registry } from './types';

/** Every activity type the planner can choose from. A new type is a new entry here, never a planner change. */
export const REGISTRY: Registry = {
  introduce,
  retrieval,
  minimal_pair: minimalPair,
  dictation,
  reading,
  comprehension,
  transformation,
};

export const activityTypes = (): ActivityType[] => Object.values(REGISTRY) as ActivityType[];

export function typeOf<S extends ActivitySpec>(spec: S): ActivityType<S> {
  return REGISTRY[spec.type as ActivityTypeId] as unknown as ActivityType<S>;
}

export type { ActivityType, Candidate, GradeContext, Need, PlanContext } from './types';
export { cueFor, retrievalSpec } from './retrieval';
export { eligiblePairs } from './minimalPair';
export { readyForDictation } from './dictation';
export { transformationSpec } from './transformation';
