import { describe, it, expect } from 'vitest';
import { rankRpcs } from '../src/output';
import type { ScoredRpc } from '../src/types';

function rpc(url: string, score: number, alive = true, tracking?: string): ScoredRpc {
  return {
    url,
    ...(tracking ? { tracking } : {}),
    score,
    alive,
    latencyMs: null,
    blockLag: 0,
    rateLimit: null,
    subScores: { latency: 0, freshness: 0, rateLimit: 0 },
    errorKind: null,
  };
}

describe('rankRpcs', () => {
  it('sorts by score descending', () => {
    const ranked = rankRpcs([rpc('a', 50), rpc('b', 90), rpc('c', 70)]);
    expect(ranked.map((r) => r.url)).toEqual(['b', 'c', 'a']);
  });

  it('pushes dead (score 0) RPCs to the bottom', () => {
    const ranked = rankRpcs([rpc('dead', 0, false), rpc('good', 80)]);
    expect(ranked.map((r) => r.url)).toEqual(['good', 'dead']);
  });

  it('does not mutate the input array', () => {
    const input = [rpc('a', 10), rpc('b', 20)];
    rankRpcs(input);
    expect(input.map((r) => r.url)).toEqual(['a', 'b']);
  });

  it('breaks score ties by privacy (none > limited > yes > unknown)', () => {
    const ranked = rankRpcs([
      rpc('tracked', 80, true, 'yes'),
      rpc('unknown', 80, true),
      rpc('private', 80, true, 'none'),
      rpc('limited', 80, true, 'limited'),
    ]);
    expect(ranked.map((r) => r.url)).toEqual(['private', 'limited', 'tracked', 'unknown']);
  });

  it('only applies the privacy tie-break within equal scores', () => {
    const ranked = rankRpcs([
      rpc('low-private', 50, true, 'none'),
      rpc('high-tracked', 90, true, 'yes'),
    ]);
    expect(ranked.map((r) => r.url)).toEqual(['high-tracked', 'low-private']);
  });
});
