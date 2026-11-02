import type { JSX } from 'react';
import { REPLAY } from '../lib/mode';

export interface RouteDataStatus {
  label: 'LIVE' | 'REPLAY';
  detail: string;
  unavailable?: string;
}

const ROUTES: Record<string, RouteDataStatus> = {
  '/overview': { label: 'REPLAY', detail: 'Health and topology are recorded snapshots, not live telemetry.' },
  '/networks': { label: 'REPLAY', detail: 'Network snapshots are recorded, not live.', unavailable: 'Network controls unavailable in demo.' },
  '/validators': { label: 'REPLAY', detail: 'Validator health and metrics are recorded snapshots, not live telemetry.' },
  '/lab': { label: 'REPLAY', detail: 'Recorded drill evidence.', unavailable: 'Fault execution unavailable in demo.' },
  '/scenarios': { label: 'REPLAY', detail: 'Scenario history is recorded.', unavailable: 'Scenario controls unavailable in demo.' },
  '/incidents': { label: 'REPLAY', detail: 'Incident evidence is recorded, not live.', unavailable: 'Live incident monitoring unavailable in demo.' },
  '/deployments': { label: 'REPLAY', detail: 'Deployment history is recorded.', unavailable: 'Deployment controls unavailable in demo.' },
  '/settings': { label: 'REPLAY', detail: 'No live control plane is connected.', unavailable: 'Settings cannot be saved in demo.' },
  '/create': { label: 'REPLAY', detail: 'No live engine is attached.', unavailable: 'Network creation unavailable in demo.' },
  '/v3': { label: 'LIVE', detail: 'Endpoint status is live; anchor and run history is recorded.', unavailable: 'New anchors unavailable in demo.' },
  '/live': { label: 'LIVE', detail: 'Public monitor is live; drill evidence is recorded.' },
};

export function routeDataStatus(path: string): RouteDataStatus | null {
  const route = `/${path.split('/')[1] ?? 'overview'}`;
  return ROUTES[route] ?? null;
}

export function ConsoleDataNotice({ path }: { path: string }): JSX.Element | null {
  if (!REPLAY) return null;
  const status = routeDataStatus(path);
  if (!status) return null;
  return (
    <div className="replaybar replaybar--route" role="note" aria-label={`${status.label} data source`}>
      <b>{status.label}</b>
      <span>{status.detail}</span>
      {status.unavailable && <span>{status.unavailable}</span>}
    </div>
  );
}
