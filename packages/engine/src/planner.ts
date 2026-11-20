import { activityTypes, typeOf } from './activities';
import type { Candidate, Need, PlanContext } from './activities/types';
import { hash } from './activities/util';
import { retrievability, type Scheduler } from './model';
import type { ActivityRecord, LearnerModel } from './learner';
import { groupByTrack, nextProbeCluster } from './placement';
import { overClosedCap, stageFor, strandPull, STRANDS } from './stage';
import type { Item, Skill, Stage, Strand } from './types';

export type { Candidate, Need } from './activities/types';
export { cueFor } from './activities';

const primarySkill = (item: Item): Skill =>
  item.skills.includes('write') ? 'write' : item.skills.includes('read') ? 'read' : (item.skills[0] ?? 'read');

/** Per-item history within one session, in order. */
function sessionHistory(acts: ActivityRecord[]): Map<string, ActivityRecord[]> {
  const byItem = new Map<string, ActivityRecord[]>();
  for (const a of acts) byItem.set(a.spec.itemId, [...(byItem.get(a.spec.itemId) ?? []), a]);
  return byItem;
}

const attempt = (a: ActivityRecord) => a.spec.type !== 'introduce';
const missed = (a: ActivityRecord) => attempt(a) && (a.outcome === 'wrong' || a.outcome === 'dont_know');
const right = (a: ActivityRecord) => attempt(a) && (a.outcome === 'correct' || a.outcome === 'self_corrected');
const skillOf = (a: ActivityRecord) => typeOf(a.spec).skillOf(a.spec);

export function currentStage(model: LearnerModel): Stage {
  return stageFor(model.knownWords(), model.config);
}

/**
 * Scores every candidate activity and returns them best first. The planner never looks further
 * ahead than the next activity. Within a session an item comes back only for a reason: you missed it,
 * it is due, or it was just introduced and gets one later check. A correct answer means it rests.
 *
 * First the reasons (needs) are found; then each activity type in the registry offers activities for the
 * needs it can serve, plus any of its own; then strand balance, the closed-exercise cap and interleaving
 * adjust the scores.
 */
