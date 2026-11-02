import { describe, expect, it } from 'vitest';
import { routeDataStatus } from './ConsoleDataNotice';

describe('console route source audit', () => {
  it('labels live public surfaces while identifying recorded drill evidence', () => {
    expect(routeDataStatus('/live')).toMatchObject({ label: 'LIVE' });
    expect(routeDataStatus('/v3')).toMatchObject({ label: 'LIVE' });
    expect(routeDataStatus('/v3')?.detail).toContain('published bundles');
  });

  it('keeps recorded health and topology distinct from live telemetry', () => {
    expect(routeDataStatus('/overview')?.detail).toBe('Health and topology are recorded snapshots, not live telemetry.');
  });

  it('keeps replay copy concise while retaining unavailable action status', () => {
    expect(routeDataStatus('/lab')).toMatchObject({ label: 'REPLAY', detail: 'Recorded drill evidence.', unavailable: 'Fault execution unavailable in demo.' });
  });

  it('labels snapshot-driven routes as replay data', () => {
    for (const route of ['/overview', '/networks', '/validators', '/lab', '/scenarios', '/incidents', '/deployments', '/settings', '/create']) {
      expect(routeDataStatus(route)?.label, route).toBe('REPLAY');
    }
  });

  it('marks unsupported hosted actions plainly', () => {
    for (const route of ['/networks', '/lab', '/scenarios', '/incidents', '/deployments', '/settings', '/create', '/v3']) {
      expect(routeDataStatus(route)?.unavailable, route).toContain('not implemented');
    }
  });

  it('does not claim an unknown route is audited', () => {
    expect(routeDataStatus('/not-a-console-route')).toBeNull();
  });
});
