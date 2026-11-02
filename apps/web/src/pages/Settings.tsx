/**
 * Settings (design import, T-3.6B): REAL environment readiness (control
 * plane health, portaldot binary, event stream) and management of the
 * selected network (stop / purge / remove, confirm first). Kubernetes
 * cluster connection is Phase 6 and labelled as such.
 */

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ApiError, apiClient } from '../api/client';
import { Btn, ErrorBox, Planned, ease } from '../components/ui';
import { shortId } from '../components/fmt';
import { useConsole } from '../state/ConsoleContext';
import { REPLAY, REPLAY_REFUSAL } from '../lib/mode';
import { useEventsContext } from '../state/EventsContext';
import { useAsync } from '../state/useAsync';

type Danger = 'stop' | 'purge' | 'remove';

const DANGER: Record<Danger, { title: string; text: string }> = {
  stop: { title: 'Stop network?', text: 'Stops every node process. Chain data is kept.' },
  purge: { title: 'Purge chain data?', text: 'Stops the network and deletes its chain databases. Configuration and keys are kept.' },
  remove: { title: 'Remove network?', text: 'Stops the network and deletes its directory and records. This cannot be undone.' },
};

function Check({ label, detail, state }: { label: string; detail: string; state: 'ok' | 'bad' | 'checking' }) {
  return (
    <div className="kv">
      <div>
        <b>{label}</b>
        <div className="sub mono-s">{detail}</div>
      </div>
      <motion.span key={state} className={`chip ${state === 'ok' ? 'running' : state === 'checking' ? 'deploying' : 'bad'}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease }}>
        {state === 'ok' ? 'Ready' : state === 'checking' ? 'Checking' : 'Action needed'}
      </motion.span>
    </div>
  );
}

export function Settings() {
  const nav = useNavigate();
  const { network, refresh } = useConsole();
  const { status } = useEventsContext();
  const health = useAsync(() => apiClient.health({ timeoutMs: 5000 }), []);
  const bin = useAsync(() => apiClient.binaries(), []);
  const [confirm, setConfirm] = useState<Danger | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const rerun = () => {
    health.reload();
    bin.reload();
  };
  const act = async () => {
    if (!network || !confirm) return;
    const kind = confirm;
    setConfirm(null);
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      if (kind === 'remove') {
        await apiClient.removeNetwork(network.id);
        setDone(`Removed ${network.name}.`);
      } else {
        const res = kind === 'stop' ? await apiClient.stopNetwork(network.id) : await apiClient.purgeNetwork(network.id);
        if (!res.result.ok) throw new ApiError(res.result.error?.message ?? `${kind} failed`, res.result.error?.code ?? 'OPERATION_FAILED', 200);
        setDone(`${kind === 'stop' ? 'Stopped' : 'Purged'} ${network.name}.`);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const b = bin.data?.status;
  return (
    <>
      <div className="head">
        <div>
          <div className="lab">Settings</div>
          <h1>Environment</h1>
          <p className="sub">Check API, node binary, event stream, and local configuration.</p>
        </div>
        <div className="actions">
          <Btn onClick={rerun}>Run checks</Btn>
        </div>
      </div>
      {REPLAY && (
        <div className="okbox" role="note">
          Hosted replay: no Kaizen engine, binary or event stream runs behind this console. Screens show real recorded drills. {REPLAY_REFUSAL}
        </div>
      )}
      <div className="split">
        <div>
          <div className="lab" style={{ marginBottom: 6 }}>
            Readiness
          </div>
          <Check
            label="Control plane (Kaizen API)"
            state={health.loading && !health.data ? 'checking' : health.data ? 'ok' : 'bad'}
            detail={health.data ? `${health.data.service} v${health.data.version}` : (health.error?.message ?? 'checking…')}
          />
          <Check
            label="portaldot_dev binary"
            state={bin.loading && !bin.data ? 'checking' : b?.available ? 'ok' : 'bad'}
            detail={b ? (b.available ? `${b.version ?? 'unknown version'} · sha256 ${shortId(b.sha256, 12)}` : (b.error ?? 'not installed — run `kaizen setup`')) : (bin.error?.message ?? 'checking…')}
          />
          <Check label="Event stream (WebSocket)" state={status === 'open' ? 'ok' : status === 'connecting' || status === 'reconnecting' ? 'checking' : 'bad'} detail={status} />
          <div className="kv">
            <div>
              <b>Kubernetes cluster</b>
              <div className="sub">kubeconfig context selection</div>
            </div>
            <Planned phase="Phase 6" />
          </div>
          <div className="lab" style={{ margin: '24px 0 6px' }}>
            Environment
          </div>
          <div className="kv">
            <span className="mono">Data directory</span>
            <b className="mono-s">{health.data?.dataDir ?? '—'}</b>
          </div>
          <div className="kv">
            <span className="mono">VITE_KAIZEN_API</span>
            <b className="mono-s">{import.meta.env?.['VITE_KAIZEN_API'] || 'same origin (dev proxy)'}</b>
          </div>
          <div className="kv">
            <span className="mono">Portaldot V3</span>
            <Btn small tone="line" onClick={() => nav('/v3')}>
              Probe endpoints
            </Btn>
          </div>
        </div>
        <aside className="glass panel">
          <div className="lab">Selected network</div>
          {network ? (
            <>
              <div className="kv">
                <span>Name</span>
                <b>{network.name}</b>
              </div>
              <div className="kv">
                <span>Status</span>
                <b>{network.status}</b>
              </div>
              <div className="actions">
                <Btn small disabled={busy} onClick={() => setConfirm('stop')}>
                  Stop
                </Btn>
                <Btn small tone="line" disabled={busy} onClick={() => setConfirm('purge')}>
                  Purge data
                </Btn>
                <Btn small tone="danger" disabled={busy} onClick={() => setConfirm('remove')}>
                  Remove
                </Btn>
              </div>
            </>
          ) : (
            <div className="sub">No network selected.</div>
          )}
          {busy && <div className="sub">Working…</div>}
          {done && <div className="okbox">{done}</div>}
          <ErrorBox error={error} />
        </aside>
      </div>
      <AnimatePresence>
        {confirm && network && (
          <motion.div className="modal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setConfirm(null)}>
            <motion.div className="glass dialog" role="dialog" aria-modal aria-label={DANGER[confirm].title} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.26, ease }} onClick={(e) => e.stopPropagation()}>
              <h2>{DANGER[confirm].title}</h2>
              <p>
                <b>{network.name}</b>: {DANGER[confirm].text}
              </p>
              <div className="actions">
                <Btn onClick={() => setConfirm(null)}>Cancel</Btn>
                <Btn tone="danger" onClick={() => void act()}>
                  Confirm
                </Btn>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
