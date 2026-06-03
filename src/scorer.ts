import type { ProbeResult, ScoredRpc, SubScores } from './types';
import type { Weights } from './config';

export interface ScoringParams {
  weights: Weights;
  latencyBestMs: number;
  latencyWorstMs: number;
  freshnessMaxLag: number;
  rateLimitTargetRps: number;
}

function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n));
}

function latencyScore(p50: number, best: number, worst: number): number {
  if (p50 <= best) return 100;
  if (p50 >= worst) return 0;
  return clamp(100 * (1 - (p50 - best) / (worst - best)));
}

function freshnessScore(lag: number, maxLag: number): number {
  if (lag <= 0) return 100;
  if (lag >= maxLag) return 0;
  return clamp(100 * (1 - lag / maxLag));
}

function rateLimitScore(rps: number, target: number): number {
  if (target <= 0) return 100;
  return clamp((rps / target) * 100);
}

/**
 * Pure: convert a ProbeResult into a 0-100 composite score with breakdown.
 * Liveness is a gate — dead or wrong-chain RPCs score 0.
 */
export function scoreRpc(
  probe: ProbeResult,
  chainMaxBlock: number | null,
  params: ScoringParams,
): ScoredRpc {
  if (!probe.alive || !probe.chainIdMatch) {
    return {
      url: probe.url,
      ...(probe.tracking ? { tracking: probe.tracking } : {}),
      score: 0,
      alive: false,
      latencyMs: probe.latencyMs,
      blockLag: null,
      rateLimit: probe.rateLimit,
      subScores: { latency: 0, freshness: 0, rateLimit: 0 },
      errorKind: probe.errorKind,
    };
  }

  const p50 = probe.latencyMs?.p50 ?? params.latencyWorstMs;
  const lat = latencyScore(p50, params.latencyBestMs, params.latencyWorstMs);

  const blockLag =
    chainMaxBlock !== null && probe.blockNumber !== null
      ? Math.max(0, chainMaxBlock - probe.blockNumber)
      : 0;
  const fresh = freshnessScore(blockLag, params.freshnessMaxLag);

  // No burst data -> neutral 50 so it neither helps nor unfairly hurts.
  const rl = probe.rateLimit
    ? rateLimitScore(probe.rateLimit.sustainableRps, params.rateLimitTargetRps)
    : 50;

  const subScores: SubScores = {
    latency: Math.round(lat),
    freshness: Math.round(fresh),
    rateLimit: Math.round(rl),
  };

  const w = params.weights;
  const totalW = w.latency + w.freshness + w.rateLimit;
  const composite =
    (subScores.latency * w.latency +
      subScores.freshness * w.freshness +
      subScores.rateLimit * w.rateLimit) /
    totalW;

  return {
    url: probe.url,
    ...(probe.tracking ? { tracking: probe.tracking } : {}),
    score: Math.round(composite * 10) / 10,
    alive: true,
    latencyMs: probe.latencyMs,
    blockLag,
    rateLimit: probe.rateLimit,
    subScores,
    errorKind: probe.errorKind,
  };
}
