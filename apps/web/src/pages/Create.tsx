/**
 * Create network (design import, T-3.6B) over POST /api/networks, then an
 * explicit start (health-gated, can take minutes). Progress lines are the
 * REAL engine events for the new network — no scripted steps.
 */

import { useMemo, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ApiError, apiClient } from '../api/client';
import type { NetworkPreset } from '../api/types';
import { Btn, ErrorBox, Seg, ease } from '../components/ui';
import { isValidNetworkName, slugifyNetworkName } from '../lib/model';
import { useConsole } from '../state/ConsoleContext';
import { useEventsContext } from '../state/EventsContext';

export const PRESETS: { id: NetworkPreset; label: string; n: number; validators: number; blurb: string }[] = [
  { id: 'single-node', label: 'Single node', n: 1, validators: 1, blurb: 'One dev validator. Fastest way to start.' },
  { id: 'two-node', label: '2 node', n: 2, validators: 2, blurb: 'Alice + Bob validators on a generated chain spec.' },
  { id: 'four-validator', label: '4 validator', n: 4, validators: 4, blurb: 'Full mesh; all four author, GRANDPA finalizes.' },
  { id: 'validator-fullnode', label: 'Validator + full node', n: 2, validators: 1, blurb: 'One authoring validator and a keyless full node.' },
  { id: 'custom', label: 'Custom', n: 3, validators: 2, blurb: 'Choose node count and roles (validated by the engine).' },
];

const KEYS = ['alice', 'bob', 'charlie', 'dave', 'eve', 'ferdie'] as const;

const Stepper = ({ v, min, max, onChange, label }: { v: number; min: number; max: number; onChange: (n: number) => void; label: string }) => (
  <div className="stepper" role="group" aria-label={label}>
    <button type="button" aria-label={`Decrease ${label}`} disabled={v <= min} onClick={() => onChange(v - 1)}>
      −
    </button>
    <b>{v}</b>
    <button type="button" aria-label={`Increase ${label}`} disabled={v >= max} onClick={() => onChange(v + 1)}>
      +
    </button>
  </div>
);

