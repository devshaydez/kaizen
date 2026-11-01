/**
 * Kaizen operations console shell (T-3.6B, restyled to the design in T-3.6C): the sidebar,
 * lifecycle stepper and page transitions, wired to the real API through
 * ConsoleProvider (REST state + WS invalidation). Nothing is simulated.
 */

import { useState, type JSX } from 'react';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Live } from './pages/Live';
import { Backdrop } from './components/Backdrop';
import { NodeDrawer } from './components/NodeDrawer';
import { STEPS, ease } from './components/ui';
import { ConsoleProvider, useConsole } from './state/ConsoleContext';
import { useEventsContext } from './state/EventsContext';
import { useAsync } from './state/useAsync';
import { apiClient } from './api/client';
import { ACTIVE_FAULT_STATES } from './lib/model';
import { REPLAY } from './lib/mode';
import { ReplayBanner } from './components/ReplayBanner';
import { ConsoleDataNotice } from './components/ConsoleDataNotice';
import { Networks } from './pages/Networks';
import { Landing } from './pages/Landing';
import { Create } from './pages/Create';
import { Overview } from './pages/Overview';
import { Validators } from './pages/Validators';
import { Lab } from './pages/Lab';
import { Scenarios } from './pages/Scenarios';
import { Incidents } from './pages/Incidents';
import { Deployments } from './pages/Deployments';
import { V3 } from './pages/V3';
import { Settings } from './pages/Settings';

/** Hosted deployment (Vercel): no engine behind it; the console runs in replay mode. */
export const HOSTED = REPLAY;

interface NavItem {
  path: string;
  label: string;
  needsNet: boolean;
}

export const NAV: NavItem[] = [
  { path: '/create', label: 'Create network', needsNet: false },
  { path: '/live', label: 'Live drills', needsNet: false },
  { path: '/lab', label: 'Failure Lab', needsNet: true },
  { path: '/scenarios', label: 'Scenarios', needsNet: false },
  { path: '/overview', label: 'Overview', needsNet: false },
  { path: '/networks', label: 'Networks', needsNet: false },
  { path: '/validators', label: 'Validators', needsNet: true },
  { path: '/incidents', label: 'Incidents', needsNet: true },
  { path: '/deployments', label: 'Deployments', needsNet: true },
  { path: '/v3', label: 'Portaldot V3', needsNet: false },
  { path: '/settings', label: 'Settings', needsNet: false },
];

const ACTION_PATHS = new Set(['/create', '/live', '/lab', '/scenarios']);

/** Where each lifecycle pill navigates. */
const STEP_PATHS = ['/create', '/overview', '/lab', '/incidents', '/lab', '/deployments'];

/** Lifecycle step for the current route (−1 = not a lifecycle page). */
export function stepFor(path: string): number {
  if (path.startsWith('/create')) return 0;
  if (path.startsWith('/overview')) return 1;
  if (path.startsWith('/lab') || path.startsWith('/scenarios')) return 2;
  if (path.startsWith('/incidents')) return 3;
  if (path.startsWith('/deployments')) return 5;
  return -1;
}

/** Faint page-title watermark behind each screen (design). */
export function watermarkFor(path: string, faultActive: boolean): string {
  const section = path.split('/')[1] ?? '';
  if (section === 'lab') return faultActive ? 'FAILURE' : 'BREAK';
  const words: Record<string, string> = {
    overview: 'KAIZEN',
    networks: 'NETWORKS',
    create: 'CREATE',
    validators: 'VALIDATORS',
    scenarios: 'SCENARIOS',
    incidents: 'DIAGNOSE',
    deployments: 'DEPLOY',
    settings: 'SETTINGS',
    v3: 'PORTALDOT',
    live: 'PROOF',
  };
  return words[section] ?? 'KAIZEN';
}

