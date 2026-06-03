import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScoredRpc } from './types';

export interface ChainOutput {
  chainId: number;
  name: string;
  rpcs: ScoredRpc[];
}

/** Pure: return a copy sorted by score descending (alive endpoints first naturally). */
export function rankRpcs(rpcs: ScoredRpc[]): ScoredRpc[] {
  return [...rpcs].sort((a, b) => b.score - a.score);
}

/** Write per-chain ranked JSON files plus an index.json summary. */
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
}
