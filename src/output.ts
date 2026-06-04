import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScoredRpc } from './types';

export interface ChainOutput {
  chainId: number;
  name: string;
  rpcs: ScoredRpc[];
}

// Lower is more privacy-respecting; unknown tracking ranks last.
const PRIVACY_RANK: Record<string, number> = { none: 0, limited: 1, yes: 2 };

function privacyRank(tracking?: string): number {
  return tracking !== undefined && tracking in PRIVACY_RANK ? PRIVACY_RANK[tracking] : 3;
}

/**
 * Pure: copy sorted by score descending. Ties are broken by Chainlist `tracking`
 * metadata, preferring more privacy-respecting endpoints (none > limited > yes).
 */
export function rankRpcs(rpcs: ScoredRpc[]): ScoredRpc[] {
  return [...rpcs].sort(
    (a, b) => b.score - a.score || privacyRank(a.tracking) - privacyRank(b.tracking),
  );
}

/** Write per-chain ranked JSON, an index.json summary, and a shields endpoint badge. */
export async function writeOutputs(
  outputDir: string,
  chains: ChainOutput[],
  updatedAt: string,
): Promise<void> {
  const chainsDir = join(outputDir, 'chains');
  await mkdir(chainsDir, { recursive: true });

  const indexChains = [];
  for (const chain of chains) {
    const ranked = rankRpcs(chain.rpcs);
    const file = `chains/${chain.chainId}.json`;
    const payload = {
      chainId: chain.chainId,
      name: chain.name,
      updatedAt,
      rpcs: ranked,
    };
    await writeFile(join(outputDir, file), JSON.stringify(payload, null, 2) + '\n');
    indexChains.push({
      chainId: chain.chainId,
      name: chain.name,
      rpcCount: ranked.length,
      aliveCount: ranked.filter((r) => r.alive).length,
      file,
    });
  }

  const index = { updatedAt, chains: indexChains };
  await writeFile(join(outputDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');

  // shields.io endpoint badge so the README chain count never drifts.
  const badge = {
    schemaVersion: 1,
    label: 'chains',
    message: String(chains.length),
    color: 'blue',
  };
  await writeFile(join(outputDir, 'badge-chains.json'), JSON.stringify(badge) + '\n');
}
