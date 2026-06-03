import pLimit from 'p-limit';
import { config } from './config';
import { fetchChainSources } from './source';
import { probeRpc } from './prober';
import { scoreRpc, type ScoringParams } from './scorer';
import { writeOutputs, type ChainOutput } from './output';
import type { ProbeResult, ScoredRpc } from './types';

async function main(): Promise<void> {
  const updatedAt = new Date().toISOString();
  console.log(`[run] starting at ${updatedAt}`);

  let sources;
  try {
    sources = await fetchChainSources(config.chainlistUrl, config.chains);
  } catch (e) {
    // Stale data beats no data: keep previous output, do not fail the workflow.
    console.error('[run] Chainlist unreachable, preserving previous data:', e);
    return;
  }

  const scoringParams: ScoringParams = {
    weights: config.weights,
    latencyBestMs: config.scoring.latencyBestMs,
    latencyWorstMs: config.scoring.latencyWorstMs,
    freshnessMaxLag: config.scoring.freshnessMaxLag,
    rateLimitTargetRps: config.scoring.rateLimitTargetRps,
  };

  const chainOutputs: ChainOutput[] = [];

  for (const chain of sources) {
    console.log(
      `[run] chain ${chain.chainId} (${chain.name}): probing ${chain.rpcs.length} RPCs`,
    );
    const limit = pLimit(config.probe.perChainConcurrency);
    const probes: ProbeResult[] = await Promise.all(
      chain.rpcs.map((rpc) =>
        limit(() =>
          probeRpc(rpc, chain.chainId, {
            samples: config.probe.samples,
            timeoutMs: config.probe.timeoutMs,
            burst: config.burst,
          }),
        ),
      ),
    );

    const chainMaxBlock = probes.reduce<number | null>((max, p) => {
      if (p.blockNumber === null) return max;
      return max === null || p.blockNumber > max ? p.blockNumber : max;
    }, null);

    const scored: ScoredRpc[] = probes.map((p) => scoreRpc(p, chainMaxBlock, scoringParams));
    const aliveCount = scored.filter((r) => r.alive).length;
    console.log(`[run]   -> ${aliveCount}/${scored.length} alive`);

    chainOutputs.push({ chainId: chain.chainId, name: chain.name, rpcs: scored });
  }

  await writeOutputs(config.outputDir, chainOutputs, updatedAt);
  console.log(`[run] wrote ${chainOutputs.length} chain files to ${config.outputDir}/`);
}

main().catch((e) => {
  console.error('[run] fatal:', e);
  process.exitCode = 1;
});
