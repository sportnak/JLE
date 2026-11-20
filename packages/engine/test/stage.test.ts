import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, overClosedCap, stageFor, strandPull, strandTargets, STRANDS, type Stage } from '../src/index';

describe('stage from vocabulary size', () => {
  it.each([
    [0, 1],
    [299, 1],
    [300, 2],
    [799, 2],
    [800, 3],
    [1699, 3],
    [1700, 4],
    [5000, 4],
  ] as const)('%i known words is stage %i', (words, stage) => {
    expect(stageFor(words, DEFAULT_CONFIG)).toBe(stage);
  });
});

describe('strand targets by stage', () => {
  it.each([
    [1, { study: 0.5, input: 0.3, output: 0.1, fluency: 0.1 }],
    [2, { study: 0.35, input: 0.3, output: 0.25, fluency: 0.1 }],
    [3, { study: 0.25, input: 0.25, output: 0.25, fluency: 0.25 }],
    [4, { study: 0.15, input: 0.35, output: 0.3, fluency: 0.2 }],
  ] as const)('stage %i', (stage, targets) => {
    expect(strandTargets(stage, DEFAULT_CONFIG)).toEqual(targets);
  });

  it.each([1, 2, 3, 4] as Stage[])('stage %i targets sum to one', (stage) => {
    const t = strandTargets(stage, DEFAULT_CONFIG);
    expect(STRANDS.reduce((sum, s) => sum + t[s], 0)).toBeCloseTo(1);
  });

  it('keeps stage 3 within the 15–35% band for every strand', () => {
    for (const s of STRANDS) expect(strandTargets(3, DEFAULT_CONFIG)[s]).toBeGreaterThanOrEqual(0.15);
    for (const s of STRANDS) expect(strandTargets(3, DEFAULT_CONFIG)[s]).toBeLessThanOrEqual(0.35);
  });

  it.each([
    ['no time yet: pulled by target alone', { input: 0, output: 0, study: 0, fluency: 0 }, 1, { input: 15, output: 5, study: 25, fluency: 5 }],
    ['all study at stage 1', { input: 0, output: 0, study: 10, fluency: 0 }, 1, { input: 15, output: 5, study: -25, fluency: 5 }],
    ['on target at stage 1', { input: 3, output: 1, study: 5, fluency: 1 }, 1, { input: 0, output: 0, study: 0, fluency: 0 }],
    ['all input at stage 3', { input: 8, output: 0, study: 0, fluency: 0 }, 3, { input: -37.5, output: 12.5, study: 12.5, fluency: 12.5 }],
  ] as const)('pull: %s', (_name, minutes, stage, pull) => {
    const got = strandPull(minutes, stage as Stage, DEFAULT_CONFIG);
    for (const s of STRANDS) expect(got[s]).toBeCloseTo(pull[s]);
  });
});

describe('closed-exercise cap', () => {
  it.each([
    ['stage 1 is exempt', 1, 9, 10, false],
    ['stage 2 under the cap', 2, 3, 10, false],
    ['stage 2 at the cap', 2, 4, 10, true],
    ['stage 3 over the cap', 3, 9, 10, true],
    ['stage 4 nothing done yet', 4, 0, 0, false],
  ] as const)('%s', (_name, stage, closedMs, totalMs, over) => {
    expect(overClosedCap(closedMs, totalMs, stage, DEFAULT_CONFIG)).toBe(over);
  });
});
