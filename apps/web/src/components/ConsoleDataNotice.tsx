import type { JSX } from 'react';
import { REPLAY } from '../lib/mode';

export interface RouteDataStatus {
  label: 'LIVE' | 'REPLAY';
  detail: string;
  unavailable?: string;
}

const ROUTES: Record<string, RouteDataStatus> = {
  '/overview': { label: 'REPLAY', detail: 'Published demo-data drills are primary. Committed docs/evidence fixtures are fallback history. Health and topology are recorded, not live node telemetry.' },
  '/networks': { label: 'REPLAY', detail: 'Published drill network snapshots are primary. Committed fixtures are fallback history, not live networks.', unavailable: 'Network creation and control are not implemented in hosted replay.' },
  '/validators': { label: 'REPLAY', detail: 'Published demo-data drills are primary. Committed fixtures are fallback history. Validator status and metrics are recorded snapshots, not live telemetry.' },
  '/lab': { label: 'REPLAY', detail: 'Published drill evidence is primary; committed fixtures are fallback history.', unavailable: 'Fault execution is not implemented in hosted replay.' },
  '/scenarios': { label: 'REPLAY', detail: 'Scenario history uses published drill bundles first, with committed docs/evidence fixtures as recorded history.', unavailable: 'Saving, executing, and replaying scenarios are not implemented in hosted replay.' },
  '/incidents': { label: 'REPLAY', detail: 'Published drill evidence is primary; committed fixtures are fallback history, not live incident monitoring.', unavailable: 'Live incident monitoring is not implemented in hosted replay.' },
  '/deployments': { label: 'REPLAY', detail: 'Published drill bundles are primary; committed fixtures are fallback run evidence.', unavailable: 'Deployment control is not implemented in hosted replay.' },
  '/settings': { label: 'REPLAY', detail: 'Settings are not connected to a live control plane in hosted replay.', unavailable: 'Persisting control-plane settings is not implemented in hosted replay.' },
  '/create': { label: 'REPLAY', detail: 'The hosted console has no live engine attached.', unavailable: 'Network creation is not implemented in hosted replay.' },
  '/v3': { label: 'LIVE', detail: 'V3 endpoint status is queried live. Anchor and run history uses published bundles and committed evidence.', unavailable: 'Submitting new anchors is not implemented in hosted replay.' },
  '/live': { label: 'LIVE', detail: 'The latest published demo-data bundle and Portaldot V3 public monitor are fetched live. Drill evidence itself is recorded.' },
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
    <div className="replaybar" role="note" aria-label={`${status.label} data source`}>
      <b>{status.label} DATA</b>
      <span>{status.detail}</span>
      {status.unavailable && <span><b>NOT IMPLEMENTED:</b> {status.unavailable}</span>}
    </div>
  );
}