export function Create() {
  const nav = useNavigate();
  const { select, refresh } = useConsole();
  const { events } = useEventsContext();
  const [preset, setPreset] = useState<NetworkPreset>('two-node');
  const [rawName, setRawName] = useState('meridian-test');
  const [cn, setCn] = useState(3);
  const [cv, setCv] = useState(2);
  const [startNow, setStartNow] = useState(true);
  const [phase, setPhase] = useState<'form' | 'creating' | 'starting' | 'done' | 'failed'>('form');
  const [error, setError] = useState<ApiError | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [since] = useState(() => Date.now());

  const name = slugifyNetworkName(rawName);
  const p = PRESETS.find((x) => x.id === preset) ?? PRESETS[1]!;
  const custom = preset === 'custom';
  const n = custom ? cn : p.n;
  const v = custom ? Math.min(cv, cn) : p.validators;

  const progress = useMemo(
    () =>
      createdId
        ? events.filter((e) => e.payload['networkId'] === createdId && new Date(e.receivedAt).getTime() >= since - 1000).slice(-12)
        : [],
    [events, createdId, since],
  );

  const submit = async () => {
    setError(null);
    if (!isValidNetworkName(name)) {
      setError(new ApiError('Name must start with a letter or digit and use only a-z, 0-9, - or _ (max 32).', 'INVALID_INPUT', 400));
      return;
    }
    setPhase('creating');
    try {
      const input = custom
        ? {
            name,
            preset,
            custom: {
              nodes: Array.from({ length: n }, (_, i) =>
                i < v
                  ? { name: KEYS[i] ?? `node${i + 1}`, role: 'validator' as const, wellKnownKey: KEYS[i] ?? 'alice' }
                  : { name: `full${i - v + 1}`, role: 'full' as const },
              ),
            },
          }
        : { name, preset };
      const res = await apiClient.createNetwork(input);
      setCreatedId(res.network.id);
      select(res.network.id);
      refresh();
      if (!startNow) {
        setPhase('done');
        nav('/overview');
        return;
      }
      setPhase('starting');
      const started = await apiClient.startNetwork(res.network.id);
      refresh();
      if (!started.result.ok) {
        setError(new ApiError(started.result.error?.message ?? 'start failed', started.result.error?.code ?? 'START_FAILED', 200));
        setPhase('failed');
        return;
      }
      setPhase('done');
      nav('/overview');
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0));
      setPhase('failed');
    }
  };

  if (phase === 'creating' || phase === 'starting' || (phase === 'failed' && createdId)) {
    return (
      <div className="center">
        <h1>{phase === 'failed' ? `Could not start ${name}` : phase === 'creating' ? `Creating ${name}` : `Starting ${name}`}</h1>
        <p>
          {phase === 'starting'
            ? 'Spawning portaldot_dev processes and waiting for health (peers, block production). This can take a minute or two.'
            : 'Generating the chain spec and node identities.'}
        </p>
        <div className="bar" aria-hidden>
          <motion.i animate={{ width: phase === 'creating' ? '25%' : phase === 'starting' ? '70%' : '100%' }} transition={{ duration: 0.6, ease }} />
        </div>
        <ul className="steplist" aria-label="Engine events">
          <AnimatePresence>
            {progress.map((e) => (
              <motion.li key={e.seq} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3, ease }}>
                <span className="ok">•</span> {e.name}
                {typeof e.payload['status'] === 'string' ? ` → ${String(e.payload['status'])}` : ''}
                {typeof e.payload['name'] === 'string' ? ` (${String(e.payload['name'])})` : ''}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
        <ErrorBox error={error} />
        {phase === 'failed' && (
          <Btn tone="pri" arrow onClick={() => nav('/overview')}>
            Open network
          </Btn>
        )}
      </div>
    );
  }

  return (
    <div className="split">
      <div>
        <h1>Create a network</h1>
        <p className="sub">Choose a preset or configure nodes, then launch a real local network.</p>
        <label className="field-l" htmlFor="nn">
          Network name
        </label>
        <input id="nn" value={rawName} onChange={(e) => setRawName(e.target.value)} />
        {name !== rawName && <div className="sub">Will be created as “{name || '—'}”.</div>}
        <div className="lab" style={{ margin: '24px 0 10px' }}>
          Preset
        </div>
        <LayoutGroup id="presets">
          <div className="presets">
            {PRESETS.map((x) => (
              <button type="button" key={x.id} className={`preset ${x.id === preset ? 'on' : ''}`} aria-pressed={x.id === preset} onClick={() => setPreset(x.id)}>
                {x.id === preset && <motion.span layoutId="presetpill" className="pill" transition={{ duration: 0.3, ease }} />}
                <b>{x.label}</b>
                <span>{x.blurb}</span>
              </button>
            ))}
          </div>
        </LayoutGroup>
        <AnimatePresence initial={false}>
          {custom && (
            <motion.div className="custom" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.3, ease }}>
              <div>
                <div className="field-l">Nodes</div>
                <Stepper label="nodes" v={cn} min={1} max={6} onChange={(x) => { setCn(x); setCv((c) => Math.min(c, x)); }} />
              </div>
              <div>
                <div className="field-l">Validators</div>
                <Stepper label="validators" v={Math.min(cv, cn)} min={1} max={cn} onChange={setCv} />
              </div>
              <div>
                <div className="field-l">Topology</div>
                <Seg id="topo" value="mesh" onChange={() => undefined} items={[{ v: 'mesh', l: 'Full mesh' }]} />
                <div className="sub">Ring/star wiring is not implemented; the engine always builds a full mesh.</div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <aside className="glass panel">
        <div className="lab">Review</div>
        <div className="kv"><span>Name</span><b>{name || '—'}</b></div>
        <div className="kv"><span>Preset</span><b>{p.label}</b></div>
        <div className="kv"><span>Nodes</span><b>{n}</b></div>
        <div className="kv"><span>Validators</span><b>{v}</b></div>
        <div className="kv"><span>Full nodes</span><b>{n - v}</b></div>
        <div className="kv"><span>Failure Lab</span><b>Designated test network</b></div>
        <label className="kv" style={{ cursor: 'pointer' }}>
          <span>Start after create</span>
          <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} style={{ width: 18 }} aria-label="Start after create" />
        </label>
        <ErrorBox error={error} />
        <Btn tone="pri" arrow onClick={() => void submit()}>
          Create network
        </Btn>
      </aside>
    </div>
  );
}
