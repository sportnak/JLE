import { retrievability, type Scheduler } from './model';
import type { ActivityRecord, LearnerModel } from './learner';
import { groupByTrack, nextProbeCluster } from './placement';
import { CUE_SKILL, type ActivitySpec, type Cue, type Item, type Skill } from './types';

export interface Candidate {
  spec: ActivitySpec;
  score: number;
  reason: string;
}

export function cueFor(item: Item, skill: Skill): Cue {
  if (item.type === 'script') return 'kana_to_reading';
  return skill === 'write' ? 'en_to_ja' : 'ja_to_en';
}

function retrieval(
  item: Item,
  skill: Skill,
  purpose: Extract<ActivitySpec, { type: 'retrieval' }>['purpose'],
  cue: Cue = cueFor(item, skill),
): ActivitySpec {
  return {
    type: 'retrieval',
    itemId: item.id,
    cue,
    purpose,
    showFurigana: cue === 'ja_to_en' && item.written !== item.reading,
  };
}

const primarySkill = (item: Item): Skill => (item.skills.includes('write') ? 'write' : 'read');

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Per-item history within one session, in order. */
function sessionHistory(acts: ActivityRecord[]): Map<string, ActivityRecord[]> {
  const byItem = new Map<string, ActivityRecord[]>();
  for (const a of acts) byItem.set(a.spec.itemId, [...(byItem.get(a.spec.itemId) ?? []), a]);
  return byItem;
}

const missed = (a: ActivityRecord) => a.spec.type === 'retrieval' && (a.outcome === 'wrong' || a.outcome === 'dont_know');
const right = (a: ActivityRecord) => a.spec.type === 'retrieval' && (a.outcome === 'correct' || a.outcome === 'self_corrected');

/**
 * Scores every candidate activity and returns them best first. The planner never looks further
 * ahead than the next activity. Within a session an item comes back only for a reason: you missed it,
 * it is due, or it was just introduced and gets one later check. A correct answer means it rests.
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
  const candidates: Candidate[] = [];
  const last = sessionActs.at(-1);

  if (last?.spec.type === 'introduce') {
    const item = model.items.get(last.spec.itemId);
    if (item) candidates.push({ spec: retrieval(item, primarySkill(item), 'practice'), score: 1000, reason: 'immediate use' });
  }

  for (const [itemId, acts] of history) {
    if (recentItems.has(itemId)) continue;
    const item = model.items.get(itemId);
    if (!item || !prerequisitesMet(model, item)) continue;
    const lastMiss = acts.findLastIndex(missed);
    const lastIntro = acts.findLastIndex((a: ActivityRecord) => a.spec.type === 'introduce');
    const lastRight = acts.findLastIndex(right);
    const untaught = item.skills.every((sk) => !model.state(itemId, sk).card);
    const misses = acts.filter(missed).length;

    const intros = acts.filter((a) => a.spec.type === 'introduce').length;
    if (lastMiss >= 0 && lastMiss > lastRight && untaught && lastIntro < lastMiss && intros < cfg.maxRelearnPerSession) {
      candidates.push({ spec: { type: 'introduce', itemId }, score: 90, reason: 'missed, teach it' });
    } else if (lastMiss >= 0 && lastMiss > lastRight && misses <= cfg.maxRelearnPerSession) {
      const a = acts[lastMiss]!;
      if (a.spec.type === 'retrieval') {
        candidates.push({
          spec: retrieval(item, CUE_SKILL[a.spec.cue], 'practice', a.spec.cue),
          score: 85,
          reason: 'missed earlier this session',
        });
      }
    } else if (lastIntro >= 0) {
      const usesSinceIntro = acts.slice(lastIntro + 1).filter((a) => a.spec.type === 'retrieval').length;
      const sinceLastSeen = sessionActs.length - 1 - sessionActs.lastIndexOf(acts.at(-1)!);
      if (usesSinceIntro === 1 && sinceLastSeen >= cfg.checkGap) {
        candidates.push({ spec: retrieval(item, primarySkill(item), 'practice'), score: 80, reason: 'one more check' });
      }
    }
  }

  for (const s of model.states.values()) {
    if (recentItems.has(s.itemId) || metThisSession.has(s.itemId) || s.status === 'unseen') continue;
    const item = model.items.get(s.itemId);
    if (!item) continue;
    if (s.confirmDueAt && new Date(s.confirmDueAt) <= now) {
      candidates.push({ spec: retrieval(item, s.skill, 'confirm'), score: 60, reason: 'confirm "I know this"' });
    } else if (s.card && new Date(s.card.dueAt) <= now) {
      const r = retrievability(scheduler, s.card, now);
      candidates.push({ spec: retrieval(item, s.skill, 'review'), score: 50 + (1 - r) * 40, reason: 'due' });
    }
  }

  const placementProbe = nextPlacementProbe(model, sessionId, recentItems);
  if (placementProbe) candidates.push({ spec: retrieval(placementProbe, primarySkill(placementProbe), 'placement'), score: 70, reason: 'placement' });

  const newSoFar = sessionActs.filter(
    (a) => (a.spec.type === 'introduce' || a.spec.purpose === 'probe') && history.get(a.spec.itemId)![0] === a,
  ).length;
  if (newSoFar < sessionBudget(model, sessionActs, now, newSoFar)) {
    const teach = teachMode(sessionActs, cfg.teachModeDontKnows);
    frontierPicks(model, metThisSession).forEach((item, i) => {
      const probe = !teach && model.prior(item.id) >= cfg.probeThreshold;
      candidates.push({
        spec: probe ? retrieval(item, primarySkill(item), 'probe') : { type: 'introduce', itemId: item.id },
        score: 30 - i,
        reason: probe ? 'new, probably known' : 'new',
      });
    });
  }

  return interleave(model, sessionActs, candidates).sort((a, b) => b.score - a.score);
}

/**
 * New items allowed this session. Starts from the retention-based budget; while recent answers are
 * accurate there is always room for one more, and when they are mostly wrong intake stops.
 */
