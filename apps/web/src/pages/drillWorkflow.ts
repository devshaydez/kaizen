export interface DrillRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
}

interface DrillApiResponse {
  message?: string;
  since?: string;
  run?: DrillRun | null;
  error?: string;
}

async function readJson(response: Response): Promise<DrillApiResponse> {
  const body = await response.json().catch(() => ({})) as DrillApiResponse;
  if (!response.ok) throw new Error(body.message ?? body.error ?? `Drill API failed (HTTP ${response.status})`);
  return body;
}

export async function requestDrill(endpoint: string, fetchImpl: typeof fetch = fetch): Promise<{ since: string; run: DrillRun | null; message: string }> {
  const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const body = await readJson(response);
  const since = body.since;
  if (!since) throw new Error('Dispatch accepted without a workflow status timestamp.');
  return { since, run: body.run ?? null, message: body.message ?? 'Dispatch accepted; waiting for GitHub Actions status.' };
}

export async function getDispatchedRun(since: string, fetchImpl: typeof fetch = fetch): Promise<DrillRun | null> {
  const response = await fetchImpl(`/api/drill?since=${encodeURIComponent(since)}`, { method: 'GET', cache: 'no-store' });
  const body = await readJson(response);
  return body.run ?? null;
}
