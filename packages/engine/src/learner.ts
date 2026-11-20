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
  StoredContent,
} from './types';

/** `read` is a finished passage: not an answer, so it never counts as right or wrong. */
export type Outcome = 'correct' | 'wrong' | 'dont_know' | 'skip' | 'self_corrected' | 'read';

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
  /** Stored content by id: passages to read. */
  readonly contents = new Map<string, StoredContent>();
  /** Words looked up while reading and not yet taught, with when they were first looked up. */
  readonly wanted = new Map<string, string>();
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

  /** Adds stored content and the items its token map points at. Content is a stored output, never rewritten. */
  addContent(c: StoredContent) {
    if (this.contents.has(c.id)) return;
    this.catalog.extend(c.items);
    this.contents.set(c.id, c);
  }

  /** Content not yet read in any activity, oldest first. */
  unreadContent(): StoredContent[] {
    const read = new Set([...this.activities.values()].flatMap((a) => (a.spec.type === 'reading' ? [a.spec.contentId] : [])));
    return [...this.contents.values()].filter((c) => !read.has(c.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

  apply(raw: InteractionEvent): Feedback {
    const e = canonical(raw, this.catalog);
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
      case 'lookup':
        this.onLookup(e);
        return { kind: 'none' };
      case 'reading_done':
        this.onReadingDone(e);
        return { kind: 'none' };
    }
  }

  /** A lookup while reading: a weak recognition miss, and the word joins the words wanted for teaching. */
  private onLookup(e: Extract<InteractionEvent, { kind: 'lookup' }>) {
    const a = this.activities.get(e.activityId);
    const item = this.catalog.item(e.itemId);
    if (!a || a.spec.type !== 'reading' || !item || a.outcome || this.hints.flagged.has(a.id)) return;
    if (a.evidence.some((ev) => ev.itemId === item.id)) return;
    const s = this.state(item.id, 'read');
    // A lookup on a word with a review card is a lapse; on any other word it only lowers p_known.
    this.emit(a, item, 'read', 'negative', this.config.strengths.lookup, 0, e.at, s.card ? 'again' : null, 'reading', false);
    // Looking a word up is not meeting it: a never-met word stays Unseen, so it is not counted as met afterwards.
    if (s.status === 'unseen') this.states.set(key(item.id, 'read'), { ...this.state(item.id, 'read'), status: 'unseen' });
    this.expose(item.id, e.at);
    if (!this.wanted.has(item.id) && !item.skills.some((k) => this.state(item.id, k).card)) this.wanted.set(item.id, e.at);
  }

  /**
   * Finishing a passage: every tracked word not looked up that the learner had already met counts as weakly read.
   * A word never met says nothing either way, so it gets no evidence.
   */
  private onReadingDone(e: Extract<InteractionEvent, { kind: 'reading_done' }>) {
    const a = this.activities.get(e.activityId);
    if (!a || a.spec.type !== 'reading' || a.outcome || this.hints.flagged.has(a.id)) return;
    const content = this.contents.get(a.spec.contentId);
    a.outcome = 'read';
    if (!content) return;
    const looked = new Set(a.evidence.map((ev) => ev.itemId));
    const ids = [...new Set(content.tokens.flatMap((t) => (t.itemId ? [this.catalog.resolve(t.itemId)] : [])))];
    for (const id of ids) {
      const item = this.catalog.item(id);
      if (!item || looked.has(id)) continue;
      if (this.state(id, 'read').status === 'unseen') continue;
      this.emit(a, item, 'read', 'positive', this.config.strengths.readPast, 0, e.at, null, 'reading', false);
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

/** The event with retired item ids replaced by current ones. The log itself is never rewritten. */
export function canonical(e: InteractionEvent, catalog: Catalog): InteractionEvent {
  if (e.kind === 'override' || e.kind === 'lookup') {
    const itemId = catalog.resolve(e.itemId);
    return itemId === e.itemId ? e : { ...e, itemId };
  }
  if (e.kind !== 'activity_started') return e;
  const spec = e.spec;
  const itemId = catalog.resolve(spec.itemId);
  if (spec.type === 'dictation') {
    const segments = spec.segments.map((g) => {
      const id = g.itemId && catalog.resolve(g.itemId);
      return id && id !== g.itemId ? { ...g, itemId: id } : g;
    });
    const same = itemId === spec.itemId && segments.every((g, i) => g === spec.segments[i]);
    return same ? e : { ...e, spec: { ...spec, itemId, segments } };
  }
  return itemId === spec.itemId ? e : { ...e, spec: { ...spec, itemId } };
}

export function derive(
  events: InteractionEvent[],
  catalog: Catalog,
  config: EngineConfig,
  scheduler: Scheduler,
  contents: StoredContent[] = [],
): LearnerModel {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const model = new LearnerModel(catalog, config, scheduler, scanHints(sorted));
  for (const c of contents) model.addContent(c);
  for (const e of sorted) model.apply(e);
  return model;
}