export function planCandidates(model: LearnerModel, sessionId: string, now: Date, scheduler: Scheduler): Candidate[] {
  const cfg = model.config.planner;
  const session = model.sessions.get(sessionId);
  const sessionActs = (session?.activityIds ?? [])
    .map((id) => model.activities.get(id))
    .filter((a): a is ActivityRecord => !!a);
  const recentItems = new Set(sessionActs.slice(-cfg.relearnGap).map((a) => a.spec.itemId));
  const history = sessionHistory(sessionActs);
  const metThisSession = new Set(history.keys());
  const needs: Need[] = [];
  const last = sessionActs.at(-1);
  const need = (item: Item, skill: Skill, purpose: Need['purpose'], score: number, reason: string, teach = false) =>
    needs.push({ item, skill, purpose, score, reason, teach });

  if (last?.spec.type === 'introduce') {
    const item = model.item(last.spec.itemId);
    if (item) need(item, primarySkill(item), 'practice', 1000, 'immediate use');
  }

  let frontier: Set<string> | undefined;
  for (const [itemId, acts] of history) {
    if (recentItems.has(itemId)) continue;
    const item = model.item(itemId);
    if (!item || !prerequisitesMet(model, item)) continue;
    // In the open-ended tracks (words, kanji) a placement probe beyond the frontier only places the learner: a
    // rare word is not taught for being missed. Kana and sound features are small closed sets, taught back as before.
    const openEnded = item.type === 'vocab' || item.type === 'kanji';
    if (openEnded && acts.every(placementOnly) && !(frontier ??= frontierClusters(model)).has(item.cluster)) continue;
    const lastMiss = acts.findLastIndex(missed);
    const lastIntro = acts.findLastIndex((a: ActivityRecord) => a.spec.type === 'introduce');
    const lastRight = acts.findLastIndex(right);
    const untaught = item.skills.every((sk) => !model.state(itemId, sk).card);
    const misses = acts.filter(missed).length;

    const intros = acts.filter((a) => a.spec.type === 'introduce').length;
    if (lastMiss >= 0 && lastMiss > lastRight && untaught && lastIntro < lastMiss && intros < cfg.maxRelearnPerSession) {
      need(item, primarySkill(item), 'practice', 90, 'missed, teach it', true);
    } else if (lastMiss >= 0 && lastMiss > lastRight && misses <= cfg.maxRelearnPerSession && !acts.slice(lastMiss + 1).some(attempt)) {
      // A practice attempt after the miss that was skipped closes the reason; it would otherwise come back forever.
      const skill = skillOf(acts[lastMiss]!);
      if (skill) need(item, skill, 'practice', 85, 'missed earlier this session');
    } else if (lastIntro >= 0) {
      const usesSinceIntro = acts.slice(lastIntro + 1).filter(attempt).length;
      const sinceLastSeen = sessionActs.length - 1 - sessionActs.lastIndexOf(acts.at(-1)!);
      if (usesSinceIntro === 1 && sinceLastSeen >= cfg.checkGap) {
        need(item, primarySkill(item), 'practice', 80, 'one more check');
      }
    }
  }

  for (const s of model.states.values()) {
    if (recentItems.has(s.itemId) || metThisSession.has(s.itemId) || s.status === 'unseen') continue;
    const item = model.item(s.itemId);
    if (!item) continue;
    if (s.confirmDueAt && new Date(s.confirmDueAt) <= now) {
      need(item, s.skill, 'confirm', 60, 'confirm "I know this"');
    } else if (s.card && new Date(s.card.dueAt) <= now) {
      const r = retrievability(scheduler, s.card, now);
      need(item, s.skill, 'review', 50 + (1 - r) * 40, 'due');
    }
  }

  const placementProbe = nextPlacementProbe(model, sessionId, metThisSession);
  if (placementProbe) need(placementProbe, primarySkill(placementProbe), 'placement', 70, 'placement');

  const newSoFar = sessionActs.filter(
    (a) => (a.spec.type === 'introduce' || a.spec.purpose === 'probe') && history.get(a.spec.itemId)![0] === a,
  ).length;
  if (newSoFar < sessionBudget(model, sessionActs, now, newSoFar)) {
    const teach = teachMode(sessionActs, cfg.teachModeDontKnows);
    frontierPicks(model, metThisSession).forEach((item, i) => {
      // Kana are shown before they are tried; sound features are always tried first.
      const probe = item.type === 'sound' || (!teach && model.prior(item.id) >= cfg.probeThreshold);
      need(item, primarySkill(item), 'probe', 30 - i, probe ? 'new, probably known' : 'new', !probe);
    });
  }

  const stage = currentStage(model);
  const ctx: PlanContext = { model, sessionId, now, scheduler, stage, needs, sessionActs, recentItems, metThisSession };
  const offered = activityTypes()
    .filter((t) => t.stages.includes(stage))
    .flatMap((t) => t.candidates(ctx));
  const ordered = mix(model, ctx, offered);
  return interleave(model, sessionActs, ordered)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ order: _order, ...c }) => c);
}

const placementOnly = (a: ActivityRecord) => a.spec.type !== 'introduce' && a.spec.purpose === 'placement';

type OrderedCandidate = Candidate & { order: number };

/** Strand balance over the trailing week, and from stage 2 the cap on closed exercises within the session. */
function mix(model: LearnerModel, ctx: PlanContext, candidates: OrderedCandidate[]): OrderedCandidate[] {
  let closedMs = 0;
  let totalMs = 0;
  const sessionMinutes = Object.fromEntries(STRANDS.map((s) => [s, 0])) as Record<Strand, number>;
  for (const a of ctx.sessionActs) {
    const ms = activityMs(a);
    totalMs += ms;
    sessionMinutes[typeOf(a.spec).strand] += ms / 60_000;
    if (typeOf(a.spec).closed) closedMs += ms;
  }
  const week = strandMinutesSince(model, new Date(ctx.now.getTime() - 7 * 86_400_000));
  const pull = strandPull(week, ctx.stage, model.config, sessionMinutes);
  const isOpen = (c: Candidate) => {
    const t = typeOf(c.spec);
    return !t.closed && t.strand !== 'study';
  };
  const capped = overClosedCap(closedMs, totalMs, ctx.stage, model.config) && candidates.some(isOpen);
  return candidates.map((c) => {
    const t = typeOf(c.spec);
    let score = c.score + pull[t.strand];
    if (capped && t.closed) score -= model.config.mix.closedPenalty;
    return { ...c, score };
  });
}

