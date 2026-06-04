export interface Weights {
  latency: number;
  freshness: number;
  rateLimit: number;
}

export interface Config {
  /** Source of truth for chain + RPC lists. */
  chainlistUrl: string;
  /** Chain IDs to monitor (popular/active set by default). */
  chains: number[];
  weights: Weights;
  probe: {
    /** Number of latency samples per RPC. */
    samples: number;
    timeoutMs: number;
    /** Max RPCs probed in parallel within a single chain. */
    perChainConcurrency: number;
  };
  burst: {
    enabled: boolean;
    /** Concurrency increment per burst step. */
    stepSize: number;
    /** Upper bound on burst concurrency. */
    maxConcurrency: number;
    /** Hard cap on total requests across all burst steps (politeness + Actions minutes). */
    maxTotalRequests: number;
  };
  scoring: {
    latencyBestMs: number; // p50 <= this -> latency score 100
    latencyWorstMs: number; // p50 >= this -> latency score 0
    freshnessMaxLag: number; // block lag >= this -> freshness score 0
    rateLimitTargetRps: number; // sustainableRps >= this -> rate-limit score 100
  };
  /** Directory (relative to repo root) where JSON output is written. */
  outputDir: string;
}

export const config: Config = {
  chainlistUrl: process.env.CHAINLIST_URL ?? 'https://chainlist.org/rpcs.json',
  chains: [
    // Mainnets: Ethereum, BSC, Polygon, Arbitrum One, Optimism, Base, Avalanche C, Fantom, Gnosis, Cronos
    1, 56, 137, 42161, 10, 8453, 43114, 250, 100, 25,
    // Testnets: ETH Sepolia, ETH Holesky, BSC Testnet, Polygon Amoy, Arbitrum Sepolia,
    // OP Sepolia, Base Sepolia, Avalanche Fuji, Fantom Testnet, Gnosis Chiado, Cronos Testnet
    11155111, 17000, 97, 80002, 421614, 11155420, 84532, 43113, 4002, 10200, 338,
  ],
  weights: { latency: 0.4, freshness: 0.3, rateLimit: 0.3 },
  probe: {
    samples: 5,
    timeoutMs: 5000,
    perChainConcurrency: 8,
  },
  burst: {
    enabled: true,
    stepSize: 5,
    maxConcurrency: 40,
    maxTotalRequests: 200,
  },
  scoring: {
    latencyBestMs: 100,
    latencyWorstMs: 2000,
    freshnessMaxLag: 10,
    rateLimitTargetRps: 30,
  },
  outputDir: 'data',
};
