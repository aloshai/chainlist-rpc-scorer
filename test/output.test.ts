import { describe, it, expect } from 'vitest';
import { rankRpcs } from '../src/output';
import type { ScoredRpc } from '../src/types';

function rpc(url: string, score: number, alive = true): ScoredRpc {
  return {
    url,
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
});
