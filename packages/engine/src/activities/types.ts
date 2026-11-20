import type { EngineConfig } from '../config';
import type { ActivityRecord, LearnerModel } from '../learner';
import type { Scheduler } from '../model';
import type {
  ActivitySpec,
  ActivityTypeId,
  Direction,
  EvidenceEvent,
  Feedback,
  InteractionEvent,
  Item,
  ItemSkillState,
  Purpose,
  Skill,
  Stage,
  Strand,
} from '../types';

/**
 * Why an item should come up now, worked out by the planner before any activity is chosen:
 * teach it, practise it after a miss, check it, review it, confirm it, place it, or meet it for the first time.
 */
export interface Need {
  item: Item;
  skill: Skill;
  purpose: Exclude<Purpose, 'first_listen'>;
  score: number;
  reason: string;
  /** Show and explain rather than attempt. */
  teach: boolean;
}

export interface Candidate {
  spec: ActivitySpec;
  score: number;
  reason: string;
}

export interface PlanContext {
  model: LearnerModel;
  sessionId: string;
  now: Date;
  scheduler: Scheduler;
  stage: Stage;
  needs: Need[];
  sessionActs: ActivityRecord[];
  recentItems: Set<string>;
  metThisSession: Set<string>;
}

/** A candidate plus its position, so ties keep the order needs were found in. */
export type Ordered = Candidate & { order: number };

export type AttemptEvent = Extract<InteractionEvent, { kind: 'answer' | 'dont_know' | 'choice' }>;

/**
 * What a code-graded activity may touch while it grades: the learner model's evidence helpers.
 * There is deliberately no model port here.
 */
export interface GradeContext {
  config: EngineConfig;
  item(id: string): Item | undefined;
  state(itemId: string, skill: Skill): ItemSkillState;
  /** True when this answer was later disputed and counts as correct. */
  disputed: boolean;
  emit(
    item: Item,
    skill: Skill,
    direction: Direction,
    base: number,
    latencyMs: number,
    opts: { context: string; support?: boolean; fsrs?: EvidenceEvent['fsrsGrade'] },
  ): void;
  expose(itemId: string): void;
  firstOutcome(itemId: string, correct: boolean): void;
  reviewOutcome(correct: boolean): void;
}

export interface ActivityType<S extends ActivitySpec = ActivitySpec> {
  id: S['type'];
  strand: Strand;
  grading: 'code' | 'model';
  /** Counts toward the closed-exercise cap. */
  closed: boolean;
  skills: Skill[];
  stages: Stage[];
  expectedSeconds(spec: S, item: Item | undefined, config: EngineConfig): number;
  /** The skill its evidence lands on, or null when it gives none. */
  skillOf(spec: S): Skill | null;
  candidates(ctx: PlanContext): Ordered[];
  respond?(event: AttemptEvent, a: ActivityRecord & { spec: S }, ctx: GradeContext): Feedback;
}

export type Registry = { [K in ActivityTypeId]: ActivityType<Extract<ActivitySpec, { type: K }>> };
