import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPublicMonitor, fetchPublishedAnchor, V3_MONITOR, DEMO_DATA, PUBLIC_MONITOR_POLL_MS } from './publicMonitor';

describe('live public sources', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reads published anchor fields directly from the demo-data bundle', async () => {
    const bundle = { id: 'drill-1', publishedAt: '2026-10-29T00:00:00Z', anchor: { status: 'finalized', txHash: '0xabc', blockNumber: 42, finality: 'finalized', signerAddress: '0xsigner' } };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ drills: [{ id: 'drill-1' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => bundle }));
    const result = await fetchPublishedAnchor();
    expect(fetch).toHaveBeenNthCalledWith(1, `${DEMO_DATA}/index.json`, { cache: 'no-store' });
    expect(fetch).toHaveBeenNthCalledWith(2, `${DEMO_DATA}/drills/drill-1.json`, { cache: 'no-store' });
    expect(result.anchor).toEqual(bundle.anchor);
  });

  it('uses the public V3 monitor for best and finalized heads', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { number: '0x2a' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: '0xfinal' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: { number: '0x28' } }) }));
    const result = await fetchPublicMonitor();
    expect(result.blockNumber).toBe(42);
    expect(result.finalizedNumber).toBe(40);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => url === V3_MONITOR)).toBe(true);
  });

  it('polls the chain monitor every 30 seconds', () => {
    expect(PUBLIC_MONITOR_POLL_MS).toBe(30_000);
  });
});
