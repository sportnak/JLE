import { DEFAULT_CONFIG, type EngineConfig } from './config';
import { derive, type LearnerModel, type Outcome } from './learner';
import { createScheduler, type Scheduler } from './model';
import { typeOf } from './activities';
import { currentStage, frontierItems, planCandidates, strandMinutesSince } from './planner';
import { asHiragana, grade } from './grading';
import { randomIds, systemClock, type Clock, type EventStore, type Ids, type Llm } from './ports';
import type {
  ActivitySpec,
  Catalog,
  Feedback,
  InteractionEvent,
  Item,
  ItemType,
  NewInteraction,
  Skill,
  Stage,
  Status,
  Strand,
} from './types';

export interface EngineOptions {
  catalog: Catalog;
  store: EventStore;
  learnerId: string;
  language?: string;
  config?: EngineConfig;
  clock?: Clock;
  ids?: Ids;
  utcOffsetMinutes?: number;
  /** For model-graded activities, when they arrive. Code-graded activities never receive it. */
  llm?: Llm;
}

export interface ActivityView {
  activityId: string;
  spec: ActivitySpec;
  item: Item;
  reason: string;
}

export type NextActivity = { done: false; activity: ActivityView } | { done: true; recap: SessionRecap };

export type LearnerInput =
  | { kind: 'answer'; text: string; latencyMs: number }
  | { kind: 'dont_know'; latencyMs: number }
  | { kind: 'choice'; choice: string; latencyMs: number }
  | { kind: 'skip' }
  | { kind: 'dispute' };

export interface ActivityRecap {
  itemId: string;
  outcome: Outcome | null;
  statusBefore: Status | null;
  statusAfter: Status | null;
}

export interface SessionRecap {
  sessionId: string;
  activities: number;
  newItems: string[];
  missed: string[];
  becameKnown: string[];
  corrections: { itemId: string; type: ActivitySpec['type']; given: string | null; expected: string }[];
  changes: { itemId: string; skill: Skill; from: Status; to: Status }[];
}

export interface SessionClock {
  minutes: number;
  /** Real time since the session started. */
  realMs: number;
  /** Time saved by finishing prompts faster than expected. */
  creditMs: number;
  /** Real time plus credit: what the session timer shows. */
  elapsedMs: number;
  remainingMs: number;
}

export interface ItemRow {
  item: Item;
  skill: Skill;
  status: Status;
  pKnown: number;
  dueAt: string | null;
  lapses: number;
}

export interface StateSummary {
  /** Item-skill rows by status. Only met items have state, so Unseen is the remainder. */
  counts: Record<Status, number>;
  placement: { cluster: string; track: string; label: string; placement: string; inferred: boolean }[];
  retention: { rate: number; n: number };
}

export class Engine {
  private model!: LearnerModel;
  private events: InteractionEvent[] = [];
  private readonly config: EngineConfig;
  private readonly clock: Clock;
  private readonly ids: Ids;
  private readonly language: string;

  private constructor(
    private readonly opts: EngineOptions,
    private readonly scheduler: Scheduler,
  ) {
    this.config = opts.config ?? DEFAULT_CONFIG;
    this.clock = opts.clock ?? systemClock;
    this.ids = opts.ids ?? randomIds;
    this.language = opts.language ?? 'ja';
  }

  static async create(opts: EngineOptions): Promise<Engine> {
    const engine = new Engine(opts, await createScheduler(opts.config ?? DEFAULT_CONFIG));
    engine.events = await opts.store.load(opts.learnerId);
    engine.rebuild();
    return engine;
  }

  /** Recomputes all learner state from the event log. */
  rebuild() {
    this.model = derive(this.events, this.opts.catalog, this.config, this.scheduler);
  }

  get learner(): LearnerModel {
    return this.model;
  }

  get log(): readonly InteractionEvent[] {
    return this.events;
  }

