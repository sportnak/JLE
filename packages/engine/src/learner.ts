import { typeOf } from './activities';
import type { AttemptEvent, GradeContext } from './activities/types';
import type { EngineConfig } from './config';
import { applyEvidence, emptyState, pKnownOf, type Scheduler } from './model';
import { computePlacement, priorFor, type ClusterPlacement } from './placement';
import type {
  ActivitySpec,
  Catalog,
  Direction,
  EvidenceEvent,
  Feedback,
  InteractionEvent,
  Item,
  ItemSkillState,
  Skill,
} from './types';

export type Outcome = 'correct' | 'wrong' | 'dont_know' | 'skip' | 'self_corrected';

export interface ActivityRecord {
  id: string;
  sessionId: string;
  index: number;
  spec: ActivitySpec;
  startedAt: string;
  attempts: number;
  answers: string[];
  nudged: boolean;
  outcome: Outcome | null;
  completed: boolean;
  completedAt: string | null;
  evidence: EvidenceEvent[];
  statusBefore: ItemSkillState['status'] | null;
}

export interface SessionRecord {
  id: string;
  startedAt: string;
  minutes: number;
  completed: boolean;
  activityIds: string[];
}

export interface ReplayHints {
  disputed: Set<string>;
  flagged: Set<string>;
  lastAnswer: Map<string, string>;
}

export function scanHints(events: InteractionEvent[]): ReplayHints {
  const hints: ReplayHints = { disputed: new Set(), flagged: new Set(), lastAnswer: new Map() };
  for (const e of events) {
    if (e.kind === 'dispute') hints.disputed.add(e.activityId);
    if (e.kind === 'flag') hints.flagged.add(e.activityId);
    if (e.kind === 'answer') hints.lastAnswer.set(e.activityId, e.id);
  }
  return hints;
}

const key = (itemId: string, skill: Skill) => `${itemId}|${skill}`;

/**
 * Learner state as a fold over the interaction log. The same `apply` runs for
 * live events and for replay, so state always equals derive(log, config).
 */
export class LearnerModel {
  readonly states = new Map<string, ItemSkillState>();
  readonly activities = new Map<string, ActivityRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly lastExposure = new Map<string, string>();
  readonly firstOutcome = new Map<string, boolean>();
  readonly reviewOutcomes: { at: string; correct: boolean }[] = [];
  readonly evidence: EvidenceEvent[] = [];
  utcOffsetMinutes = 0;
  lastSeq = 0;
  private placementCache: Map<string, ClusterPlacement> | null = null;

  constructor(
    readonly catalog: Catalog,
    readonly config: EngineConfig,
    private readonly scheduler: Scheduler,
    private readonly hints: ReplayHints,
  ) {}

  item(id: string): Item | undefined {
    return this.catalog.item(id);
  }

  state(itemId: string, skill: Skill): ItemSkillState {
    const s = this.states.get(key(itemId, skill));
    if (s) return s;
    const empty = emptyState(itemId, skill);
    empty.pKnown = this.prior(itemId);
    return empty;
  }

  prior(itemId: string): number {
    const item = this.catalog.item(itemId);
    return priorFor(item ? this.placement().get(item.cluster) : undefined, this.config);
  }

  pKnown(itemId: string, skill: Skill): number {
    return pKnownOf(this.state(itemId, skill), this.prior(itemId), this.config);
  }

  placement(): Map<string, ClusterPlacement> {
    if (!this.placementCache) {
      const byCluster = new Map<string, boolean[]>();
      for (const [itemId, ok] of this.firstOutcome) {
        const c = this.catalog.item(itemId)?.cluster;
        if (!c) continue;
        byCluster.set(c, [...(byCluster.get(c) ?? []), ok]);
      }
      this.placementCache = computePlacement(this.catalog.clusters(), byCluster, this.config);
    }
    return this.placementCache;
  }

