export interface RpcSource {
  url: string;
  tracking?: string;
}

export interface ChainSource {
  chainId: number;
  name: string;
  rpcs: RpcSource[];
}

export type ErrorKind =
  | 'timeout'
  | 'rate_limit'
  | 'rpc_error'
  | 'sync'
  | 'wrong_chain'
  | 'network'
  | null;

export interface LatencyStats {
  p50: number;
  p95: number;
}

export interface RateLimitStats {
  /** Highest concurrency level handled without throttling (proxy for sustainable throughput). */
  sustainableRps: number;
  /** True if a 429 / rate-limit error was observed during the burst test. */
  throttled: boolean;
}

/** Raw output of probing a single RPC. No scoring, no cross-RPC context. */
export interface ProbeResult {
  url: string;
  tracking?: string;
  alive: boolean;
  chainIdMatch: boolean;
  latencyMs: LatencyStats | null;
  blockNumber: number | null;
  httpStatus: number | null;
  errorKind: ErrorKind;
  rateLimit: RateLimitStats | null;
}

export interface SubScores {
  latency: number;
  freshness: number;
  rateLimit: number;
}

/** A ProbeResult turned into a 0-100 composite score plus breakdown. */
export interface ScoredRpc {
  url: string;
  tracking?: string;
  score: number;
  alive: boolean;
  latencyMs: LatencyStats | null;
  blockLag: number | null;
  rateLimit: RateLimitStats | null;
  subScores: SubScores;
  errorKind: ErrorKind;
}
