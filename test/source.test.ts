import { describe, it, expect } from 'vitest';
import { parseChainSources } from '../src/source';
import sample from './fixtures/rpcs.sample.json';

describe('parseChainSources', () => {
  it('filters to requested chain IDs', () => {
    const result = parseChainSources(sample, [1, 56]);
    expect(result.map((c) => c.chainId).sort()).toEqual([1, 56]);
  });

  it('keeps only https URLs, dedupes, and drops key-templated URLs', () => {
    const [eth] = parseChainSources(sample, [1]);
    expect(eth.rpcs.map((r) => r.url)).toEqual([
      'https://eth.example.com',
      'https://eth2.example.com',
    ]);
  });

  it('preserves tracking metadata from object entries', () => {
    const [eth] = parseChainSources(sample, [1]);
    const tracked = eth.rpcs.find((r) => r.url === 'https://eth2.example.com');
    expect(tracked?.tracking).toBe('none');
  });

  it('skips chains with no usable https RPCs', () => {
    const result = parseChainSources(sample, [999]);
    expect(result).toEqual([]);
  });

  it('skips chain IDs not present in the source', () => {
    const result = parseChainSources(sample, [424242]);
    expect(result).toEqual([]);
  });

  it('throws on non-array input', () => {
    expect(() => parseChainSources({ not: 'an array' }, [1])).toThrow();
  });
});
