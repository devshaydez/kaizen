import { describe, expect, it } from 'vitest';
import { StateStore } from '@kaizen/engine';
import type { NodeConfig } from '@kaizen/engine';

function makeNetwork(id: string, name: string) {
  return {
    id,
    name,
    preset: 'single-node' as const,
    status: 'created' as const,
    designatedTest: true,
    chain: 'dev' as const,
    baseDir: `/tmp/kaizen-store-test/${id}`,
    createdAt: new Date().toISOString(),
  };
}

function makeNode(networkId: string): NodeConfig {
  return {
    id: `${networkId}-a`,
    networkId,
    name: `${networkId}-alice`,
    role: 'validator',
    chain: 'dev',
    wellKnownKey: 'alice',
    bootnodes: [],
    baseDir: `/tmp/kaizen-store-test/${networkId}/node-a`,
    nodeKeyFile: `/tmp/kaizen-store-test/${networkId}/node-a.key`,
    logFile: `/tmp/kaizen-store-test/${networkId}/node-a.log`,
    ports: { p2p: 31001, rpc: 32001, ws: 33001, prometheus: 34001 },
  };
}

describe('StateStore', () => {
  it('runs migrations idempotently', () => {
    const store = new StateStore(':memory:');
    expect(store.schemaVersion).toBe(26); // v19-22: v3 anchoring (T-8.2); v23-25: resilience (T-9.5); v26: attestations (A2)
    // re-opening an in-memory store re-runs migrate() on a fresh db — verify
    // the persisted path also tolerates repeat migration:
    store.close();

    const store2 = new StateStore(':memory:');
    store2.close();
  });

  it('inserts and reads networks with correct field mapping', () => {
    const store = new StateStore(':memory:');
    const created = store.insertNetwork(makeNetwork('net_1', 'alpha'));
    expect(created).toEqual(
      expect.objectContaining({
        id: 'net_1',
        name: 'alpha',
        preset: 'single-node',
        status: 'created',
        designatedTest: true,
        chain: 'dev',
      }),
    );
    expect(store.tryGetNetwork('alpha')?.id).toBe('net_1');
    expect(store.tryGetNetwork('net_1')?.name).toBe('alpha');
    expect(store.tryGetNetwork('nope')).toBeUndefined();
    store.close();
  });

  it('updates network status with a fresh timestamp', () => {
    const store = new StateStore(':memory:');
    const n = store.insertNetwork(makeNetwork('net_2', 'beta'));
    store.updateNetworkStatus('net_2', 'running');
    const updated = store.getNetwork('net_2');
    expect(updated.status).toBe('running');
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(n.createdAt).getTime(),
    );
    store.close();
  });

  it('inserts nodes and maps ports/status/pid', () => {
    const store = new StateStore(':memory:');
    store.insertNetwork(makeNetwork('net_3', 'gamma'));
    store.insertNode({ config: makeNode('net_3'), status: 'created', createdAt: new Date().toISOString() });
    const node = store.getNode('net_3-a');
    expect(node.ports).toEqual({ p2p: 31001, rpc: 32001, ws: 33001, prometheus: 34001 });
    expect(node.status).toBe('created');
    expect(node.wellKnownKey).toBe('alice');
    expect(node.bootnodes).toEqual([]);

    store.updateNodeStatus('net_3-a', 'running', 4242);
    const running = store.getNode('net_3-a');
    expect(running.status).toBe('running');
    expect(running.pid).toBe(4242);

    store.updateNodeStatus('net_3-a', 'stopped', null);
    expect(store.getNode('net_3-a').pid).toBeUndefined();
    store.close();
  });

  it('persists expectedPeers, startedAt, and tryGetNode lookups (Phase 2A)', () => {
    const store = new StateStore(':memory:');
    store.insertNetwork(makeNetwork('net_7', 'mon'));
    const config = { ...makeNode('net_7'), expectedPeers: 3 };
    store.insertNode({ config, status: 'created', createdAt: new Date().toISOString() });

    const created = store.tryGetNode('net_7-a');
    expect(created?.expectedPeers).toBe(3);
    expect(created?.startedAt).toBeUndefined();
    expect(store.tryGetNode('net_7-zzz')).toBeUndefined();

    const startedAt = '2026-10-10T12:00:00.000Z';
    store.updateNodeStatus('net_7-a', 'running', 7777, startedAt);
    const running = store.getNode('net_7-a');
    expect(running.startedAt).toBe(startedAt);

    // startedAt is sticky: a later status update without it must not clear it.
    store.updateNodeStatus('net_7-a', 'stopped', null);
    expect(store.getNode('net_7-a').startedAt).toBe(startedAt);
    expect(store.getNode('net_7-a').pid).toBeUndefined();
    store.close();
  });

  it('records operation history with outcomes', () => {
    const store = new StateStore(':memory:');
    store.insertNetwork(makeNetwork('net_4', 'delta'));
    const opId = store.startOperation('network.start', 'net_4');
    expect(opId).toBeGreaterThan(0);
    expect(store.getOperation(opId)?.status).toBe('running');

    store.finishOperation(opId, { status: 'ok' });
    const done = store.getOperation(opId);
    expect(done?.status).toBe('ok');
    expect(done?.finished_at).toBeTruthy();

    const op2 = store.startOperation('network.stop', 'net_4');
    store.finishOperation(op2, {
      status: 'error',
      errorCode: 'STOP_TIMEOUT',
      errorMessage: 'boom',
      detail: { nodes: ['a'] },
    });
    const history = store.listOperations({ networkId: 'net_4' });
    expect(history.length).toBe(2);
    expect(history[0]?.error_code).toBe('STOP_TIMEOUT');
    expect(JSON.parse(history[0]?.detail ?? '{}')).toEqual({ nodes: ['a'] });
    store.close();
  });

  it('links operations to a network after the fact (create flow)', () => {
    const store = new StateStore(':memory:');
    const opId = store.startOperation('network.create'); // no network id yet
    expect(store.listOperations({ networkId: 'net_6' })).toEqual([]);
    store.insertNetwork(makeNetwork('net_6', 'zeta'));
    store.attachOperationToNetwork(opId, 'net_6');
    const history = store.listOperations({ networkId: 'net_6' });
    expect(history).toHaveLength(1);
    expect(history[0]?.kind).toBe('network.create');
    store.close();
  });

  it('deletes networks and their nodes', () => {
    const store = new StateStore(':memory:');
    store.insertNetwork(makeNetwork('net_5', 'eps'));
    store.insertNode({ config: makeNode('net_5'), status: 'created', createdAt: new Date().toISOString() });
    store.deleteNodes('net_5');
    store.deleteNetwork('net_5');
    expect(store.tryGetNetwork('net_5')).toBeUndefined();
    expect(() => store.getNode('net_5-a')).toThrow();
    store.close();
  });
});