export function sessionBudget(model: LearnerModel, acts: ActivityRecord[], now: Date, newSoFar: number): number {
  const recent = acts
    .filter((a) => a.spec.type === 'retrieval' && a.spec.purpose !== 'placement' && a.outcome && a.outcome !== 'skip')
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
  const track = new Map(model.catalog.clusters.map((c) => [c.id, c.track]));
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
  const basics = model.catalog.items.filter((i) => i.cluster === 'hiragana-basic');
  if (basics.length === 0) return false;
  const learned = basics.filter((i) => model.pKnown(i.id, 'read') >= model.config.planner.prerequisiteMin).length;
  return learned / basics.length < 0.8;
}

/**
 * No more than three of the same kind in a row: item type normally, kana group in the kana stage
 * (so hiragana and katakana groups mix). Over-the-limit candidates sink but stay available.
 */
function interleave(model: LearnerModel, acts: ActivityRecord[], candidates: Candidate[]): Candidate[] {
  const kanaStage = inKanaStage(model);
  const kind = (itemId: string) => {
    const item = model.items.get(itemId);
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
  const probes = acts.filter((a) => a.spec.type === 'retrieval' && a.spec.purpose === 'probe').slice(-4);
  return probes.filter((a) => a.outcome === 'wrong' || a.outcome === 'dont_know').length >= threshold;
}

export function prerequisitesMet(model: LearnerModel, item: Item): boolean {
  const min = model.config.planner.prerequisiteMin;
  return model.catalog.edges
    .filter((e) => e.to === item.id && e.kind !== 'confusable')
    .every((e) => model.pKnown(e.from, 'read') >= min);
}

export function frontierItems(model: LearnerModel, exclude: Set<string>): Item[] {
  const clusterOrder = new Map(model.catalog.clusters.map((c) => [c.id, c.order]));
  return model.catalog.items
    .filter((i) => !exclude.has(i.id))
    .filter((i) => i.skills.every((s) => isUntaught(model, i.id, s)))
    .filter((i) => clusterReady(model, i.cluster))
    .filter((i) => prerequisitesMet(model, i))
    .sort((a, b) => (clusterOrder.get(a.cluster) ?? 0) - (clusterOrder.get(b.cluster) ?? 0) || a.order - b.order);
}

/** Never taught: unseen, or only met through a missed probe (no review card yet). */
function isUntaught(model: LearnerModel, itemId: string, skill: Skill): boolean {
  const s = model.state(itemId, skill);
  return s.status === 'unseen' || (s.status === 'introduced' && !s.card);
}

export function clusterReady(model: LearnerModel, clusterId: string): boolean {
  const cluster = model.catalog.clusters.find((c) => c.id === clusterId);
  const placement = model.placement();
  return (cluster?.requires ?? []).every((req) => {
    if (placement.get(req)?.placement === 'known') return true;
    const items = model.catalog.items.filter((i) => i.cluster === req);
    const mean = items.reduce((sum, i) => sum + model.pKnown(i.id, 'read'), 0) / Math.max(1, items.length);
    return mean >= model.config.planner.prerequisiteMin;
  });
}

function nextPlacementProbe(model: LearnerModel, sessionId: string, exclude: Set<string>): Item | null {
  const placement = model.placement();
  for (const track of groupByTrack(model.catalog.clusters).values()) {
    const cluster = nextProbeCluster(track, placement);
    if (!cluster || !clusterReady(model, cluster.id)) continue;
    const pool = model.catalog.items
      .filter((i) => i.cluster === cluster.id && !model.firstOutcome.has(i.id) && !model.lastExposure.has(i.id))
      .filter((i) => !exclude.has(i.id));
    if (pool.length === 0) continue;
    const pick = pool[hash(`${sessionId}:${cluster.id}:${placement.get(cluster.id)?.samples ?? 0}`) % pool.length]!;
    return pick;
  }
  return null;
}
