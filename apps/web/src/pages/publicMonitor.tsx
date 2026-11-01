import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';

export const DEMO_DATA = 'https://raw.githubusercontent.com/Shaydez-Defi/kaizen/demo-data';
export const V3_MONITOR = 'https://test-node-v3.portaldot.dev';
export const PUBLIC_MONITOR_POLL_MS = 30_000;

export interface PublishedAnchor {
  status: string;
  reason?: string;
  blockHash?: string;
  blockNumber?: number | null;
  txHash?: string | null;
  finality?: string | null;
  signerAddress?: string | null;
}
export interface PublicMonitor { blockNumber: number; finalizedNumber: number; finalizedHash: string; sampledAt: string }
interface DemoIndex { drills: { id: string; publishedAt: string; anchor: { status: string; blockNumber: number | null } }[] }
interface DemoBundle { id: string; publishedAt: string; anchor: PublishedAnchor }

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(V3_MONITOR, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!response.ok) throw new Error(`V3 monitor HTTP ${response.status}`);
  const body = await response.json() as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'V3 monitor RPC failed');
  return body.result;
}
export async function fetchPublicMonitor(): Promise<PublicMonitor> {
  const [bestHeader, finalizedHash] = await Promise.all([rpc('chain_getHeader'), rpc('chain_getFinalizedHead')]);
  if (typeof bestHeader !== 'object' || bestHeader === null || typeof finalizedHash !== 'string') throw new Error('V3 monitor returned an invalid head');
  const finalizedHeader = await rpc('chain_getHeader', [finalizedHash]) as { number?: string } | null;
  const best = bestHeader as { number?: string };
  if (!best.number || !finalizedHeader?.number) throw new Error('V3 monitor did not return block heights');
  return { blockNumber: Number.parseInt(best.number, 16), finalizedNumber: Number.parseInt(finalizedHeader.number, 16), finalizedHash, sampledAt: new Date().toISOString() };
}
export async function fetchPublishedAnchor(): Promise<{ bundle: DemoBundle; anchor: PublishedAnchor }> {
  const indexResponse = await fetch(`${DEMO_DATA}/index.json`, { cache: 'no-store' });
  if (!indexResponse.ok) throw new Error(`Published demo index HTTP ${indexResponse.status}`);
  const index = await indexResponse.json() as DemoIndex;
  const latest = index.drills[0];
  if (!latest) throw new Error('No published drills');
  const bundleResponse = await fetch(`${DEMO_DATA}/drills/${latest.id}.json`, { cache: 'no-store' });
  if (!bundleResponse.ok) throw new Error(`Published drill bundle HTTP ${bundleResponse.status}`);
  const bundle = await bundleResponse.json() as DemoBundle;
  if (!bundle.anchor) throw new Error('Published drill bundle has no anchor evidence');
  return { bundle, anchor: bundle.anchor };
}
export function usePublicMonitor() {
  const [monitor, setMonitor] = useState<PublicMonitor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => { void fetchPublicMonitor().then((value) => { setMonitor(value); setError(null); }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); }, []);
  useEffect(() => { refresh(); const timer = setInterval(refresh, PUBLIC_MONITOR_POLL_MS); return () => clearInterval(timer); }, [refresh]);
  return { monitor, error, refresh };
}
export function PublicMonitorCard(): JSX.Element {
  const { monitor, error } = usePublicMonitor();
  return <section className="glass card" aria-label="Live Portaldot V3 monitor"><div className="lab">Live Portaldot V3 public monitor</div>{monitor ? <div className="sub">Best #{monitor.blockNumber.toLocaleString('en-US')} · finalized #{monitor.finalizedNumber.toLocaleString('en-US')} · sampled {new Date(monitor.sampledAt).toLocaleTimeString()}</div> : <div className="sub">{error ? `Live monitor unavailable: ${error}` : 'Connecting to V3 monitor…'}</div>}</section>;
}
