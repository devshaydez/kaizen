// @vitest-environment jsdom
/**
 * Portaldot V3 screen (T-8.2 UI): renders the REAL committed anchor evidence
 * (docs/evidence/v3-anchors.json) through the typed client double, links
 * blocks to the node console, verifies per anchor, and anchors only after an
 * explicit confirm (remark by default; contract shows the deposit warning).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../test-utils/render';
import { ApiError, apiClient } from '../api/client';
import type { V3AnchorListResponse, V3ConnectivityReport, V3EndpointProbeResult } from '../api/types';
import { V3 } from './V3';
import { primeApi, type ApiMock } from '../test-utils/mockApi';
import { renderConsole } from '../test-utils/renderConsole';

vi.mock('../api/client', async (orig) => {
  const actual = await orig<typeof import('../api/client')>();
  const { makeApiMock } = await import('../test-utils/mockApi');
  return { ...actual, apiClient: makeApiMock() };
});
const api = apiClient as unknown as ApiMock;

const TEMPLATE = 'https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/{block}';
const evidence = JSON.parse(readFileSync(resolve(process.cwd(), 'docs/evidence/v3-anchors.json'), 'utf8')) as Omit<V3AnchorListResponse, 'explorerBlockUrlTemplate'>;

function endpoint(role: V3EndpointProbeResult['role'], extra: Partial<V3EndpointProbeResult>): V3EndpointProbeResult {
  return { role, endpoint: `https://${role}.example`, status: 'ok', detail: 'ok', latencyMs: 120, at: '', error: null, warnings: [], ...extra };
}

const report: V3ConnectivityReport = {
  at: '',
  config: { substrateWs: 'wss://test-node-v3.portaldot.dev', evmRpc: 'https://test-evm-rpc-v3.portaldot.dev', explorer: 'https://node-console.portaldot.dev', expectedEvmChainId: 420420777, probeTimeoutMs: 10_000 },
  substrate: endpoint('substrate-ws', { substrate: { chainName: 'PortaldotV3 Test', health: { isSyncing: false, peers: 3, shouldHavePeers: true }, best: { number: 137001, hash: '0x' } } }),
  evm: endpoint('evm-rpc', { evm: { chainId: 420420777, expectedChainId: 420420777, blockNumber: 137001, clientVersion: null } }),
  explorer: endpoint('explorer', { status: 'timeout', detail: 'timed out', error: { kind: 'timeout', message: 'no answer in 10000ms' } }),
  healthy: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  primeApi(api);
  api.v3Probe.mockResolvedValue({ ok: true, report });
  api.v3Status.mockResolvedValue({
    ok: true,
    status: {
      signer: { configured: true, address: '5HBnAqniYhyupDT1ccsTSRkdy3EbCAaZC6ii9XFon8WQwEaR', evmAddress: null, freeBalance: '315000000000000', tokenSymbol: 'tPOT', tokenDecimals: 14 },
      registryAddress: '0x08fdadd1ebe16234c03b723255cc12fd98a5ef07',
      registrySource: 'deployment',
      chainName: 'PortaldotV3 Test',
      genesisHash: '0xd4f9',
      explorerBlockUrlTemplate: TEMPLATE,
      error: null,
      at: '',
    },
  });
  api.v3Anchors.mockResolvedValue({ ...evidence, explorerBlockUrlTemplate: TEMPLATE });
  api.listScenarioRuns.mockResolvedValue({
    ok: true,
    runs: [{ id: 'run-mvim409r-32019a7e', scenarioName: 'pause-alice-drill', state: 'completed' }],
    malformed: [],
    total: 1,
    limit: 25,
    offset: 0,
  });
  api.runHash.mockResolvedValue({ ok: true, runId: 'run-mvim409r-32019a7e', runHash: '0x24c2d0255e2b537783cba60c919116d201ed41436f9494cbc38d526420bf1214', state: 'completed', anchorable: true });
});

describe('V3 screen', () => {
  it('shows per-endpoint probe status without collapsing failures', async () => {
    renderConsole(<V3 />, { route: '/v3' });
    const substrate = await screen.findByLabelText('Substrate WS probe');
    expect(substrate).toHaveTextContent('PortaldotV3 Test');
    expect(substrate).toHaveTextContent('best #137,001');
    expect(screen.getByLabelText('EVM JSON-RPC probe')).toHaveTextContent('chain id 420420777 (expected 420420777)');
    expect(screen.getByLabelText('Node console probe')).toHaveTextContent('timeout');
    expect(screen.getByLabelText('Node console probe')).toHaveTextContent('no answer in 10000ms');
  });

  it('renders the committed anchors with tx hashes, contract and node-console links', async () => {
    renderConsole(<V3 />, { route: '/v3' });
    const list = await screen.findByLabelText('Anchors');
    const link = await within(list).findByRole('link', { name: 'Open block 136899 in the node console' });
    expect(link).toHaveAttribute('href', TEMPLATE.replace('{block}', '0x2efd3f718fd67b044dd23fc7c2135c4cd69c53f6f5dd99170a9fc5e073eb0c69'));
    for (const b of [136919, 136940, 136947]) expect(within(list).getByRole('link', { name: `Open block ${b} in the node console` })).toBeInTheDocument();
    expect(within(list).getAllByText(/contract 0x08fdadd1ebe16234c03b723255cc12fd98a5ef07/).length).toBe(4);
    expect(within(list).getAllByText(/failed: /).length).toBe(2);
    expect(screen.getByLabelText('Signer and registry')).toHaveTextContent('3.1500 tPOT');
    expect(screen.getByLabelText('Signer and registry')).toHaveTextContent('block #136,822');
  });

  it('verifies one anchor on demand and shows the verdict', async () => {
    api.verifyAnchor.mockResolvedValue({
      ok: true,
      verification: { anchorId: 'anc-mvimddnj-c3a05c8c', runId: 'run-mvim9v7m-875cdcaa', recordedRunHash: '0x26', recomputedRunHash: '0x26', hashMatches: true, onChainAnchoredAt: null, contractCodePresent: null, blockHashMatches: true, verdict: 'verified', notes: ['remark payload found in block'], at: '' },
    });
    renderConsole(<V3 />, { route: '/v3' });
    const list = await screen.findByLabelText('Anchors');
    await waitFor(() => expect(within(list).getAllByRole('button', { name: 'Verify' }).length).toBe(6));
    await userEvent.click(within(list).getAllByRole('button', { name: 'Verify' })[0]!);
    expect(api.verifyAnchor).toHaveBeenCalledWith('anc-mvimddnj-c3a05c8c');
    const box = await screen.findByLabelText('Verification anc-mvimddnj-c3a05c8c');
    expect(box).toHaveTextContent('verified');
    expect(box).toHaveTextContent('block hash matches');
  });

  it('anchors with remark by default, only after explicit confirm', async () => {
    api.anchorRun.mockResolvedValue({ ok: true, anchor: { ...evidence.anchors[1]!, id: 'anc-new' } });
    renderConsole(<V3 />, { route: '/v3?run=run-mvim409r-32019a7e' });
    expect(await screen.findByLabelText('Run hash')).toHaveTextContent('0x24c2d025');
    await waitFor(() => expect(screen.getByRole('button', { name: /Anchor run/ })).toBeEnabled());
    expect(screen.queryByRole('note')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Anchor run/ }));
    expect(api.anchorRun).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Confirm anchor' })).getByRole('button', { name: 'Anchor' }));
    expect(api.anchorRun).toHaveBeenCalledWith('run-mvim409r-32019a7e', 'remark');
    expect(await screen.findByLabelText('Anchor result')).toHaveTextContent('remark anchor finalized in block #136,940');
  });

  it('contract mode shows the storage-deposit warning and passes the method', async () => {
    api.anchorRun.mockRejectedValue(new ApiError('signer cannot pay (revive.StorageDepositNotEnoughFunds)', 'V3_ANCHOR_FAILED', 502));
    renderConsole(<V3 />, { route: '/v3' });
    await userEvent.click(await screen.findByRole('button', { name: 'Registry contract' }));
    expect(screen.getByRole('note')).toHaveTextContent('about 4 tPOT per anchor');
    await waitFor(() => expect(screen.getByRole('button', { name: /Anchor run/ })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: /Anchor run/ }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm anchor' });
    expect(dialog).toHaveTextContent('storage deposit');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Anchor' }));
    expect(api.anchorRun).toHaveBeenCalledWith('run-mvim409r-32019a7e', 'contract');
    expect(await screen.findByRole('alert')).toHaveTextContent('StorageDepositNotEnoughFunds');
  });

  it('does not offer anchoring for a non-anchorable run', async () => {
    api.runHash.mockResolvedValue({ ok: true, runId: 'run-x', runHash: '0x1', state: 'running', anchorable: false });
    renderConsole(<V3 />, { route: '/v3?run=run-x' });
    expect(await screen.findByText(/not anchorable: running/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Anchor run/ })).toBeDisabled();
  });
});