  dayOf(at: Date): string {
    return new Date(at.getTime() + this.utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
  }

  apply(e: InteractionEvent): Feedback {
    this.lastSeq = Math.max(this.lastSeq, e.seq);
    switch (e.kind) {
      case 'session_started':
        this.utcOffsetMinutes = e.utcOffsetMinutes;
        this.sessions.set(e.sessionId, {
          id: e.sessionId,
          startedAt: e.at,
          minutes: e.minutes,
          completed: false,
          activityIds: [],
        });
        return { kind: 'none' };
      case 'session_completed': {
        const s = this.sessions.get(e.sessionId);
        if (s) s.completed = true;
        return { kind: 'none' };
      }
      case 'activity_started':
        return this.onActivityStarted(e);
      case 'activity_completed': {
        const a = this.activities.get(e.activityId);
        if (a) {
          a.completed = true;
          a.completedAt = e.at;
        }
        return { kind: 'none' };
      }
      case 'answer':
      case 'dont_know':
      case 'choice':
        return this.onAttempt(e);
      case 'skip': {
        const a = this.activities.get(e.activityId);
        if (a && !a.outcome) a.outcome = 'skip';
        return { kind: 'none' };
      }
      case 'override':
        this.onOverride(e);
        return { kind: 'none' };
      case 'dispute':
      case 'flag':
        return { kind: 'none' };
    }
  }

  private onActivityStarted(e: Extract<InteractionEvent, { kind: 'activity_started' }>): Feedback {
    const session = this.sessions.get(e.sessionId);
    const index = session?.activityIds.length ?? 0;
    session?.activityIds.push(e.activityId);
    const spec = e.spec;
    const skill = typeOf(spec).skillOf(spec);
    this.activities.set(e.activityId, {
      id: e.activityId,
      sessionId: e.sessionId,
      index,
      spec,
      startedAt: e.at,
      attempts: 0,
      answers: [],
      nudged: false,
      outcome: null,
      completed: false,
      completedAt: null,
      evidence: [],
      statusBefore: skill ? this.state(spec.itemId, skill).status : null,
    });
    if (spec.type === 'introduce') {
      const item = this.catalog.item(spec.itemId);
      for (const skill of item?.skills ?? []) {
        const s = this.state(spec.itemId, skill);
        if (s.status === 'unseen') this.states.set(key(spec.itemId, skill), { ...s, status: 'introduced' });
      }
      this.lastExposure.set(spec.itemId, e.at);
    }
    return { kind: 'none' };
  }

  private onAttempt(e: AttemptEvent): Feedback {
    const a = this.activities.get(e.activityId);
    const type = a && typeOf(a.spec);
    if (!a || !type?.respond) return { kind: 'none' };
    return type.respond(e, a, this.gradeContext(a, e));
  }

  /** The only door a code-graded activity has into the model: evidence helpers, no model port. */
  private gradeContext(a: ActivityRecord, e: AttemptEvent): GradeContext {
    return {
      config: this.config,
      item: (id) => this.catalog.item(id),
      state: (itemId, skill) => this.state(itemId, skill),
      disputed: this.hints.disputed.has(a.id) && this.hints.lastAnswer.get(a.id) === e.id,
      emit: (item, skill, direction, base, latencyMs, opts) =>
        this.emit(a, item, skill, direction, base, latencyMs, e.at, opts.fsrs, opts.context, opts.support ?? false),
      expose: (itemId) => this.expose(itemId, e.at),
      firstOutcome: (itemId, correct) => this.recordFirstOutcome(itemId, correct),
      reviewOutcome: (correct) => this.reviewOutcomes.push({ at: e.at, correct }),
    };
  }

  private onOverride(e: Extract<InteractionEvent, { kind: 'override' }>) {
    const item = this.catalog.item(e.itemId);
    if (!item) return;
    const at = new Date(e.at);
    const confirmDueAt = new Date(at.getTime() + this.config.planner.confirmAfterDays * 86_400_000).toISOString();
    for (const skill of item.skills) {
      const ev: EvidenceEvent = {
        interactionId: e.id,
        itemId: item.id,
        skill,
        direction: 'positive',
        strength: this.config.strengths.override,
        baseStrength: this.config.strengths.override,
        context: 'override',
        rulesVersion: this.config.rulesVersion,
        fsrsGrade: 'good',
      };
      this.applyOne(ev, at, true);
      const s = this.state(item.id, skill);
      this.states.set(key(item.id, skill), { ...s, confirmDueAt, status: s.status === 'known' ? 'learning' : s.status });
    }
  }

  private recordFirstOutcome(itemId: string, correct: boolean) {
    if (this.firstOutcome.has(itemId) || this.lastExposure.has(itemId)) return;
    this.firstOutcome.set(itemId, correct);
    this.placementCache = null;
  }

  private expose(itemId: string, at: string) {
    this.lastExposure.set(itemId, at);
  }

  private emit(
    a: ActivityRecord,
    item: Item,
    skill: Skill,
    direction: Direction,
    base: number,
    latencyMs: number,
    atIso: string,
    fsrsOverride: EvidenceEvent['fsrsGrade'] | undefined,
    contextKey: string,
    support: boolean,
  ) {
    if (this.hints.flagged.has(a.id)) return;
    const m = this.config.modifiers;
    const at = new Date(atIso);
    let strength = base;
    let slow = false;
    if (direction === 'positive') {
      if (support) strength *= m.supportDiscount;
      const seen = this.lastExposure.get(item.id);
      if (seen && at.getTime() - new Date(seen).getTime() < m.recentExposureMinutes * 60_000) {
        strength *= m.recentExposureDiscount;
      }
      const fast = skill === 'write' || skill === 'speak' ? m.fastMs.write : m.fastMs.read;
      if (latencyMs > 0 && latencyMs < fast) strength *= m.fastBonus;
      if (latencyMs > m.slowMs) {
        strength *= m.slowPenalty;
        slow = true;
      }
    }
    strength = Math.min(1, strength);
    const fsrsGrade =
      fsrsOverride !== undefined ? fsrsOverride : direction === 'negative' ? 'again' : slow ? 'hard' : 'good';
    const ev: EvidenceEvent = {
      interactionId: a.id,
      itemId: item.id,
      skill,
      direction,
      strength,
      baseStrength: base,
      context: `${contextKey}:${this.dayOf(at)}`,
      rulesVersion: this.config.rulesVersion,
      fsrsGrade,
    };
    a.evidence.push(ev);
    this.applyOne(ev, at, true);

    if ((skill === 'write' || skill === 'speak') && direction === 'positive' && item.skills.includes('read')) {
      const cross: EvidenceEvent = {
        ...ev,
        skill: 'read',
        strength: strength * m.productionToRecognition,
        fsrsGrade: null,
      };
      a.evidence.push(cross);
      this.applyOne(cross, at, false);
    }
  }

  private applyOne(ev: EvidenceEvent, at: Date, direct: boolean) {
    const prev = this.state(ev.itemId, ev.skill);
    const next = applyEvidence(
      prev,
      ev,
      { at, day: this.dayOf(at), prior: this.prior(ev.itemId), direct },
      this.scheduler,
      this.config,
    );
    this.states.set(key(ev.itemId, ev.skill), next);
    this.evidence.push(ev);
  }

  /** Words Known or Maintained for recognition: the vocabulary size that sets the stage. */
  knownWords(): number {
    let n = 0;
    for (const s of this.states.values()) {
      if (s.skill === 'read' && (s.status === 'known' || s.status === 'maintained') && this.catalog.item(s.itemId)?.type === 'vocab') n++;
    }
    return n;
  }

  trailingRetention(now: Date, days = 7): { rate: number; n: number } {
    const since = now.getTime() - days * 86_400_000;
    const recent = this.reviewOutcomes.filter((o) => new Date(o.at).getTime() >= since);
    if (recent.length === 0) return { rate: 1, n: 0 };
    return { rate: recent.filter((o) => o.correct).length / recent.length, n: recent.length };
  }
}

export function derive(
  events: InteractionEvent[],
  catalog: Catalog,
  config: EngineConfig,
  scheduler: Scheduler,
): LearnerModel {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const model = new LearnerModel(catalog, config, scheduler, scanHints(sorted));
  for (const e of sorted) model.apply(e);
  return model;
}