/** Time an activity took, capped so a prompt left open overnight does not count as hours of study. */
export function activityMs(a: ActivityRecord): number {
  if (!a.completedAt) return 0;
  return Math.max(0, Math.min(5 * 60_000, new Date(a.completedAt).getTime() - new Date(a.startedAt).getTime()));
}

export function strandMinutesSince(model: LearnerModel, since: Date): Record<Strand, number> {
  const minutes = Object.fromEntries(STRANDS.map((s) => [s, 0])) as Record<Strand, number>;
  for (const a of model.activities.values()) {
    if (new Date(a.startedAt) < since || !a.completedAt) continue;
    minutes[typeOf(a.spec).strand] += activityMs(a) / 60_000;
  }
  return minutes;
}

/**
 * New items allowed this session. Starts from the retention-based budget; while recent answers are
 * accurate there is always room for one more, and when they are mostly wrong intake stops.
 */
export function sessionBudget(model: LearnerModel, acts: ActivityRecord[], now: Date, newSoFar: number): number {
  const recent = acts
    .filter((a) => a.spec.type !== 'introduce' && a.spec.purpose !== 'placement' && a.outcome && a.outcome !== 'skip')
    .slice(-8);
  if (recent.length >= 5) {
    const accuracy = recent.filter(right).length / recent.length;
    if (accuracy >= 0.85) return newSoFar + 1;
    if (accuracy < 0.6) return 0;
  }
  return newItemBudget(model, now);
}

/**
 * A few new items from the first two groups of each track (kana, words), so interleaving has
 * something of another kind to mix in.
 */
function frontierPicks(model: LearnerModel, exclude: Set<string>): Item[] {
  const track = new Map(model.catalog.clusters().map((c) => [c.id, c.track]));
  const picks = new Map<string, Map<string, Item[]>>();
  for (const item of frontierItems(model, exclude)) {
    const t = track.get(item.cluster) ?? '';
    const groups = picks.get(t) ?? new Map<string, Item[]>();
    const list = groups.get(item.cluster) ?? [];
    if (list.length < 2 && (groups.has(item.cluster) || groups.size < 2)) {
      list.push(item);
      groups.set(item.cluster, list);
    }
    picks.set(t, groups);
  }
  const perTrack = [...picks.values()].map((groups) => [...groups.values()].flat());
  const merged: Item[] = [];
  for (let i = 0; perTrack.some((l) => i < l.length); i++) for (const l of perTrack) if (l[i]) merged.push(l[i]!);
  return merged.slice(0, 8);
}

/** True until basic hiragana is placed known or mostly learned. */
export function inKanaStage(model: LearnerModel): boolean {
  if (model.placement().get('hiragana-basic')?.placement === 'known') return false;
  const basics = model.catalog.inCluster('hiragana-basic');
  if (basics.length === 0) return false;
  const learned = basics.filter((i) => model.pKnown(i.id, 'read') >= model.config.planner.prerequisiteMin).length;
  return learned / basics.length < 0.8;
}

/**
 * No more than three of the same kind in a row: item type normally, kana group in the kana stage
 * (so hiragana and katakana groups mix). Over-the-limit candidates sink but stay available.
 */
function interleave<C extends Candidate>(model: LearnerModel, acts: ActivityRecord[], candidates: C[]): C[] {
  const kanaStage = inKanaStage(model);
  const kind = (itemId: string) => {
    const item = model.item(itemId);
    return kanaStage && item?.type === 'script' ? item.cluster : item?.type;
  };
  const lastThree = acts.slice(-3).map((a) => kind(a.spec.itemId));
  if (lastThree.length < 3 || new Set(lastThree).size !== 1) return candidates;
  const run = lastThree[0];
  return candidates.map((c) =>
    c.reason !== 'immediate use' && c.reason !== 'placement' && kind(c.spec.itemId) === run
      ? { ...c, score: c.score - 500 }
      : c,
  );
}

export function newItemBudget(model: LearnerModel, now: Date): number {
  const cfg = model.config.planner;
  const { rate, n } = model.trailingRetention(now);
  if (n < 10) return cfg.newItemsPerSession;
  if (rate < cfg.retentionLow) return Math.floor(cfg.newItemsPerSession / 2);
  if (rate > cfg.retentionHigh) return Math.ceil(cfg.newItemsPerSession * 1.5);
  return cfg.newItemsPerSession;
}

