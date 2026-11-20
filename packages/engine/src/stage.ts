import type { EngineConfig } from './config';
import type { Stage, Strand } from './types';

export const STRANDS: Strand[] = ['input', 'output', 'study', 'fluency'];

/** Stage from vocabulary size: words Known (or Maintained) for recognition. */
export function stageFor(knownWords: number, config: EngineConfig): Stage {
  const [two, three, four] = config.mix.stageWords;
  if (knownWords >= four) return 4;
  if (knownWords >= three) return 3;
  if (knownWords >= two) return 2;
  return 1;
}

export function strandTargets(stage: Stage, config: EngineConfig): Record<Strand, number> {
  return config.mix.strandTargets[stage];
}

function shares(minutes: Record<Strand, number>): Record<Strand, number> | null {
  const total = STRANDS.reduce((sum, s) => sum + minutes[s], 0);
  if (total <= 0) return null;
  return Object.fromEntries(STRANDS.map((s) => [s, minutes[s] / total])) as Record<Strand, number>;
}

/**
 * Score adjustment per strand: positive for strands below their target share, negative above.
 * The share is the trailing week's, blended with this session's once the session has some time in it,
 * so a session catches up on a lagging strand without being taken over by it.
 * With no time logged yet every strand is pulled by its target alone.
 */
export function strandPull(
  weekMinutes: Record<Strand, number>,
  stage: Stage,
  config: EngineConfig,
  sessionMinutes?: Record<Strand, number>,
): Record<Strand, number> {
  const targets = strandTargets(stage, config);
  const week = shares(weekMinutes);
  const sessionTotal = sessionMinutes ? STRANDS.reduce((sum, s) => sum + sessionMinutes[s], 0) : 0;
  const session = sessionMinutes && sessionTotal >= config.mix.sessionBlendAfterMinutes ? shares(sessionMinutes) : null;
  const b = config.mix.sessionBlend;
  const pull = {} as Record<Strand, number>;
  for (const s of STRANDS) {
    const w = week?.[s] ?? 0;
    const share = session ? (week ? (1 - b) * w + b * session[s] : session[s]) : w;
    pull[s] = config.mix.strandWeight * (targets[s] - share);
  }
  return pull;
}

/** True once closed exercises have reached their cap for this session. The cap starts at stage 2. */
export function overClosedCap(closedMs: number, totalMs: number, stage: Stage, config: EngineConfig): boolean {
  return stage >= 2 && totalMs > 0 && closedMs / totalMs >= config.mix.closedCap;
}
