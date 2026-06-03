import type {
  ProbeResult,
  RpcSource,
  ErrorKind,
  RateLimitStats,
} from './types';

export interface ProbeOptions {
  samples: number;
  timeoutMs: number;
  burst: {
    enabled: boolean;
    stepSize: number;
    maxConcurrency: number;
    maxTotalRequests: number;
  };
}

interface JsonRpcResponse {
  status: number;
  json: any | null;
  error: ErrorKind;
}

function looksRateLimited(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('rate') ||
    m.includes('limit') ||
    m.includes('quota') ||
    m.includes('capacity') ||
    m.includes('exceeded') ||
    m.includes('too many')
  );
}

async function jsonRpcCall(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs: number,
): Promise<JsonRpcResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    const status = res.status;
    if (status === 429) return { status, json: null, error: 'rate_limit' };
    if (!res.ok) return { status, json: null, error: 'network' };

    let json: any = null;
    try {
      json = await res.json();
    } catch {
      return { status, json: null, error: 'rpc_error' };
    }

    if (json && json.error) {
      const msg = String(json.error?.message ?? '');
      return { status, json, error: looksRateLimited(msg) ? 'rate_limit' : 'rpc_error' };
    }
    return { status, json, error: null };
  } catch (e: any) {
    if (e?.name === 'AbortError') return { status: 0, json: null, error: 'timeout' };
    return { status: 0, json: null, error: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function hexToNumber(hex: unknown): number | null {
  if (typeof hex !== 'string') return null;
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

/** Aggressive burst test: ramp concurrency until throttled or caps hit. */
async function burstTest(url: string, opts: ProbeOptions): Promise<RateLimitStats> {
  const { stepSize, maxConcurrency, maxTotalRequests } = opts.burst;
  let sustainableRps = 0;
  let throttled = false;
  let totalRequests = 0;

  for (let level = stepSize; level <= maxConcurrency; level += stepSize) {
    if (totalRequests + level > maxTotalRequests) break;
    totalRequests += level;

    const results = await Promise.all(
      Array.from({ length: level }, () =>
        jsonRpcCall(url, 'eth_blockNumber', [], opts.timeoutMs),
      ),
    );

    if (results.some((r) => r.error === 'rate_limit')) {
      throttled = true;
      break;
    }
    if (results.some((r) => r.error !== null)) {
      // failures other than explicit rate-limit also bound throughput
      break;
    }
    sustainableRps = level; // this concurrency level was handled cleanly
  }

  return { sustainableRps, throttled };
}

/**
 * Probe a single RPC endpoint. Never throws; failures are encoded in the result.
 */
export async function probeRpc(
  rpc: RpcSource,
  expectedChainId: number,
  opts: ProbeOptions,
): Promise<ProbeResult> {
  const base: ProbeResult = {
    url: rpc.url,
    ...(rpc.tracking ? { tracking: rpc.tracking } : {}),
    alive: false,
    chainIdMatch: false,
    latencyMs: null,
    blockNumber: null,
    httpStatus: null,
    errorKind: null,
    rateLimit: null,
  };

  try {
    // 1) Liveness + identity via eth_chainId
    const chainIdRes = await jsonRpcCall(rpc.url, 'eth_chainId', [], opts.timeoutMs);
    base.httpStatus = chainIdRes.status || null;
    if (chainIdRes.error) {
      base.errorKind = chainIdRes.error;
      return base;
    }
    const returnedChainId = hexToNumber(chainIdRes.json?.result);
    base.chainIdMatch = returnedChainId === expectedChainId;
    if (!base.chainIdMatch) {
      base.errorKind = 'wrong_chain';
      return base;
    }
    base.alive = true;

    // 2) Latency via repeated eth_blockNumber
    const latencies: number[] = [];
    let maxBlock: number | null = null;
    for (let i = 0; i < opts.samples; i++) {
      const start = performance.now();
      const res = await jsonRpcCall(rpc.url, 'eth_blockNumber', [], opts.timeoutMs);
      const elapsed = performance.now() - start;
      if (res.error) {
        if (res.error === 'rate_limit') base.errorKind = 'rate_limit';
        continue;
      }
      latencies.push(elapsed);
      const bn = hexToNumber(res.json?.result);
      if (bn !== null && (maxBlock === null || bn > maxBlock)) maxBlock = bn;
    }

    if (latencies.length === 0) {
      // chainId worked but block calls all failed -> not usable
      base.alive = false;
      if (!base.errorKind) base.errorKind = 'rpc_error';
      return base;
    }

    const sorted = [...latencies].sort((a, b) => a - b);
    base.latencyMs = {
      p50: Math.round(percentile(sorted, 50)),
      p95: Math.round(percentile(sorted, 95)),
    };
    base.blockNumber = maxBlock;

    // 3) Rate-limit burst test
    if (opts.burst.enabled) {
      base.rateLimit = await burstTest(rpc.url, opts);
      if (base.rateLimit.throttled && !base.errorKind) base.errorKind = 'rate_limit';
    }

    return base;
  } catch {
    base.alive = false;
    base.errorKind = 'network';
    return base;
  }
}
