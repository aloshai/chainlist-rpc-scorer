import { describe, it, expect, vi } from 'vitest';
import { run, probeAndScoreChain, type RunDeps, type ProbeFn } from '../src/run';
import type { Config } from '../src/config';
import type { ProbeOptions } from '../src/prober';
import type { ScoringParams } from '../src/scorer';
import type { ChainSource, ProbeResult } from '../src/types';

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    chainlistUrl: 'https://example.com/rpcs.json',
    chains: [1],
    weights: { latency: 0.4, freshness: 0.3, rateLimit: 0.3 },
    probe: { samples: 1, timeoutMs: 1000, perChainConcurrency: 4, chainConcurrency: 4 },
    burst: { enabled: false, stepSize: 5, maxConcurrency: 10, maxTotalRequests: 100 },
    scoring: { latencyBestMs: 100, latencyWorstMs: 2000, freshnessMaxLag: 10, rateLimitTargetRps: 30 },
    outputDir: 'data',
    ...over,
  };
}

function probeResult(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    url: 'https://rpc.example.com',
    alive: true,
    chainIdMatch: true,
    latencyMs: { p50: 100, p95: 120 },
    blockNumber: 100,
    httpStatus: 200,
    errorKind: null,
    rateLimit: { sustainableRps: 30, throttled: false },
    ...over,
  };
}

const scoringParams: ScoringParams = {
  weights: { latency: 0.4, freshness: 0.3, rateLimit: 0.3 },
  latencyBestMs: 100,
  latencyWorstMs: 2000,
  freshnessMaxLag: 10,
  rateLimitTargetRps: 30,
};
const dummyOpts: ProbeOptions = {
  samples: 1,
  timeoutMs: 1000,
  burst: { enabled: false, stepSize: 5, maxConcurrency: 10, maxTotalRequests: 100 },
};

describe('probeAndScoreChain', () => {
  it('computes block lag from the chain-wide max block', async () => {
    const chain: ChainSource = {
      chainId: 1,
      name: 'Test',
      rpcs: [{ url: 'https://a' }, { url: 'https://b' }],
    };
    const probeFn: ProbeFn = async (rpc) =>
      probeResult({ url: rpc.url, blockNumber: rpc.url === 'https://a' ? 100 : 95 });

    const out = await probeAndScoreChain(chain, probeFn, dummyOpts, scoringParams, 4);

    const a = out.rpcs.find((r) => r.url === 'https://a');
    const b = out.rpcs.find((r) => r.url === 'https://b');
    expect(a?.blockLag).toBe(0);
    expect(b?.blockLag).toBe(5);
    expect(out.chainId).toBe(1);
  });

  it('probes every RPC exactly once', async () => {
    const chain: ChainSource = {
      chainId: 1,
      name: 'Test',
      rpcs: [{ url: 'https://a' }, { url: 'https://b' }, { url: 'https://c' }],
    };
    const probeFn = vi.fn<ProbeFn>(async (rpc) => probeResult({ url: rpc.url }));
    await probeAndScoreChain(chain, probeFn, dummyOpts, scoringParams, 2);
    expect(probeFn).toHaveBeenCalledTimes(3);
  });
});

describe('run', () => {
  function deps(over: Partial<RunDeps> = {}): RunDeps {
    return {
      config: makeConfig(),
      fetchSources: async () => [{ chainId: 1, name: 'Test', rpcs: [{ url: 'https://a' }] }],
      probeFn: async (rpc) => probeResult({ url: rpc.url }),
      write: vi.fn(async () => {}),
      now: () => '2026-06-04T00:00:00.000Z',
      log: () => {},
      ...over,
    };
  }

  it('preserves previous data when the source is unreachable', async () => {
    const write = vi.fn<RunDeps['write']>(async () => {});
    const result = await run(
      deps({
        write,
        fetchSources: async () => {
          throw new Error('network down');
        },
      }),
    );
    expect(result).toEqual({ ok: false, chains: 0, reason: 'source-unreachable' });
    expect(write).not.toHaveBeenCalled();
  });

  it('probes, scores, and writes on success', async () => {
    const write = vi.fn<RunDeps['write']>(async () => {});
    const result = await run(deps({ write }));
    expect(result).toEqual({ ok: true, chains: 1 });
    expect(write).toHaveBeenCalledTimes(1);
    const [dir, chains, updatedAt] = write.mock.calls[0];
    expect(dir).toBe('data');
    expect(updatedAt).toBe('2026-06-04T00:00:00.000Z');
    expect(chains).toHaveLength(1);
    expect(chains[0].rpcs[0].alive).toBe(true);
  });

  it('processes every chain returned by the source', async () => {
    const write = vi.fn<RunDeps['write']>(async () => {});
    const sources: ChainSource[] = [1, 56, 137].map((id) => ({
      chainId: id,
      name: `Chain ${id}`,
      rpcs: [{ url: `https://rpc-${id}` }],
    }));
    const result = await run(deps({ write, fetchSources: async () => sources }));
    expect(result.chains).toBe(3);
    expect(write.mock.calls[0][1]).toHaveLength(3);
  });
});