function teachMode(acts: ActivityRecord[], threshold: number): boolean {
  const probes = acts.filter((a) => a.spec.type !== 'introduce' && a.spec.purpose === 'probe').slice(-4);
  return probes.filter((a) => a.outcome === 'wrong' || a.outcome === 'dont_know').length >= threshold;
}

export function prerequisitesMet(model: LearnerModel, item: Item): boolean {
  const min = model.config.planner.prerequisiteMin;
  return model.catalog
    .edgesInto(item.id)
    .filter((e) => e.kind !== 'confusable')
    .every((e) => model.pKnown(e.from, 'read') >= min);
}

/**
 * Untaught items whose cluster and prerequisites are ready, in cluster order. Walks clusters in order and
 * stops each track after its first `clustersPerTrack` clusters with anything in them, so the cost follows
 * how far the learner has got rather than the catalog's size.
 */
export function frontierItems(model: LearnerModel, exclude: Set<string>, clustersPerTrack = 2): Item[] {
  return frontierWalk(model, exclude, clustersPerTrack).flatMap(([, items]) => items);
}

/** The clusters new items come from now, per track the first `clustersPerTrack` ready ones with untaught items. */
export function frontierClusters(model: LearnerModel, clustersPerTrack = 2): Set<string> {
  return new Set(frontierWalk(model, new Set(), clustersPerTrack).map(([id]) => id));
}

function frontierWalk(model: LearnerModel, exclude: Set<string>, clustersPerTrack: number): [string, Item[]][] {
  const out: [string, Item[]][] = [];
  const taken = new Map<string, number>();
  const clusters = model.catalog.clusters().sort((a, b) => a.order - b.order);
  for (const cluster of clusters) {
    if ((taken.get(cluster.track) ?? 0) >= clustersPerTrack || !clusterReady(model, cluster.id)) continue;
    const found = model.catalog
      .inCluster(cluster.id)
      .filter((i) => !exclude.has(i.id) && i.skills.every((s) => isUntaught(model, i.id, s)) && prerequisitesMet(model, i));
    if (found.length === 0) continue;
    taken.set(cluster.track, (taken.get(cluster.track) ?? 0) + 1);
    out.push([cluster.id, found]);
  }
  return out;
}

/**
 * Never taught to the point of a review card: unseen, met only through missed probes, or missed again
 * after teaching (status Learning with no card). Without this last case such an item is never due and
 * never new, so it would not come back. Items marked Known with no card (placement, "I know this") are taught.
 */
function isUntaught(model: LearnerModel, itemId: string, skill: Skill): boolean {
  const s = model.state(itemId, skill);
  if (s.status === 'unseen') return true;
  return !s.card && (s.status === 'introduced' || s.status === 'learning');
}

export function clusterReady(model: LearnerModel, clusterId: string): boolean {
  const cluster = model.catalog.cluster(clusterId);
  const placement = model.placement();
  return (cluster?.requires ?? []).every((req) => {
    if (placement.get(req)?.placement === 'known') return true;
    const items = model.catalog.inCluster(req);
    const mean = items.reduce((sum, i) => sum + model.pKnown(i.id, 'read'), 0) / Math.max(1, items.length);
    return mean >= model.config.planner.prerequisiteMin;
  });
}

function nextPlacementProbe(model: LearnerModel, sessionId: string, exclude: Set<string>): Item | null {
  const placement = model.placement();
  for (const [name, track] of groupByTrack(model.catalog.clusters())) {
    if (name === 'sound') continue;
    const cluster = nextProbeCluster(track, placement);
    if (!cluster || !clusterReady(model, cluster.id)) continue;
    const pool = model.catalog
      .inCluster(cluster.id)
      .filter((i) => !model.firstOutcome.has(i.id) && !model.lastExposure.has(i.id))
      .filter((i) => !exclude.has(i.id));
    if (pool.length === 0) continue;
    const pick = pool[hash(`${sessionId}:${cluster.id}:${placement.get(cluster.id)?.samples ?? 0}`) % pool.length]!;
    return pick;
  }
  return null;
}