  private async append(partial: NewInteraction): Promise<Feedback> {
    const event = {
      ...partial,
      id: this.ids.next(),
      seq: this.model.lastSeq + 1,
      at: this.clock.now().toISOString(),
      learnerId: this.opts.learnerId,
      language: this.language,
    } as InteractionEvent;
    await this.opts.store.append(event);
    this.events.push(event);
    if (event.kind === 'dispute' || event.kind === 'flag') {
      this.rebuild();
      return { kind: 'none' };
    }
    return this.model.apply(event);
  }

  async startSession(minutes: number): Promise<{ sessionId: string; next: NextActivity }> {
    const sessionId = this.ids.next();
    const utcOffsetMinutes = this.opts.utcOffsetMinutes ?? -new Date().getTimezoneOffset();
    await this.append({ kind: 'session_started', sessionId, minutes, utcOffsetMinutes });
    return { sessionId, next: await this.nextActivity(sessionId) };
  }

  /** Expected seconds for an activity, from its type: a base plus a little per character. */
  expectedSeconds(spec: ActivitySpec): number {
    return typeOf(spec).expectedSeconds(spec, this.model.item(spec.itemId), this.config);
  }

  /** The stage, from words Known for recognition. */
  stage(): Stage {
    return currentStage(this.model);
  }

  /**
   * The session timer. It runs in real time, and each finished prompt that took less than its expected
   * time moves it forward by the difference, so a quick session ends sooner. Derived from the log.
   */
  sessionClock(sessionId: string): SessionClock {
    const session = this.model.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const realMs = Math.max(0, this.clock.now().getTime() - new Date(session.startedAt).getTime());
    let creditMs = 0;
    for (const id of session.activityIds) {
      const a = this.model.activities.get(id);
      if (!a?.completedAt) continue;
      const took = new Date(a.completedAt).getTime() - new Date(a.startedAt).getTime();
      creditMs += Math.max(0, this.expectedSeconds(a.spec) * 1000 - took);
    }
    const totalMs = session.minutes * 60_000;
    const elapsedMs = Math.min(totalMs, realMs + creditMs);
    return { minutes: session.minutes, realMs, creditMs, elapsedMs, remainingMs: totalMs - elapsedMs };
  }

