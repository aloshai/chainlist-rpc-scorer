import { describe, it, expect, vi, afterEach } from 'vitest';
import { probeRpc, type ProbeOptions } from '../src/prober';

const noBurst: ProbeOptions = {
  samples: 3,
  timeoutMs: 1000,
  burst: { enabled: false, stepSize: 5, maxConcurrency: 10, maxTotalRequests: 100 },
};

interface MockReply {
  status?: number;
  body?: unknown;
  reject?: unknown;
}

/** Mock global fetch; handler receives the JSON-RPC method and 1-based call index. */
function mockFetch(handler: (method: string, call: number) => MockReply) {
  let call = 0;
  const fn = vi.fn(async (_url: string, init: any) => {
    call += 1;
    const parsed = JSON.parse(init.body);
    const r = handler(parsed.method, call);
    if (r.reject) throw r.reject;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeRpc', () => {
  it('marks a healthy RPC alive with latency and block number', async () => {
    mockFetch((method) =>
      method === 'eth_chainId' ? { body: { result: '0x1' } } : { body: { result: '0x10' } },
    );
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.alive).toBe(true);
    expect(result.chainIdMatch).toBe(true);
    expect(result.blockNumber).toBe(16);
    expect(result.latencyMs).not.toBeNull();
    expect(result.errorKind).toBeNull();
  });

  it('detects chain ID mismatch and marks not alive', async () => {
    mockFetch(() => ({ body: { result: '0x89' } })); // 137, but we expect 1
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.chainIdMatch).toBe(false);
    expect(result.alive).toBe(false);
    expect(result.errorKind).toBe('wrong_chain');
  });

  it('classifies HTTP 429 as rate_limit', async () => {
    mockFetch(() => ({ status: 429 }));
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.errorKind).toBe('rate_limit');
    expect(result.alive).toBe(false);
  });

  it('classifies an aborted request as timeout', async () => {
    mockFetch(() => ({ reject: Object.assign(new Error('aborted'), { name: 'AbortError' }) }));
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.errorKind).toBe('timeout');
    expect(result.alive).toBe(false);
  });

  it('classifies a JSON-RPC error message as rpc_error', async () => {
    mockFetch((method) =>
      method === 'eth_chainId'
        ? { body: { result: '0x1' } }
        : { body: { error: { code: -32000, message: 'internal error' } } },
    );
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    // chainId ok but all block calls error out -> not usable
    expect(result.alive).toBe(false);
    expect(result.errorKind).toBe('rpc_error');
  });

  it('flags throttling during the burst test', async () => {
    const opts: ProbeOptions = {
      samples: 2,
      timeoutMs: 1000,
      burst: { enabled: true, stepSize: 5, maxConcurrency: 5, maxTotalRequests: 100 },
    };
    // call 1 = chainId, calls 2-3 = latency, calls >=4 = burst -> 429
    mockFetch((method, call) => {
      if (method === 'eth_chainId') return { body: { result: '0x1' } };
      if (call <= 3) return { body: { result: '0x10' } };
      return { status: 429 };
    });
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, opts);
    expect(result.alive).toBe(true);
    expect(result.rateLimit?.throttled).toBe(true);
    expect(result.errorKind).toBe('rate_limit');
  });
});
