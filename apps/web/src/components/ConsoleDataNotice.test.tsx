import { describe, expect, it } from 'vitest';
import { routeDataStatus } from './ConsoleDataNotice';

describe('console route source audit', () => {
  it('labels live public surfaces while identifying recorded drill evidence', () => {
    expect(routeDataStatus('/live')).toMatchObject({ label: 'LIVE' });
    expect(routeDataStatus('/v3')).toMatchObject({ label: 'LIVE' });
    expect(routeDataStatus('/v3')?.detail).toContain('published bundles');
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
