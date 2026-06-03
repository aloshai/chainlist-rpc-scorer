# Chainlist RPC Scorer

A **data-only** project that scores and ranks blockchain RPC endpoints. A GitHub
Actions cron job fetches the RPC list from [Chainlist](https://chainlist.org),
actively probes each endpoint, scores it, and commits the result as JSON into
this repository. There is **no server and no database** — consumers read the
JSON directly.

## Consuming the data

Each monitored chain has a ranked file (best RPC first):

```
https://raw.githubusercontent.com/<owner>/chainlist-rpc-scorer/main/data/chains/<chainId>.json
```

Example — best Ethereum RPC right now:

```bash
curl -s .../data/chains/1.json | jq '.rpcs[0]'
```

`data/index.json` lists all monitored chains with summary counts.

### Output shape

`data/chains/1.json`:

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
      "subScores": { "latency": 95, "freshness": 100, "rateLimit": 80 },
      "errorKind": null
    }
  ]
}
```

## How scoring works

Each RPC is probed every run (no history is kept — each run is a fresh snapshot):

| Metric | Measurement |
|--------|-------------|
| **Liveness** | `eth_chainId` + `eth_blockNumber` succeed and the returned chain ID matches. A failed gate means score `0`. |
| **Latency** | Repeated `eth_blockNumber` calls → median (p50) + p95. |
| **Block freshness** | Returned block vs. the max block across that chain's RPCs → `blockLag`. |
| **Rate limit** | An aggressive burst test ramps concurrency until throttled (HTTP 429 / quota errors). |

Composite score (0–100) = weighted sum of latency (40%), freshness (30%), and
rate-limit (30%) sub-scores. Weights and thresholds live in
[`src/config.ts`](src/config.ts).

> Note: latency / rate-limit are measured from GitHub-hosted runners (a single
> network vantage point), so they reflect relative ranking rather than absolute
> performance from your own location.

## Configuration

Edit [`src/config.ts`](src/config.ts):

- `chains` — chain IDs to monitor.
- `weights` — scoring weights.
- `probe` / `burst` — sampling, timeouts, concurrency, and burst-test caps.
- `scoring` — latency/freshness/rate-limit thresholds.

## Running locally

```bash
npm ci
npm run probe       # fetch, probe, score, write data/
npm test            # unit tests
npm run typecheck   # tsc --noEmit
```

## Architecture

A pure core (`source → prober → scorer → output`) invoked by a thin CLI
(`src/index.ts`) and the GitHub Actions workflow. The core has no dependency on
the run surface, so it could later be wrapped by an HTTP service without changes.

See [`docs/superpowers/specs/`](docs/superpowers/specs/) for the design spec.
