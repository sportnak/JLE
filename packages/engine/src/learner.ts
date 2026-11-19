import type { EngineConfig } from './config';
import { grade } from './grading';
import { applyEvidence, emptyState, pKnownOf, type Scheduler } from './model';
import { computePlacement, priorFor, type ClusterPlacement } from './placement';
import {
  CUE_SKILL,
  type ActivitySpec,
  type Catalog,
  type Direction,
  type EvidenceEvent,
  type Feedback,
  type InteractionEvent,
  type Item,
  type ItemSkillState,
  type Skill,
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
  readonly items: Map<string, Item>;
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
  ) {
    this.items = new Map(catalog.items.map((i) => [i.id, i]));
  }

  state(itemId: string, skill: Skill): ItemSkillState {
    const s = this.states.get(key(itemId, skill));
    if (s) return s;
    const empty = emptyState(itemId, skill);
    empty.pKnown = this.prior(itemId);
    return empty;
  }

  prior(itemId: string): number {
    const item = this.items.get(itemId);
    return priorFor(item ? this.placement().get(item.cluster) : undefined, this.config);
  }

  pKnown(itemId: string, skill: Skill): number {
    return pKnownOf(this.state(itemId, skill), this.prior(itemId), this.config);
  }

  placement(): Map<string, ClusterPlacement> {
    if (!this.placementCache) {
      const byCluster = new Map<string, boolean[]>();
      for (const [itemId, ok] of this.firstOutcome) {
        const c = this.items.get(itemId)?.cluster;
        if (!c) continue;
        byCluster.set(c, [...(byCluster.get(c) ?? []), ok]);
      }
      this.placementCache = computePlacement(this.catalog.clusters, byCluster, this.config);
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
        return this.onAnswer(e);
      case 'dont_know':
        return this.onDontKnow(e);
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
    const skill = spec.type === 'retrieval' ? CUE_SKILL[spec.cue] : null;
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
      const item = this.items.get(spec.itemId);
      for (const skill of item?.skills ?? []) {
        const s = this.state(spec.itemId, skill);
        if (s.status === 'unseen') this.states.set(key(spec.itemId, skill), { ...s, status: 'introduced' });
      }
      this.lastExposure.set(spec.itemId, e.at);
    }
    return { kind: 'none' };
  }

  private onAnswer(e: Extract<InteractionEvent, { kind: 'answer' }>): Feedback {
    const a = this.activities.get(e.activityId);
    if (!a || a.spec.type !== 'retrieval') return { kind: 'none' };
    const spec = a.spec;
    const item = this.items.get(spec.itemId);
    if (!item) return { kind: 'none' };
    const skill = CUE_SKILL[spec.cue];
    const production = skill === 'write' || skill === 'speak';
    const g = grade(item, spec.cue, e.text);
    const disputed = this.hints.disputed.has(a.id) && this.hints.lastAnswer.get(a.id) === e.id;
    const correct = g.correct || disputed;
    a.attempts += 1;
    a.answers.push(e.text);

    if (a.nudged) {
      if (correct) {
        this.emit(a, item, skill, 'positive', this.config.strengths.selfCorrect, e.latencyMs, e.at, null);
        a.outcome = 'self_corrected';
        this.expose(item.id, e.at);
        return { kind: 'correct', expected: g.expected, note: 'Fixed it.' };
      }
      this.expose(item.id, e.at);
      return { kind: 'incorrect', expected: g.expected, note: g.note, canDispute: true };
    }

    this.recordFirstOutcome(item.id, correct);
    if (spec.purpose === 'review') this.reviewOutcomes.push({ at: e.at, correct });

    if (correct) {
      const base = production
        ? this.config.strengths.promptedProductionCorrect
        : this.config.strengths.recognitionAnswer;
      this.emit(a, item, skill, 'positive', base, e.latencyMs, e.at, undefined);
      a.outcome = 'correct';
      this.expose(item.id, e.at);
      return { kind: 'correct', expected: g.expected, note: g.note };
    }

    const known = ['known', 'maintained'].includes(this.state(item.id, skill).status);
    const base = production ? this.config.strengths.productionWrong : this.config.strengths.recognitionAnswer;
    this.emit(a, item, skill, 'negative', base, e.latencyMs, e.at, undefined);
    a.outcome = 'wrong';
    if (known && production) {
      a.nudged = true;
      return { kind: 'retry', message: 'You know this one. Have another look.' };
    }
    this.expose(item.id, e.at);
    return { kind: 'incorrect', expected: g.expected, note: g.note, canDispute: true };
  }

  private onDontKnow(e: Extract<InteractionEvent, { kind: 'dont_know' }>): Feedback {
    const a = this.activities.get(e.activityId);
    if (!a || a.spec.type !== 'retrieval') return { kind: 'none' };
    const item = this.items.get(a.spec.itemId);
    if (!item) return { kind: 'none' };
    const expected = grade(item, a.spec.cue, '').expected;
    if (!a.nudged) {
      const skill = CUE_SKILL[a.spec.cue];
      this.recordFirstOutcome(item.id, false);
      if (a.spec.purpose === 'review') this.reviewOutcomes.push({ at: e.at, correct: false });
      this.emit(a, item, skill, 'negative', this.config.strengths.dontKnow, e.latencyMs, e.at, undefined);
      a.outcome = 'dont_know';
    }
    this.expose(item.id, e.at);
    return { kind: 'revealed', expected };
  }

  private onOverride(e: Extract<InteractionEvent, { kind: 'override' }>) {
    const item = this.items.get(e.itemId);
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
  ) {
    if (this.hints.flagged.has(a.id) || a.spec.type !== 'retrieval') return;
    const m = this.config.modifiers;
    const at = new Date(atIso);
    let strength = base;
    let slow = false;
    if (direction === 'positive') {
      if (a.spec.showFurigana && a.spec.cue === 'ja_to_en' && item.written !== item.reading) {
        strength *= m.supportDiscount;
      }
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
      context: `${a.spec.cue}:${this.dayOf(at)}`,
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
