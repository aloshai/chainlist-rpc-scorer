import { describe, it, expect, vi, afterEach } from 'vitest';
import { probeRpc, type ProbeOptions } from '../src/prober';

const noBurst: ProbeOptions = {
  samples: 3,
  timeoutMs: 1000,
  burst: { enabled: false, stepSize: 5, maxConcurrency: 10, maxTotalRequests: 100 },
};

function withBurst(over: Partial<ProbeOptions['burst']> = {}, samples = 2): ProbeOptions {
  return {
    samples,
    timeoutMs: 1000,
    burst: {
      enabled: true,
      stepSize: 5,
      maxConcurrency: 10,
      maxTotalRequests: 100,
      ...over,
    },
  };
}

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

/** Drive performance.now() through a scripted sequence (2 calls per latency sample). */
function scriptPerfNow(values: number[]) {
  let i = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => values[i++] ?? 0);
}

const ok = (chainHex = '0x1', blockHex = '0x10') => (method: string) =>
  method === 'eth_chainId' ? { body: { result: chainHex } } : { body: { result: blockHex } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('liveness & identity', () => {
  it('marks a healthy RPC alive with latency and block number', async () => {
    mockFetch(ok());
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.alive).toBe(true);
    expect(result.chainIdMatch).toBe(true);
    expect(result.blockNumber).toBe(16);
    expect(result.latencyMs).not.toBeNull();
    expect(result.errorKind).toBeNull();
    expect(result.httpStatus).toBe(200);
  });

  it('detects chain ID mismatch and marks not alive', async () => {
    mockFetch(() => ({ body: { result: '0x89' } })); // 137, expected 1
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.chainIdMatch).toBe(false);
    expect(result.alive).toBe(false);
    expect(result.errorKind).toBe('wrong_chain');
  });

  it('treats a malformed (non-hex) chain ID as wrong_chain', async () => {
    mockFetch((method) =>
      method === 'eth_chainId' ? { body: { result: null } } : { body: { result: '0x10' } },
    );
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.chainIdMatch).toBe(false);
    expect(result.errorKind).toBe('wrong_chain');
  });

  it('preserves the tracking field on the result', async () => {
    mockFetch(ok());
    const result = await probeRpc(
      { url: 'https://rpc.example.com', tracking: 'none' },
      1,
      noBurst,
    );
    expect(result.tracking).toBe('none');
  });
});

describe('error classification', () => {
  it('classifies HTTP 429 as rate_limit', async () => {
    mockFetch(() => ({ status: 429 }));
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.errorKind).toBe('rate_limit');
    expect(result.alive).toBe(false);
    expect(result.httpStatus).toBe(429);
  });

  it('classifies a non-429 HTTP error (503) as network', async () => {
    mockFetch(() => ({ status: 503 }));
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.errorKind).toBe('network');
    expect(result.alive).toBe(false);
  });

  it('classifies an aborted request as timeout', async () => {
    mockFetch(() => ({ reject: Object.assign(new Error('aborted'), { name: 'AbortError' }) }));
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.errorKind).toBe('timeout');
    expect(result.alive).toBe(false);
  });

  it('classifies a generic fetch rejection as network', async () => {
    mockFetch(() => ({ reject: new Error('ECONNRESET') }));
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.errorKind).toBe('network');
  });

  it('classifies a plain JSON-RPC error as rpc_error', async () => {
    mockFetch((method) =>
      method === 'eth_chainId'
        ? { body: { result: '0x1' } }
        : { body: { error: { code: -32000, message: 'internal error' } } },
    );
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.alive).toBe(false);
    expect(result.errorKind).toBe('rpc_error');
  });

  it('classifies a quota-style JSON-RPC error message as rate_limit', async () => {
    mockFetch(() => ({
      body: { error: { code: -32005, message: 'daily request limit exceeded' } },
    }));
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.errorKind).toBe('rate_limit'); // detected on the eth_chainId call
    expect(result.alive).toBe(false);
  });
});

