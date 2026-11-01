import { describe, expect, it, vi } from 'vitest';
import { getDispatchedRun, requestDrill } from './drillWorkflow';

describe('drill workflow client', () => {
  it('posts a dispatch request and retains its status polling timestamp', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      message: 'GitHub accepted the workflow dispatch.',
      since: '2026-10-29T10:00:00.000Z',
      run: null,
    }), { status: 202, headers: { 'content-type': 'application/json' } }));
    const result = await requestDrill('/api/drill', fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ since: '2026-10-29T10:00:00.000Z', run: null, message: 'GitHub accepted the workflow dispatch.' });
    expect(fetchImpl).toHaveBeenCalledWith('/api/drill', expect.objectContaining({ method: 'POST' }));
  });

  it('returns real workflow state and url from the status endpoint', async () => {
    const run = { id: 123, status: 'in_progress', conclusion: null, html_url: 'https://github.com/Shaydez-Defi/kaizen/actions/runs/123', created_at: '2026-10-29T10:00:01.000Z' };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ run }), { status: 200 }));
    await expect(getDispatchedRun('2026-10-29T10:00:00.000Z', fetchImpl as unknown as typeof fetch)).resolves.toEqual(run);
    expect(fetchImpl).toHaveBeenCalledWith('/api/drill?since=2026-10-29T10%3A00%3A00.000Z', expect.objectContaining({ method: 'GET', cache: 'no-store' }));
  });

  it('does not label an HTTP error as a successful dispatch', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'token missing' }), { status: 503 }));
    await expect(requestDrill('/api/drill', fetchImpl as unknown as typeof fetch)).rejects.toThrow('token missing');
  });
});