function NetChip(): JSX.Element | null {
  const { networks, selectedId, select, network, nodes } = useConsole();
  if (!networks.length || !network) return null;
  const bad = network.status !== 'running';
  return (
    <label className="netchip" title="Switch network">
      <span>{network.name}</span>·<span>{network.preset}</span>·<span>{nodes.length} nodes</span>
      <span className={`st ${bad ? 'bad' : ''}`}>· {network.status}</span>
      <select aria-label="Selected network" value={selectedId ?? ''} onChange={(e) => select(e.target.value || null)}>
        {networks.map((n) => (
          <option key={n.id} value={n.id}>
            {n.name} · {n.preset} · {n.status}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Real control-plane reachability (health endpoint + event stream). */
function ControlPlane(): JSX.Element {
  if (REPLAY) return <ReplayPlane />;
  return <LivePlane />;
}

/** Replay mode: no control plane; data comes from recorded drills. */
function ReplayPlane(): JSX.Element {
  return (
    <div className="cp" aria-label="Control plane status">
      data source
      <br />
      <span className="dotc" />
      <b>replay</b> · recorded drills
    </div>
  );
}

function LivePlane(): JSX.Element {
  const { status } = useEventsContext();
  const health = useAsync((_s) => apiClient.health({ timeoutMs: 4000 }), []);
  const up = status === 'open' || Boolean(health.data);
  const port = typeof window !== 'undefined' ? window.location.port || (window.location.protocol === 'https:' ? '443' : '80') : '';
  return (
    <div className="cp" aria-label="Control plane status">
      control plane
      <br />
      <span className={`dotc ${up ? '' : 'off'}`} />
      <b>{up ? 'connected' : health.loading ? 'checking' : 'unreachable'}</b> · :{port}
    </div>
  );
}

function Shell(): JSX.Element {
  const loc = useLocation();
  const nav = useNavigate();
  const reduceMotion = useReducedMotion();
  const { network, faults } = useConsole();
  const ph = stepFor(loc.pathname);
  const section = '/' + (loc.pathname.split('/')[1] ?? '');
  const faultActive = faults.some((f) => f.mode === 'execute' && ACTIVE_FAULT_STATES.has(f.state));
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <Backdrop word={watermarkFor(loc.pathname, faultActive)} />
      <div className="app">
        <aside className={`side ${menuOpen ? 'open' : ''}`}>
          <button type="button" className="menu-btn" aria-label="Toggle menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
            <span /><span /><span />
          </button>
          <Link to="/" className="brand" aria-label="Kaizen home">
            KAIZEN
          </Link>
          <LayoutGroup id="nav">
            <motion.nav
              aria-label="Console"
              initial={reduceMotion ? false : { opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.2, ease }}
            >
            {(['Actions', 'Inspect'] as const).map((group) => (
              <div className="nav-group" key={group}>
                <div className="nav-group-title">{group}</div>
                {NAV.filter((n) => ACTION_PATHS.has(n.path) === (group === 'Actions')).map((n) => {
                  const off = n.needsNet && !network;
                  const on = n.path === section;
                  return (
                    <button
                      type="button"
                      key={n.path}
                      className={`nav ${on ? 'on' : ''}`}
                      disabled={off}
                      aria-current={on ? 'page' : undefined}
                      title={off ? 'Create or select a network first' : undefined}
                      onClick={() => { setMenuOpen(false); nav(n.path); }}
                    >
                      {on && <motion.span layoutId="navpill" className="pill" transition={{ duration: reduceMotion ? 0 : 0.2, ease }} />}
                      <span>{n.label}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            </motion.nav>
          </LayoutGroup>
          <ControlPlane />
        </aside>
        <main className="main">
          <header className="top">
            <LayoutGroup id="steps">
              <ol className="steps" aria-label="Lifecycle">
                {STEPS.map((x, i) => {
                  const alarm = i === 2 && faultActive;
                  const cls = alarm ? 'alarm' : i === ph ? 'on' : i < ph ? 'past' : '';
                  return (
                    <li key={x} className={cls}>
                      <Link to={STEP_PATHS[i] ?? '/overview'} aria-current={i === ph ? 'step' : undefined}>
                        {(i === ph || alarm) && <motion.span layoutId={alarm ? 'alarmpill' : 'steppill'} className="pill" transition={{ duration: 0.35, ease }} />}
                        <span>{x}</span>
                      </Link>
                    </li>
                  );
                })}
              </ol>
            </LayoutGroup>
            <NetChip />
          </header>
          {REPLAY && <ReplayBanner />}
          <ConsoleDataNotice path={loc.pathname} />
          <AnimatePresence mode="wait">
            <motion.div
              key={section}
              className="page"
              initial={reduceMotion ? false : { opacity: 0, y: 10, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={reduceMotion ? undefined : { opacity: 0, y: -6, filter: 'blur(4px)' }}
              transition={{ duration: reduceMotion ? 0 : 0.2, ease }}
            >
              <Routes location={loc}>
                <Route path="/create" element={<Create />} />
                <Route path="/overview" element={<Overview />} />
                <Route path="/networks" element={<Networks />} />
                <Route path="/validators" element={<Validators />} />
                <Route path="/lab" element={<Lab />} />
                <Route path="/scenarios" element={<Scenarios />} />
                <Route path="/incidents" element={<Incidents />} />
                <Route path="/deployments" element={<Deployments />} />
                <Route path="/v3" element={<V3 />} />
                <Route path="/live" element={<Live />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/overview" replace />} />
              </Routes>
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <NodeDrawer />
    </>
  );
}

export function App(): JSX.Element {
  return (
    <ConsoleProvider>
      <Routes>
        <Route
          index
          element={
            <Landing />
          }
        />
        <Route path="/*" element={<Shell />} />
      </Routes>
    </ConsoleProvider>
  );
}
