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

/**
 * Score adjustment per strand: positive for strands below their target share, negative above.
 * With no time logged yet every strand is pulled by its target alone.
 */
export function strandPull(minutes: Record<Strand, number>, stage: Stage, config: EngineConfig): Record<Strand, number> {
  const total = STRANDS.reduce((sum, s) => sum + minutes[s], 0);
  const targets = strandTargets(stage, config);
  const pull = {} as Record<Strand, number>;
  for (const s of STRANDS) pull[s] = config.mix.strandWeight * (targets[s] - (total > 0 ? minutes[s] / total : 0));
  return pull;
}

/** True once closed exercises have reached their cap for this session. The cap starts at stage 2. */
export function overClosedCap(closedMs: number, totalMs: number, stage: Stage, config: EngineConfig): boolean {
  return stage >= 2 && totalMs > 0 && closedMs / totalMs >= config.mix.closedCap;
}
