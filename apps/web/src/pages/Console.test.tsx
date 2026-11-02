// @vitest-environment jsdom
/**
 * Console shell + Overview + node drawer (T-3.6B): real API records render,
 * unknowns render as "—", operations go through the typed client only.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../test-utils/render';
import { apiClient } from '../api/client';
import { App, stepFor, watermarkFor } from '../App';
import { Overview, compactHeight } from './Overview';
import { NodeDrawer, diagnose } from '../components/NodeDrawer';
import { primeApi, okOp, ALICE, type ApiMock } from '../test-utils/mockApi';
import { pushEvent, renderConsole } from '../test-utils/renderConsole';
import { FakeWebSocket } from '../test-utils/fake';
import { makeHealth, makeSample } from '../test-utils/fixtures';

vi.mock('../api/client', async (orig) => {
  const actual = await orig<typeof import('../api/client')>();
  const { makeApiMock } = await import('../test-utils/mockApi');
  return { ...actual, apiClient: makeApiMock() };
});
const api = apiClient as unknown as ApiMock;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  primeApi(api);
});

describe('App shell', () => {
  it('maps routes to lifecycle steps', () => {
    expect(stepFor('/create')).toBe(0);
    expect(stepFor('/overview')).toBe(1);
    expect(stepFor('/lab')).toBe(2);
    expect(stepFor('/incidents')).toBe(3);
    expect(stepFor('/deployments')).toBe(5);
    expect(stepFor('/v3')).toBe(-1);
    expect(watermarkFor('/lab', false)).toBe('BREAK');
    expect(watermarkFor('/lab', true)).toBe('FAILURE');
    expect(watermarkFor('/incidents', false)).toBe('DIAGNOSE');
    expect(watermarkFor('/overview', false)).toBe('KAIZEN');
  });

  it('shell shows the real control-plane status and a network chip', async () => {
    renderConsole(<App />, { route: '/overview', withConsole: false });
    expect(await screen.findByLabelText('Control plane status')).toHaveTextContent(/connected/);
    expect(await screen.findByLabelText('Selected network')).toHaveValue('net_1');
    const header = document.querySelector('.main > .top');
    expect(header).toBeInTheDocument();
    expect(within(header as HTMLElement).getByRole('link', { name: 'Kaizen home' })).toBeInTheDocument();
    expect(within(header as HTMLElement).getByLabelText('Selected network')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Console' });
    expect(within(nav).getByRole('button', { name: 'Networks' })).toBeEnabled();
    expect(within(nav).getByRole('button', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Lifecycle' })).not.toBeInTheDocument();
  });

  it('keeps mobile shell navigation and the landing hero inside responsive wrappers', async () => {
    renderConsole(<App />, { route: '/', withConsole: false });
    expect(await screen.findByRole('heading', { name: /An upgrade can pass/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Landing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Launch console' })).toBeInTheDocument();
    const landingBrand = screen.getByRole('link', { name: 'Kaizen home' });
    expect(landingBrand).toHaveAttribute('href', '/');
    expect(document.querySelector('.lnav-cta')).toHaveClass('hero-actions');
    await userEvent.click(screen.getByRole('button', { name: 'Launch console' }));
    expect(await screen.findByRole('navigation', { name: 'Console' })).toBeInTheDocument();
    expect(document.querySelector('.main > .top')).toBeInTheDocument();
  });

  it('landing shows only real commands and labels planned targets', async () => {
    renderConsole(<App />, { route: '/', withConsole: false });
    expect(screen.getAllByText('npx kaizen up').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('kaizen up output')).toHaveTextContent('4 nodes started and healthy');
    expect(screen.getAllByText(/Phase 6/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Blocked in engine · R-22/)).toHaveLength(2);
    expect(screen.getByLabelText('V3 evidence')).toHaveTextContent('0x08fdadd1ebe16234c03b723255cc12fd98a5ef07');
    expect(screen.getByLabelText('V3 evidence')).toHaveTextContent('420420777');
    expect(screen.getByText(/Illustration — the console draws this view/)).toBeInTheDocument();
  });

  it('keeps the 390px landing hero CTAs stacked and proportioned, without changing desktop button rules', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    renderConsole(<App />, { route: '/', withConsole: false });
    await screen.findByRole('heading', { name: /An upgrade can pass/ });
    const brand = screen.getByRole('link', { name: 'Kaizen home' });
    const ctas = document.querySelector('.lnav-cta');
    const mobileCss = readFileSync('apps/web/src/styles.css', 'utf8');
    const phoneRules = mobileCss.slice(mobileCss.lastIndexOf('@media (max-width:640px)'));
    const desktopCss = mobileCss.slice(0, mobileCss.indexOf('@media (max-width:1180px)'));
    expect(brand).toBeInTheDocument();
    expect(ctas).toHaveClass('hero-actions');
    expect(ctas?.children).toHaveLength(1);
    const launch = within(ctas as HTMLElement).getByRole('button', { name: 'Launch console' });
    expect(launch).toHaveClass('sm', 'pri');
    expect(launch.querySelector('i')).toBeInTheDocument();
    expect(phoneRules).toMatch(/\.lnav>\.brand\{[^}]*font-size:22px/);
    expect(phoneRules).toContain('.lnav .lnav-cta .btn.ghost{display:none}');
    expect(phoneRules).toContain('.lnav-cta .btn i{width:26px;height:26px;margin-right:-6px}');
    expect(phoneRules).toContain('.landing .hero .hero-actions{display:flex;flex-direction:column;align-items:stretch;gap:10px;margin-top:8px}');
    expect(phoneRules).toContain('.landing .hero .hero-actions>.btn{box-sizing:border-box;width:100%;min-height:54px;padding:0 26px;justify-content:space-between;margin:0}');
    expect(phoneRules).toContain('.landing .hero .hero-actions>.btn i{width:34px;height:34px;margin-right:-16px}');
    expect(phoneRules).toContain('.landing .hero .hero-actions>.cmd{box-sizing:border-box;width:100%;max-width:100%;min-height:60px;gap:12px;padding:8px 8px 8px 18px;justify-content:space-between;margin:0}');
    expect(phoneRules).toContain('.landing .hero .hero-actions>.cmd code{min-width:0;white-space:nowrap;font-size:clamp(12px,3.7vw,16px)}');
    expect(phoneRules).toContain('.landing .hero .hero-actions>.cmd button{flex:none;min-height:44px;padding:0 14px;font-size:13px}');
    expect(phoneRules).not.toContain('.landing .hero .hero-actions>.cmd{box-sizing:border-box;width:max-content');
    expect(desktopCss).toContain('.cmd{display:inline-flex;align-items:center;gap:18px;padding:8px 8px 8px 26px');
    expect(desktopCss).toContain('.btn{display:inline-flex;align-items:center;justify-content:center;gap:16px;min-height:54px;padding:0 26px');
    expect(screen.getByRole('button', { name: 'Launch console' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run Drill Now/ })).toBeInTheDocument();
    expect(within(document.querySelector('.landing .hero .hero-actions') as HTMLElement).getByRole('button', { name: 'Copy npx kaizen up' })).toBeInTheDocument();
  });

  it('landing shows real control-plane status and launches the console', async () => {
    renderConsole(<App />, { route: '/', withConsole: false });
    expect((await screen.findAllByText(/Control plane connected · v0.1.0/)).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /Launch console/ }));
    expect(await screen.findByRole('navigation', { name: 'Console' })).toBeInTheDocument();
  });

  it('landing reports an unreachable control plane honestly', async () => {
    api.health.mockRejectedValue(new Error('down'));
    renderConsole(<App />, { route: '/', withConsole: false });
    expect((await screen.findAllByText(/Control plane unreachable/)).length).toBeGreaterThan(0);
  });

  it('disables network-scoped nav without a network and offers create', async () => {
    primeApi(api, { empty: true });
    renderConsole(<App />, { route: '/overview', withConsole: false });
    expect(await screen.findByText('No network selected')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Console' });
    expect(within(nav).getByRole('button', { name: 'Failure Lab' })).toBeDisabled();
    expect(within(nav).getByRole('button', { name: 'Portaldot V3' })).toBeEnabled();
  });
});

describe('Overview', () => {
  it('renders real nodes, heights and observed links', async () => {
    renderConsole(<Overview />);
    expect(await screen.findByRole('heading', { name: 'Network healthy' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /demo-alice, Synced/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /demo-bob, Synced/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('#121')).toBeInTheDocument());
    expect(screen.getByText(/1 via peer ids/)).toBeInTheDocument();
  });

  it('formats block heights compactly without inventing digits', () => {
    expect(compactHeight(1284)).toBe('1,284');
    expect(compactHeight(128_430)).toBe('128.4k');
    expect(compactHeight(1_284_306)).toBe('1.28M');
  });

  it('shows Start for a stopped network and calls the backend', async () => {
    primeApi(api, { network: { status: 'stopped' }, nodes: [{ ...ALICE, status: 'stopped' }] });
    api.monitorSnapshot.mockRejectedValue(new Error('no snapshot'));
    api.startNetwork.mockResolvedValue(okOp);
    renderConsole(<Overview />);
    await userEvent.click(await screen.findByRole('button', { name: /Start network/ }));
    expect(api.startNetwork).toHaveBeenCalledWith('net_1');
    expect(screen.getByText('# —')).toBeInTheDocument();
  });

  it('surfaces a failed start operation result', async () => {
    primeApi(api, { network: { status: 'stopped' } });
    api.startNetwork.mockResolvedValue({ ok: false, result: { ...okOp.result, ok: false, error: { code: 'HEALTH_TIMEOUT', message: 'nodes never became healthy' } } });
    renderConsole(<Overview />);
    await userEvent.click(await screen.findByRole('button', { name: /Start network/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('nodes never became healthy');
  });

  it('lists live WS events for the selected network', async () => {
    renderConsole(<Overview />);
    await screen.findByRole('heading', { name: 'Network healthy' });
    act(() => FakeWebSocket.last().open());
    act(() => pushEvent('node.status', { networkId: 'net_1', nodeId: 'net_1-bob', name: 'demo-bob', status: 'stopping' }));
    // the network-name prefix is dropped for the compact events column
    expect(await screen.findByText('bob → stopping')).toBeInTheDocument();
  });
});

describe('Node drawer', () => {
  it('opens from the topology with real logs, diagnostics and controls', async () => {
    api.stopNode.mockResolvedValue(okOp);
    renderConsole(
      <>
        <Overview />
        <NodeDrawer />
      </>,
    );
    await userEvent.click(await screen.findByRole('button', { name: /demo-alice, Synced/ }));
    const dialog = await screen.findByRole('dialog', { name: 'demo-alice' });
    expect(await within(dialog).findByText(/WARN slow block import/)).toBeInTheDocument();
    expect(within(dialog).getByText('12D3KooWAzAzA')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Restart (planned)' })).toBeDisabled();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Run diagnostics' })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run diagnostics' }));
    expect(within(dialog).getByLabelText('Diagnostics')).toHaveTextContent('RPC reachable');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Stop' }));
    expect(api.stopNode).toHaveBeenCalledWith('net_1', 'net_1-alice');
  });

  it('diagnose() derives verdicts only from the sample', () => {
    const checks = diagnose({
      ok: true,
      node: { ...ALICE, expectedPeers: 1 },
      sample: makeSample({ rpc: { reachable: false, error: 'ECONNREFUSED' }, peers: null, health: null }),
      health: makeHealth({ state: 'unavailable', reasons: ['RPC unreachable'] }),
    });
    expect(checks.find((c) => c.l === 'RPC reachable')).toMatchObject({ ok: false, detail: 'ECONNREFUSED' });
    expect(checks.find((c) => c.l === 'Peers connected')).toMatchObject({ ok: false, detail: 'not observed' });
    expect(checks.find((c) => c.l === 'Process running')?.ok).toBe(true);
  });
});
