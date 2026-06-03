import { describe, it, expect } from 'vitest';
import { scoreRpc, type ScoringParams } from '../src/scorer';
import type { ProbeResult } from '../src/types';

const params: ScoringParams = {
  weights: { latency: 0.4, freshness: 0.3, rateLimit: 0.3 },
  latencyBestMs: 100,
  latencyWorstMs: 2000,
  freshnessMaxLag: 10,
  rateLimitTargetRps: 30,
};

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    url: 'https://rpc.example.com',
    alive: true,
    chainIdMatch: true,
    latencyMs: { p50: 100, p95: 150 },
    blockNumber: 1000,
    httpStatus: 200,
    errorKind: null,
    rateLimit: { sustainableRps: 30, throttled: false },
    ...overrides,
  };
}

describe('scoreRpc liveness gate', () => {
  it('scores a dead RPC 0', () => {
    const result = scoreRpc(probe({ alive: false, errorKind: 'timeout' }), 1000, params);
    expect(result.score).toBe(0);
    expect(result.alive).toBe(false);
    expect(result.subScores).toEqual({ latency: 0, freshness: 0, rateLimit: 0 });
  });

  it('scores a wrong-chain RPC 0', () => {
    const result = scoreRpc(
      probe({ chainIdMatch: false, errorKind: 'wrong_chain' }),
      1000,
      params,
    );
    expect(result.score).toBe(0);
  });
});

describe('scoreRpc composite', () => {
  it('gives a perfect RPC ~100', () => {
    const result = scoreRpc(probe(), 1000, params);
    expect(result.subScores).toEqual({ latency: 100, freshness: 100, rateLimit: 100 });
    expect(result.score).toBe(100);
    expect(result.blockLag).toBe(0);
  });

  it('penalizes block lag', () => {
    const result = scoreRpc(probe({ blockNumber: 995 }), 1000, params);
    expect(result.blockLag).toBe(5);
    expect(result.subScores.freshness).toBe(50); // lag 5 of maxLag 10
  });

  it('zeroes freshness beyond max lag', () => {
    const result = scoreRpc(probe({ blockNumber: 980 }), 1000, params);
    expect(result.blockLag).toBe(20);
    expect(result.subScores.freshness).toBe(0);
  });

  it('scales latency between best and worst', () => {
    // p50 = 1050 is the midpoint between 100 and 2000 -> ~50
    const result = scoreRpc(probe({ latencyMs: { p50: 1050, p95: 1100 } }), 1000, params);
    expect(result.subScores.latency).toBe(50);
  });

  it('penalizes low sustainable RPS', () => {
    const result = scoreRpc(
      probe({ rateLimit: { sustainableRps: 15, throttled: true } }),
      1000,
      params,
    );
    expect(result.subScores.rateLimit).toBe(50); // 15 / 30
  });

  it('uses neutral rate-limit score when no burst data', () => {
    const result = scoreRpc(probe({ rateLimit: null }), 1000, params);
    expect(result.subScores.rateLimit).toBe(50);
  });

  it('applies weights to the composite', () => {
    // latency 100*0.4 + freshness 0*0.3 + rateLimit 100*0.3 = 70
    const result = scoreRpc(probe({ blockNumber: 980 }), 1000, params);
    expect(result.score).toBe(70);
  });
});
