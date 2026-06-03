# Chainlist RPC Scorer — Design Spec

**Date:** 2026-06-03
**Status:** Approved

## Purpose

A **data-only** project whose sole job is to produce a scored, ranked list of RPC
endpoints per blockchain. A GitHub Actions cron job periodically fetches the RPC
list from Chainlist, actively probes each endpoint, scores it, and commits the
result as JSON files into the repository. Consumers read the JSON directly from
`raw.githubusercontent.com` (or GitHub Pages). There is **no running server and
no database.**

Only an instantaneous snapshot is produced on each run — no historical
performance / rolling aggregates are kept. (Git history itself remains a free
per-commit time series for anyone who wants to mine it later.)

## Non-Goals (YAGNI)

- No database, no long-running server, no HTTP API.
- No historical / rolling-window aggregates (uptime-over-time, p95 trend).
- No multi-region probing (single vantage point = GitHub-hosted runner).
- No auth / user management — all output data is public.

The door is intentionally left open: the core (Source → Prober → Scorer) is kept
pure and side-effect-free (network calls aside), so a future live HTTP service
could wrap the same core without rewriting it.

## Architecture

A single pure core, invoked by a thin GitHub Actions wrapper.

```
config (monitored chain IDs + weights)
        │
        ▼
1. Source Adapter ──▶ fetch Chainlist rpcs.json, filter to configured chains,
        │              collect RPC URLs per chain
        ▼
2. Prober ──────────▶ apply probe set to each RPC → ProbeResult  (fetch-based)
        │
        ▼
3. Scorer ──────────▶ ProbeResult → 0-100 composite score + sub-scores  (pure)
        │
        ▼
4. Output Writer ───▶ write JSON files sorted by score
        │
        ▼
5. GitHub Actions ──▶ cron triggers run, commits changed data/ files
```

### Component responsibilities

Each component has one purpose, a well-defined interface, and is independently
testable.

