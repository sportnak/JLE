import type { EngineConfig } from './config';
import type { Cluster } from './types';

export type Verdict = 'known' | 'unknown';
export type Placement = 'known' | 'unknown' | 'unplaced';

export interface ClusterPlacement {
  cluster: Cluster;
  verdict: Verdict | null;
  placement: Placement;
  inferred: boolean;
  samples: number;
}

/**
 * Cold-start placement over ordered clusters in each track. A cluster gets its
 * own verdict from first-attempt outcomes on a few sampled items. Clusters
 * without a verdict are inferred: knowing a later cluster implies earlier ones,
 * failing an earlier cluster implies later ones. What remains is unplaced and
 * gets probed next, binary-search style.
 */
export function computePlacement(
  clusters: Cluster[],
  outcomesByCluster: Map<string, boolean[]>,
  config: EngineConfig,
): Map<string, ClusterPlacement> {
  const result = new Map<string, ClusterPlacement>();
  for (const track of groupByTrack(clusters).values()) {
    const verdicts = track.map((c) => verdictOf(outcomesByCluster.get(c.id) ?? [], config));
    track.forEach((c, i) => {
      const own = verdicts[i] ?? null;
      const inferredAs: Placement = verdicts.slice(i + 1).includes('known')
        ? 'known'
        : verdicts.slice(0, i).includes('unknown')
          ? 'unknown'
          : 'unplaced';
      const placement: Placement = own ?? inferredAs;
      const inferred = !own && inferredAs !== 'unplaced';
      result.set(c.id, {
        cluster: c,
        verdict: own,
        placement,
        inferred,
        samples: outcomesByCluster.get(c.id)?.length ?? 0,
      });
    });
  }
  return result;
}

function verdictOf(outcomes: boolean[], config: EngineConfig): Verdict | null {
  if (outcomes.length < config.placement.samplesPerCluster) return null;
  const share = outcomes.filter(Boolean).length / outcomes.length;
  return share >= 2 / 3 ? 'known' : 'unknown';
}

export function priorFor(p: ClusterPlacement | undefined, config: EngineConfig): number {
  if (!p || p.placement === 'unplaced') return config.model.defaultPrior;
  return p.placement === 'known' ? config.placement.knownPrior : config.placement.unknownPrior;
}

/** The cluster to probe next in a track: the middle of its first unplaced run. */
export function nextProbeCluster(track: Cluster[], placement: Map<string, ClusterPlacement>): Cluster | null {
  const idx = track.map((c, i) => (placement.get(c.id)?.placement === 'unplaced' ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return null;
  const lo = idx[0]!;
  let hi = lo;
  while (idx.includes(hi + 1)) hi++;
  return track[Math.floor((lo + hi) / 2)]!;
}

export function groupByTrack(clusters: Cluster[]): Map<string, Cluster[]> {
  const tracks = new Map<string, Cluster[]>();
  for (const c of [...clusters].sort((a, b) => a.order - b.order)) {
    const list = tracks.get(c.track) ?? [];
    list.push(c);
    tracks.set(c.track, list);
  }
  return tracks;
}