  async nextActivity(sessionId: string): Promise<NextActivity> {
    const session = this.model.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session ${sessionId}`);
    const now = this.clock.now();
    const timeLeft = this.sessionClock(sessionId).remainingMs > 0;
    const best = timeLeft ? planCandidates(this.model, sessionId, now, this.scheduler)[0] : undefined;
    if (!best) return { done: true, recap: await this.completeSession(sessionId) };
    const activityId = this.ids.next();
    await this.append({ kind: 'activity_started', sessionId, activityId, spec: best.spec });
    return { done: false, activity: this.view(activityId, best.reason) };
  }

  /** Starts an activity with a given spec instead of the planner's choice. For the demo page; graded like any other. */
  async startActivity(sessionId: string, spec: ActivitySpec, reason = ''): Promise<ActivityView> {
    if (!this.model.sessions.has(sessionId)) throw new Error(`Unknown session ${sessionId}`);
    if (!this.model.item(spec.itemId)) throw new Error(`Unknown item ${spec.itemId}`);
    const activityId = this.ids.next();
    await this.append({ kind: 'activity_started', sessionId, activityId, spec });
    return this.view(activityId, reason);
  }

  view(activityId: string, reason = ''): ActivityView {
    const a = this.model.activities.get(activityId);
    if (!a) throw new Error(`Unknown activity ${activityId}`);
    const item = this.model.item(a.spec.itemId);
    if (!item) throw new Error(`Unknown item ${a.spec.itemId}`);
    return { activityId, spec: a.spec, item, reason };
  }

  async recordInteraction(activityId: string, input: LearnerInput): Promise<Feedback> {
    const a = this.model.activities.get(activityId);
    if (!a) throw new Error(`Unknown activity ${activityId}`);
    switch (input.kind) {
      case 'answer':
        return this.append({ kind: 'answer', activityId, text: input.text, latencyMs: input.latencyMs, attempt: a.attempts + 1 });
      case 'dont_know':
        return this.append({ kind: 'dont_know', activityId, latencyMs: input.latencyMs });
      case 'choice':
        return this.append({ kind: 'choice', activityId, choice: input.choice, latencyMs: input.latencyMs });
      case 'skip':
        return this.append({ kind: 'skip', activityId });
      case 'dispute':
        await this.append({ kind: 'dispute', activityId });
        return { kind: 'correct', expected: '', note: 'Counted as correct.' };
    }
  }

  async completeActivity(activityId: string): Promise<ActivityRecap> {
    await this.append({ kind: 'activity_completed', activityId });
    const a = this.model.activities.get(activityId)!;
    const skill = a.evidence[0]?.skill;
    return {
      itemId: a.spec.itemId,
      outcome: a.outcome,
      statusBefore: a.statusBefore,
      statusAfter: skill ? this.model.state(a.spec.itemId, skill).status : null,
    };
  }

  private async completeSession(sessionId: string): Promise<SessionRecap> {
    const session = this.model.sessions.get(sessionId)!;
    if (!session.completed) await this.append({ kind: 'session_completed', sessionId });
    const acts = session.activityIds.map((id) => this.model.activities.get(id)!).filter(Boolean);
    const unique = (xs: string[]) => [...new Set(xs)];
    const missedActs = acts.filter(
      (a) =>
        a.outcome === 'wrong' ||
        a.outcome === 'dont_know' ||
        (a.spec.type === 'dictation' && a.evidence.some((e) => e.direction === 'negative')),
    );
    const firstBefore = new Map<string, Status>();
    for (const a of acts) {
      for (const ev of a.evidence) {
        const key = `${ev.itemId}|${ev.skill}`;
        if (!firstBefore.has(key) && a.statusBefore && ev.itemId === a.spec.itemId && ev.skill === a.evidence[0]?.skill) {
          firstBefore.set(key, a.statusBefore);
        }
      }
    }
    const changes = [...firstBefore.entries()]
      .map(([key, from]) => {
        const [itemId, skill] = key.split('|') as [string, Skill];
        return { itemId, skill, from, to: this.model.state(itemId, skill).status };
      })
      .filter((c) => c.from !== c.to);
    const seenCorrection = new Set<string>();
    const corrections = missedActs
      .filter((a) => !seenCorrection.has(a.spec.itemId) && seenCorrection.add(a.spec.itemId))
      .map((a) => {
        const item = this.model.item(a.spec.itemId)!;
        const raw = a.answers[0] ?? null;
        const type = a.spec.type;
        if (a.spec.type === 'minimal_pair') return { itemId: item.id, type, given: raw, expected: a.spec.answer };
        if (a.spec.type === 'dictation') {
          return { itemId: item.id, type, given: raw, expected: a.spec.segments.map((g) => g.text).join('') };
        }
        const cue = a.spec.type === 'retrieval' ? a.spec.cue : 'en_to_ja';
        const given = raw !== null && cue === 'kana_to_reading' ? asHiragana(raw) : raw;
        return { itemId: item.id, type, given, expected: grade(item, cue, '').expected };
      });
    return {
      sessionId,
      activities: acts.filter((a) => a.spec.type !== 'introduce').length,
      newItems: unique(
        acts
          .filter((a) => a.spec.type === 'introduce' || (a.statusBefore === 'unseen' && a.spec.purpose !== 'first_listen'))
          .map((a) => a.spec.itemId),
      ),
      missed: unique(
        missedActs.flatMap((a) =>
          a.spec.type === 'dictation' ? a.evidence.filter((e) => e.direction === 'negative').map((e) => e.itemId) : [a.spec.itemId],
        ),
      ),
      becameKnown: unique(changes.filter((c) => c.to === 'known' || c.to === 'maintained').map((c) => c.itemId)),
      corrections,
      changes,
    };
  }

  async ask(_question: string): Promise<{ available: false; reason: string }> {
    return { available: false, reason: 'The tutor arrives in build step 3.' };
  }

  async overrideItem(itemId: string): Promise<void> {
    await this.append({ kind: 'override', itemId, claim: 'known' });
  }

  async flagContent(activityId: string, reason: string): Promise<void> {
    await this.append({ kind: 'flag', activityId, reason });
  }

  /** Groups a session started now would draw on. No counts: due items are met inside the session, not listed. */
  previewMix(limit = 8): string[] {
    const labels = new Map(this.opts.catalog.clusters().map((c) => [c.id, c.label]));
    const picks = planCandidates(this.model, '__preview__', this.clock.now(), this.scheduler).slice(0, limit);
    const groups = picks.map((c) => labels.get(this.model.item(c.spec.itemId)?.cluster ?? ''));
    return [...new Set(groups.filter((g): g is string => !!g))];
  }

  /** Items Known now that were not Known at `since`, by item type. Computed by replaying the log up to `since`. */
  knownAddedSince(since: Date): Partial<Record<ItemType, number>> {
    const before = derive(
      this.events.filter((e) => new Date(e.at) < since),
      this.opts.catalog,
      this.config,
      this.scheduler,
    );
    const isKnown = (m: LearnerModel, item: Item) =>
      item.skills.some((s) => ['known', 'maintained'].includes(m.state(item.id, s).status));
    const added: Partial<Record<ItemType, number>> = {};
    for (const item of seenItems(this.model)) {
      if (isKnown(this.model, item) && !isKnown(before, item)) added[item.type] = (added[item.type] ?? 0) + 1;
    }
    return added;
  }

  /** Minutes per strand since a date, each activity counted under its type's strand. */
  strandMinutes(since: Date): Record<Strand, number> {
    return strandMinutesSince(this.model, since);
  }

  /** The next new items the planner would reach for. */
  comingUp(n = 3): Item[] {
    return frontierItems(this.model, new Set()).slice(0, n);
  }

  /** Every item-skill row of one cluster, for the progress table. */
  clusterRows(clusterId: string): ItemRow[] {
    return this.opts.catalog.inCluster(clusterId).flatMap((item) =>
      item.skills.map((skill) => {
        const s = this.model.state(item.id, skill);
        return {
          item,
          skill,
          status: s.status,
          pKnown: this.model.pKnown(item.id, skill),
          dueAt: s.card ? new Date(s.card.dueAt).toISOString() : null,
          lapses: s.lapses,
        };
      }),
    );
  }

  getLearnerState(): StateSummary {
    const counts: Record<Status, number> = { unseen: 0, introduced: 0, learning: 0, known: 0, maintained: 0, leech: 0 };
    let total = 0;
    for (const c of this.opts.catalog.clusters()) for (const item of this.opts.catalog.inCluster(c.id)) total += item.skills.length;
    let met = 0;
    for (const s of this.model.states.values()) {
      counts[s.status] += 1;
      met += 1;
    }
    counts.unseen += Math.max(0, total - met);
    const placement = [...this.model.placement().values()].map((p) => ({
      cluster: p.cluster.id,
      track: p.cluster.track,
      label: p.cluster.label,
      placement: p.placement,
      inferred: p.inferred,
    }));
    return { counts, placement, retention: this.model.trailingRetention(this.clock.now()) };
  }
}

/** Items the learner has any state for. Learner state is sparse, so this follows what has been met. */
function seenItems(model: LearnerModel): Item[] {
  const ids = new Set([...model.states.values()].map((s) => s.itemId));
  return [...ids].map((id) => model.item(id)).filter((i): i is Item => !!i);
}