| # | Component | Responsibility | Depends on |
|---|-----------|----------------|------------|
| 1 | **Source Adapter** | Fetch Chainlist `rpcs.json`, filter to configured chain IDs, return `{ chainId, name, rpcUrls[] }` | Chainlist API |
| 2 | **Prober** | Run the probe set against a single RPC URL, return a raw `ProbeResult`. No scoring, no I/O beyond `fetch`. | — |
| 3 | **Scorer** | Convert a `ProbeResult` (plus the chain's max block, for lag) into a 0-100 composite score + per-metric sub-scores. Pure function. | — |
| 4 | **Output Writer** | Serialize ranked results into `data/index.json` and `data/chains/<id>.json`, sorted by score desc. | filesystem |
| 5 | **Scheduler (GitHub Actions)** | Cron + manual trigger; runs the CLI entry, commits changed `data/`. | 1–4 |

## Technology

- **Node.js + TypeScript**, executed with `tsx` (no build step needed in CI).
- Minimal dependencies: native `fetch`; `p-limit` for concurrency control.
  No DB driver, no web framework.
- A CLI entry point (`npm run probe`) is the single way to run the pipeline —
  used both by GitHub Actions and for local manual runs.
- Unit tests via `vitest` (Prober/Scorer are pure → easy to test).

## Configuration

A `config.ts` (or `config.json`) holding:

- `chains`: list of monitored chain IDs (popular/active set by default —
  Ethereum 1, BSC 56, Polygon 137, Arbitrum 42161, Optimism 10, Base 8453,
  Avalanche 43114, etc.). Extendable by editing the list.
- `weights`: scoring weights (`latency`, `freshness`, `rateLimit`). Defaults
  below.
- `probe`: tunables — `samples` (latency request count, default 5),
  `timeoutMs` (default 5000), per-RPC `concurrency`.
- `burst`: rate-limit test tunables — `maxConcurrency` ceiling, `stepSize`,
  total time/request cap (to bound Actions minutes and stay polite).

## Probed Metrics (single run, no history)

| Metric | How it is measured |
|--------|--------------------|
| **Liveness** | `eth_chainId` + `eth_blockNumber` succeed; returned chainId matches the expected chain (filters spoofed/wrong RPCs). |
| **Latency** | N (default 5) sequential `eth_blockNumber` calls → **median (p50) + p95** response time. |
| **Block freshness** | Returned block height vs. the **max block** seen across all of that chain's probed RPCs → `blockLag` (in blocks). |
| **Rate limit** | Aggressive burst test: increasing parallelism until throttle/HTTP 429/quota error appears → **sustainable ~RPS** + `throttled` flag. Bounded by `burst` config caps. |

### ProbeResult shape (Prober output)

```ts
interface ProbeResult {
  url: string;
  alive: boolean;          // liveness gate passed
  chainIdMatch: boolean;   // returned chainId == expected
  latencyMs: { p50: number; p95: number } | null;
  blockNumber: number | null;
  httpStatus: number | null;
  errorKind: 'timeout' | 'rate_limit' | 'rpc_error' | 'sync' | 'wrong_chain' | null;
  rateLimit: { sustainableRps: number; throttled: boolean } | null;
}
```

`blockLag` is computed by the Scorer (needs the chain-wide max block), not the
Prober.

## Scoring (0–100 composite)

**Liveness is a gate.** If `alive === false` or `chainIdMatch === false`, the RPC
gets **score 0** and is marked `alive: false` / sorted to the bottom (or flagged
`dead`).

For live RPCs, composite = weighted sum of sub-scores (each 0–100). Default
weights:

- **Latency — 40%**: lower p50 → higher score. Mapping: `<=100ms → 100`,
  `>=2000ms → 0`, log/linear interpolation between.
- **Freshness — 30%**: `blockLag === 0 → 100`; score decreases as lag grows;
  beyond a configurable threshold (e.g. > 10 blocks) → heavy penalty toward 0.
- **Rate limit — 30%**: higher `sustainableRps` → higher score; early throttle →
  low score.

Weights are configurable. Output always includes the sub-score breakdown for
transparency.

## Output File Structure (`data/` in repo)

```
data/
  index.json            # monitored chains + summary + last-updated timestamp
  chains/
    1.json              # Ethereum — RPCs sorted by score desc
    56.json             # BSC
    137.json            # Polygon ...
```

`data/chains/<id>.json`:

```json
{
  "chainId": 1,
  "name": "Ethereum Mainnet",
  "updatedAt": "2026-06-03T12:00:00Z",
  "rpcs": [
    {
      "url": "https://...",
      "score": 92.4,
      "alive": true,
      "latencyMs": { "p50": 88, "p95": 140 },
      "blockLag": 0,
      "rateLimit": { "sustainableRps": 25, "throttled": false },
      "subScores": { "latency": 95, "freshness": 100, "rateLimit": 80 }
    }
  ]
}
```

`data/index.json`:

```json
{
  "updatedAt": "2026-06-03T12:00:00Z",
  "chains": [
    { "chainId": 1, "name": "Ethereum Mainnet", "rpcCount": 30, "aliveCount": 24, "file": "chains/1.json" }
  ]
}
```

Consumer usage:
`https://raw.githubusercontent.com/<user>/chainlist-rpc-scorer/main/data/chains/1.json`
(GitHub Pages can be enabled later as an optional nicer surface.)

## GitHub Actions Workflow

- Triggers: `schedule` cron (default every 30 min — tolerant of GitHub cron
  delay/jitter) + `workflow_dispatch` (manual).
- Steps: checkout → setup-node → `npm ci` → `npm run probe` →
  commit & push changed `data/`.
- Commits are authored solely under the repository owner's git profile — **no
  AI/Claude attribution** in commit messages or trailers.
- Burst-test intensity is bounded by `burst` config to limit Actions minutes and
  stay polite to public endpoints.

## Error Handling

- Each RPC is probed inside its own `try/catch`; one failing endpoint never
  affects others. Failures surface as `errorKind` on the `ProbeResult` and
  drive the score down (or the liveness gate to 0).
- If Chainlist itself is unreachable: keep the previous `data/` and do **not**
  fail the run (stale data beats no data). Log a warning.
- Network timeouts honored via `AbortController` + `timeoutMs`.

## Testing

- **Scorer** (pure): feed synthetic `ProbeResult`s → assert expected composite +
  sub-scores, including the liveness gate (dead → 0) and weight application.
- **Prober** (fetch mocked): assert correct JSON-RPC parsing, latency
  aggregation (p50/p95), error-kind classification, chainId mismatch detection.
- **Source Adapter**: a checked-in sample `rpcs.json` fixture → assert filtering
  to configured chains and URL extraction.
- **Output Writer**: assert file shape and score-descending ordering.

## Repository Layout (proposed)

```
chainlist-rpc-scorer/
  src/
    config.ts
    source.ts          # Source Adapter
    prober.ts          # Prober
    scorer.ts          # Scorer
    output.ts          # Output Writer
    index.ts           # CLI entry: orchestrates 1→4
    types.ts
  test/
    scorer.test.ts
    prober.test.ts
    source.test.ts
    fixtures/rpcs.sample.json
  data/                # generated output (committed by Actions)
  .github/workflows/probe.yml
  docs/superpowers/specs/2026-06-03-chainlist-rpc-scorer-design.md
  package.json
  tsconfig.json
  README.md
```