describe('latency & block sampling', () => {
  it('computes p50 and p95 from sampled latencies', async () => {
    mockFetch(ok());
    // 3 samples -> sorted [50, 100, 150]; p50 idx=1 ->100, p95 idx=2 ->150
    scriptPerfNow([0, 100, 0, 50, 0, 150]);
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.latencyMs).toEqual({ p50: 100, p95: 150 });
  });

  it('reports the highest block seen across samples', async () => {
    mockFetch((method, call) => {
      if (method === 'eth_chainId') return { body: { result: '0x1' } };
      const blocks = ['0x10', '0x12', '0x11']; // 16, 18, 17 across calls 2,3,4
      return { body: { result: blocks[call - 2] } };
    });
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.blockNumber).toBe(18);
  });

  it('stays alive when only some latency samples fail', async () => {
    // chainId ok; first block ok, the rest time out
    mockFetch((method, call) => {
      if (method === 'eth_chainId') return { body: { result: '0x1' } };
      if (call === 2) return { body: { result: '0x10' } };
      return { reject: Object.assign(new Error('aborted'), { name: 'AbortError' }) };
    });
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.alive).toBe(true);
    expect(result.latencyMs).not.toBeNull();
    expect(result.blockNumber).toBe(16);
    expect(result.errorKind).toBeNull(); // timeouts mid-loop don't override
  });

  it('flags rate_limit seen mid-latency-loop while staying alive', async () => {
    mockFetch((method, call) => {
      if (method === 'eth_chainId') return { body: { result: '0x1' } };
      if (call === 2) return { body: { result: '0x10' } };
      return { status: 429 };
    });
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.alive).toBe(true);
    expect(result.errorKind).toBe('rate_limit');
  });

  it('marks not alive when chainId works but every block call fails', async () => {
    mockFetch((method) =>
      method === 'eth_chainId' ? { body: { result: '0x1' } } : { status: 503 },
    );
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.alive).toBe(false);
    expect(result.errorKind).toBe('rpc_error');
  });
});

describe('burst / rate-limit test', () => {
  it('is skipped when burst is disabled', async () => {
    mockFetch(ok());
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, noBurst);
    expect(result.rateLimit).toBeNull();
  });

  it('reports sustainableRps up to maxConcurrency when never throttled', async () => {
    mockFetch(ok());
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, withBurst());
    expect(result.rateLimit).toEqual({ sustainableRps: 10, throttled: false });
    expect(result.errorKind).toBeNull();
  });

  it('flags throttling and breaks at the throttled level', async () => {
    // chainId + 2 latency calls succeed; burst (call >=4) returns 429
    mockFetch((method, call) => {
      if (method === 'eth_chainId') return { body: { result: '0x1' } };
      if (call <= 3) return { body: { result: '0x10' } };
      return { status: 429 };
    });
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, withBurst());
    expect(result.rateLimit?.throttled).toBe(true);
    expect(result.rateLimit?.sustainableRps).toBe(0); // throttled on the first burst level
    expect(result.errorKind).toBe('rate_limit');
  });

  it('stops ramping once maxTotalRequests is reached', async () => {
    mockFetch(ok());
    // levels 5 (total 5) then 10 (total 15 > 12) -> stop after level 5
    const result = await probeRpc(
      { url: 'https://rpc.example.com' },
      1,
      withBurst({ maxConcurrency: 40, maxTotalRequests: 12 }),
    );
    expect(result.rateLimit).toEqual({ sustainableRps: 5, throttled: false });
  });

  it('stops ramping on a non-rate-limit failure without flagging throttled', async () => {
    // first burst level (call >=4) errors with 503 -> break, not throttled
    mockFetch((method, call) => {
      if (method === 'eth_chainId') return { body: { result: '0x1' } };
      if (call <= 3) return { body: { result: '0x10' } };
      return { status: 503 };
    });
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, withBurst());
    expect(result.rateLimit).toEqual({ sustainableRps: 0, throttled: false });
  });

  it('never throws — burst errors are contained in the result', async () => {
    mockFetch((method, call) => {
      if (method === 'eth_chainId') return { body: { result: '0x1' } };
      if (call <= 3) return { body: { result: '0x10' } };
      return { reject: new Error('boom') };
    });
    const result = await probeRpc({ url: 'https://rpc.example.com' }, 1, withBurst());
    expect(result.alive).toBe(true);
    expect(result.rateLimit?.throttled).toBe(false);
  });
});
