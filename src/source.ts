import type { ChainSource, RpcSource } from './types';

interface RawRpcEntry {
  url?: string;
  tracking?: string;
}

interface RawChain {
  name?: string;
  chainId?: number;
  rpc?: Array<string | RawRpcEntry>;
}

/** Normalize a chain's raw rpc array (strings or objects) into usable https endpoints. */
function normalizeRpcs(raw: RawChain['rpc']): RpcSource[] {
  if (!Array.isArray(raw)) return [];
  const out: RpcSource[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const url = typeof entry === 'string' ? entry : entry?.url;
    const tracking = typeof entry === 'string' ? undefined : entry?.tracking;
    if (!url || typeof url !== 'string') continue;
    if (!url.startsWith('https://')) continue; // skip http / ws / wss
    if (url.includes('${') || url.includes('API_KEY')) continue; // skip key-templated URLs
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(tracking ? { url, tracking } : { url });
  }
  return out;
}

/** Pure: parse a Chainlist-style payload into ChainSource[] filtered to the given chain IDs. */
export function parseChainSources(data: unknown, chainIds: number[]): ChainSource[] {
  if (!Array.isArray(data)) throw new Error('Chainlist response is not an array');

  const byId = new Map<number, RawChain>();
  for (const c of data as RawChain[]) {
    if (c && typeof c.chainId === 'number') byId.set(c.chainId, c);
  }

  const result: ChainSource[] = [];
  for (const id of chainIds) {
    const c = byId.get(id);
    if (!c) {
      console.warn(`[source] chain ${id} not found in Chainlist; skipping`);
      continue;
    }
    const rpcs = normalizeRpcs(c.rpc);
    if (rpcs.length === 0) {
      console.warn(`[source] chain ${id} has no usable https RPCs; skipping`);
      continue;
    }
    result.push({ chainId: id, name: c.name ?? `Chain ${id}`, rpcs });
  }
  return result;
}

/** Fetch the Chainlist payload and parse it. Throws on network / HTTP failure. */
export async function fetchChainSources(
  chainlistUrl: string,
  chainIds: number[],
): Promise<ChainSource[]> {
  const res = await fetch(chainlistUrl);
  if (!res.ok) throw new Error(`Chainlist fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  return parseChainSources(data, chainIds);
}
