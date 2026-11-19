import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config';
import { computePlacement, nextProbeCluster } from '../src/placement';
import type { Cluster } from '../src/types';

const track: Cluster[] = ['a', 'b', 'c', 'd', 'e'].map((id, order) => ({ id, track: 't', order, label: id }));
const K = [true, true, true];
const U = [false, false, false];

function place(outcomes: Record<string, boolean[]>) {
  const p = computePlacement(track, new Map(Object.entries(outcomes)), DEFAULT_CONFIG);
  return Object.fromEntries(track.map((c) => [c.id, p.get(c.id)!.placement]));
}

describe('computePlacement', () => {
  it.each([
    [{}, ['unplaced', 'unplaced', 'unplaced', 'unplaced', 'unplaced']],
    [{ c: K }, ['known', 'known', 'known', 'unplaced', 'unplaced']],
    [{ c: U }, ['unplaced', 'unplaced', 'unknown', 'unknown', 'unknown']],
    [{ c: K, d: U }, ['known', 'known', 'known', 'unknown', 'unknown']],
    [{ c: [true, true, false] }, ['known', 'known', 'known', 'unplaced', 'unplaced']],
    [{ c: [true, false, false] }, ['unplaced', 'unplaced', 'unknown', 'unknown', 'unknown']],
    [{ c: [true, true] }, ['unplaced', 'unplaced', 'unplaced', 'unplaced', 'unplaced']],
    [{ b: U, d: K }, ['known', 'unknown', 'known', 'known', 'unknown']],
  ])('%j', (outcomes, expected) => {
    expect(Object.values(place(outcomes))).toEqual(expected);
  });
});

describe('nextProbeCluster', () => {
  const next = (outcomes: Record<string, boolean[]>) =>
    nextProbeCluster(track, computePlacement(track, new Map(Object.entries(outcomes)), DEFAULT_CONFIG))?.id ?? null;

  it('starts in the middle', () => expect(next({})).toBe('c'));
  it('moves up after a known middle', () => expect(next({ c: K })).toBe('d'));
  it('moves down after an unknown middle', () => expect(next({ c: U })).toBe('a'));
  it('stops when everything is placed', () => expect(next({ c: K, d: K, e: K })).toBeNull());
});
