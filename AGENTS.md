# AGENTS.md

Guidance for AI agents and contributors working in this repository.

## What this project is

A **data-only** pipeline. It fetches the RPC list from Chainlist, actively probes
each endpoint, scores it 0–100, and commits ranked JSON into `data/`. A GitHub
Actions cron is the only runtime — there is **no server, no database, no API**.
Consumers read the committed JSON directly via `raw.githubusercontent.com`.

Each run is an independent snapshot. **No historical/rolling state is kept** by
design (git history is the only time series). Do not add a DB or persistence
layer unless the project goal explicitly changes.

## Commit rules (important)

- Commits MUST be authored **only under the repository owner's git profile**
  (`aloshai`). The CI workflow already sets this via `github.repository_owner`.
- **Never** add AI/Claude attribution: no `Co-Authored-By` trailers, no
  "Generated with …" footers, no AI-generated-content notices in messages.
- Keep commit messages plain and descriptive of the change only.

## Architecture

A pure core invoked by a thin CLI and the Actions workflow:

```
config → source → prober → scorer → output
                    (run.ts orchestrates; index.ts is the CLI entry)
```

| File | Responsibility | Purity |
|------|----------------|--------|
| `src/config.ts` | Chains, weights, probe/burst/scoring tunables | data |
| `src/source.ts` | Fetch Chainlist, filter to configured chains, clean URLs | `parseChainSources` is pure; `fetchChainSources` does I/O |
| `src/prober.ts` | Probe one RPC → `ProbeResult`. Never throws. | I/O (fetch) only; no scoring |
| `src/scorer.ts` | `ProbeResult` + chain max block → `ScoredRpc`. | **pure** |
| `src/output.ts` | `rankRpcs` (pure, privacy tie-break) + `writeOutputs` (filesystem) | mixed |
| `src/run.ts` | Orchestrator: `run(deps)` with injected I/O + `probeAndScoreChain`. Probes chains and RPCs with bounded concurrency; preserves old data if Chainlist is down. | dependency-injected, testable |
| `src/index.ts` | Thin CLI entry: wires real deps into `run` | I/O |
| `src/types.ts` | Shared types | — |

**Keep `prober` and `scorer` free of any dependency on the run surface** (no
filesystem, no config import in `scorer` beyond the `Weights` type). That
separation is what would let the core be wrapped by an HTTP service later.

## How scoring works

- **Liveness is a gate.** `alive === false` or `chainIdMatch === false` → score 0,
  sorted to the bottom.
- Composite = `0.40·latency + 0.30·freshness + 0.30·rateLimit` (each sub-score
  0–100). Weights live in `config.weights`.
- `blockLag` is computed by the **scorer** (it needs the chain-wide max block),
  not the prober.
- Missing burst data → rate-limit sub-score is a neutral `50`.
- Ranking (`rankRpcs`) sorts by score desc, then breaks ties by Chainlist
  `tracking` privacy (`none` > `limited` > `yes` > unknown). The tie-break does
  **not** change the composite score, only ordering among equal scores.

## Conventions & gotchas

- **TypeScript ESM.** `package.json` has `"type": "module"`. tsconfig uses
  `module: ESNext` + `moduleResolution: Bundler`, so imports are **extensionless**
  (`import { x } from './scorer'`, not `./scorer.js`).
- **Runner:** `tsx` (no build step). Run scripts via `npm run probe` / `vitest`.
- Top-level `await` only works inside the project's ESM module graph. Throwaway
  scripts must live in the repo (e.g. `*.mts`) or be wrapped in an async IIFE.
- `data/` is **generated output** — do not hand-edit; the Action overwrites it.
- Probing must stay polite: burst testing is bounded by `config.burst`
  (`maxConcurrency`, `maxTotalRequests`). Don't remove these caps.
- Skip non-`https` URLs and key-templated URLs (`${...}`) in `source.ts` — they
  can't be probed anonymously.

## Adding / changing things

- **Add a chain:** add its ID to `config.chains`. The name comes from Chainlist.
- **Re-tune scoring:** edit `config.weights` / `config.scoring`. Update the
  scorer tests to match new thresholds.
- **Change cadence:** edit the cron in `.github/workflows/probe.yml`.

## Testing

- Run `npm test` (vitest) and `npm run typecheck` before committing.
- The pure units (`scorer`, `parseChainSources`, `rankRpcs`) are tested directly.
- `prober` is tested with a mocked global `fetch` (see `test/prober.test.ts` for
  the mock pattern: handler keyed by JSON-RPC method + call index).
- Any change to scoring math or probe classification MUST come with a matching
  test update.

## Definition of done for a change

1. `npm run typecheck` clean.
2. `npm test` green.
3. New/changed behavior covered by a test.
4. Commit authored under the owner profile, no AI attribution.
