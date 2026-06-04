import { config } from './config';
import { fetchChainSources } from './source';
import { probeRpc } from './prober';
import { writeOutputs } from './output';
import { run } from './run';

// CLI entry point: wire real dependencies and execute one run.
run({
  config,
  fetchSources: fetchChainSources,
  probeFn: probeRpc,
  write: writeOutputs,
  now: () => new Date().toISOString(),
  log: (m) => console.log(`[run] ${m}`),
})
  .then((r) => {
    if (r.ok) {
      console.log(`[run] done: ${r.chains} chains`);
    } else {
      // source-unreachable is non-fatal — previous data is preserved.
      console.warn(`[run] finished without writing (${r.reason})`);
    }
  })
  .catch((e) => {
    console.error('[run] fatal:', e);
    process.exitCode = 1;
  });
