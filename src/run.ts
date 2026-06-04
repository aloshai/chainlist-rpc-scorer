import pLimit from 'p-limit';
import type { Config } from './config';
import type { ProbeOptions } from './prober';
import { scoreRpc, type ScoringParams } from './scorer';
import type { ChainOutput } from './output';
import type { ChainSource, ProbeResult, ScoredRpc } from './types';

export type ProbeFn = (
  rpc: ChainSource['rpcs'][number],
  expectedChainId: number,
  opts: ProbeOptions,
) => Promise<ProbeResult>;

/** Probe every RPC of one chain (bounded concurrency) and score against the chain's max block. */
export async function probeAndScoreChain(
  chain: ChainSource,
  probeFn: ProbeFn,
  probeOpts: ProbeOptions,
  scoringParams: ScoringParams,
  perChainConcurrency: number,
): Promise<ChainOutput> {
  const limit = pLimit(perChainConcurrency);
  const probes: ProbeResult[] = await Promise.all(
    chain.rpcs.map((rpc) => limit(() => probeFn(rpc, chain.chainId, probeOpts))),
  );

  const chainMaxBlock = probes.reduce<number | null>((max, p) => {
    if (p.blockNumber === null) return max;
    return max === null || p.blockNumber > max ? p.blockNumber : max;
  }, null);

  const rpcs: ScoredRpc[] = probes.map((p) => scoreRpc(p, chainMaxBlock, scoringParams));
  return { chainId: chain.chainId, name: chain.name, rpcs };
}

export interface RunDeps {
  config: Config;
  fetchSources: (url: string, chains: number[]) => Promise<ChainSource[]>;
  probeFn: ProbeFn;
  write: (dir: string, chains: ChainOutput[], updatedAt: string) => Promise<void>;
  now: () => string;
  log?: (message: string) => void;
}

export interface RunResult {
  ok: boolean;
  chains: number;
  reason?: 'source-unreachable';
}

/**
 * Orchestrate a full run: fetch sources, probe + score every chain (bounded
 * concurrency), then write outputs. If the source is unreachable, previous data
 * is preserved (no write) and the run reports a non-fatal failure.
 */
export async function run(deps: RunDeps): Promise<RunResult> {
  const { config, fetchSources, probeFn, write, now } = deps;
  const log = deps.log ?? (() => {});
  const updatedAt = now();

  let sources: ChainSource[];
  try {
    sources = await fetchSources(config.chainlistUrl, config.chains);
  } catch (e) {
    log(`Chainlist unreachable, preserving previous data: ${String(e)}`);
    return { ok: false, chains: 0, reason: 'source-unreachable' };
  }

  const scoringParams: ScoringParams = {
    weights: config.weights,
    latencyBestMs: config.scoring.latencyBestMs,
    latencyWorstMs: config.scoring.latencyWorstMs,
    freshnessMaxLag: config.scoring.freshnessMaxLag,
    rateLimitTargetRps: config.scoring.rateLimitTargetRps,
  };
  const probeOpts: ProbeOptions = {
    samples: config.probe.samples,
    timeoutMs: config.probe.timeoutMs,
    burst: config.burst,
  };

  const chainLimit = pLimit(config.probe.chainConcurrency);
  const outputs = await Promise.all(
    sources.map((chain) =>
      chainLimit(async () => {
        const out = await probeAndScoreChain(
          chain,
          probeFn,
          probeOpts,
          scoringParams,
          config.probe.perChainConcurrency,
        );
        const alive = out.rpcs.filter((r) => r.alive).length;
        log(`chain ${chain.chainId} (${chain.name}): ${alive}/${out.rpcs.length} alive`);
        return out;
      }),
    ),
  );

  await write(config.outputDir, outputs, updatedAt);
  log(`wrote ${outputs.length} chain files to ${config.outputDir}/`);
  return { ok: true, chains: outputs.length };
}
