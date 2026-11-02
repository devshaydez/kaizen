/**
 * Live proof of resilience (public, no Kaizen API behind it).
 *
 * Drills run on GitHub Actions (.github/workflows/drill-live.yml): a fresh
 * x86_64 runner boots a REAL two-node portaldot_dev network, pauses a
 * validator, reads recovery from GRANDPA finality, certifies the run, anchors
 * the fingerprint on the Portaldot V3 TEST network (System.remark, when the
 * signer secret is set) and publishes the bundle to the `demo-data` branch.
 *
 * This page only reads that public data and re-checks it in the browser:
 * run hash + certificate fingerprint recomputed (same canonical JSON and
 * SHA-256 as packages/engine), and the V3 block fetched now to find the
 * remark. Nothing here is mocked; a check that cannot be made says so.
 */

import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { Btn } from '../components/ui';
import { ProofChecklist } from '../components/ProofChecklist';
import { useConsole } from '../state/ConsoleContext';
import { consoleBlockUrl } from './Landing';
import { PublicMonitorCard } from './publicMonitor';
import { getDispatchedRun, requestDrill, type DrillRun } from './drillWorkflow';

const OWNER = 'Shaydez-Defi';
const NAME = 'kaizen';
const DATA = `https://raw.githubusercontent.com/${OWNER}/${NAME}/demo-data`;
const RUNS = `https://api.github.com/repos/${OWNER}/${NAME}/actions/workflows/drill-live.yml/runs?per_page=6`;
const V3_RPC = 'https://test-node-v3.portaldot.dev';
const DRILL_API = (import.meta.env?.['VITE_KAIZEN_DRILL_API'] as string | undefined) ?? '/api/drill';

interface IndexItem {
  id: string;
  publishedAt: string;
  fingerprint: string;
  validatorId: string;
  recovered: boolean | null;
  timeToRecoverMs: number | null;
  finalityGapBlocks: number | null;
  score: number | null;
  anchor: { status: string; blockNumber: number | null };
  workflowUrl: string | null;
}
interface BlockRef {
  number: number;
  hash: string;
}
interface Bundle {
  id: string;
  publishedAt: string;
  certificate: {
    fingerprint: string;
    runHash: string;
    validatorId: string;
    chain: {
      observations: { phase: string; at: string; best: BlockRef; finalized: BlockRef }[];
      metrics: { recovered: boolean; timeToRecoverMs: number | null; finalityGapBlocks: number | null; blocksMissed: number | null };
    };
    signature: { address: string; dev: boolean };
  };
  run: unknown;
  verificationOnline: { status: string; reasons: string[] } | null;
  score: { score: number } | null;
  anchor: { status: string; reason?: string; blockHash?: string; blockNumber?: number | null; txHash?: string | null; finality?: string | null; signerAddress?: string | null };
  workflow: { url: string } | null;
}
interface WfRun {
  id: number;
  status: string;
  event: string;
  html_url: string;
  created_at: string;
  run_started_at?: string;
}
interface Check {
  label: string;
  ok: boolean | null;
  detail: string;
}

function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new Error(`unsupported ${typeof v}`);
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `0x${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
const utf8Hex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function v3<T>(method: string, params: unknown[]): Promise<T> {
  const r = await (await fetch(V3_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(r.error.message);
  return r.result as T;
}

async function verify(b: Bundle): Promise<Check[]> {
  const out: Check[] = [];
  const runHash = await sha256(canonicalJson({ kaizenAnchor: 1, run: b.run }));
  out.push({ label: 'Run hash recomputed', ok: runHash === b.certificate.runHash, detail: runHash });
  const fp = await sha256(canonicalJson({ kaizenCertificate: 1, runHash, run: b.run, chain: b.certificate.chain }));
  out.push({ label: 'Certificate fingerprint recomputed', ok: fp === b.certificate.fingerprint, detail: fp });
  const online = b.verificationOnline;
  out.push({
    label: 'Block hashes matched the dev chain during the run',
    ok: online ? online.status === 'verified' : null,
    detail: online ? (online.reasons[0] ?? online.status) : 'not recorded',
  });
  if (b.anchor.status === 'in-block' || b.anchor.status === 'finalized') {
    try {
      const blk = await v3<{ block: { header: { number: string }; extrinsics: string[] } } | null>('chain_getBlock', [b.anchor.blockHash]);
      const needle = utf8Hex(`kaizen:certificate:v1:${b.certificate.fingerprint}`);
      const found = Boolean(blk) && blk!.block.extrinsics.some((x) => x.toLowerCase().includes(needle));
      out.push({
        label: 'Fingerprint found on Portaldot V3 (fetched now)',
        ok: found,
        detail: blk ? `block #${Number.parseInt(blk.block.header.number, 16)}` : 'block not found',
      });
    } catch (e) {
      out.push({ label: 'Fingerprint found on Portaldot V3 (fetched now)', ok: null, detail: `V3 node unreachable: ${(e as Error).message}` });
    }
  } else {
    out.push({ label: 'Anchored on Portaldot V3', ok: null, detail: b.anchor.reason ?? b.anchor.status });
  }
  return out;
}

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const mark = (ok: boolean | null) => (ok === true ? <span className="ok">✓</span> : ok === false ? <span className="bad">✗</span> : <span className="warn">—</span>);
const check = (checks: Check[], prefix: string) => checks.find((item) => item.label.startsWith(prefix));
const secs = (ms: number | null) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);

/** Next run of the workflow schedule: minutes 17 and 47 of every UTC hour. */
function nextScheduled(): Date {
  const now = new Date();
  const t = new Date(now);
  t.setUTCSeconds(0, 0);
  if (t.getUTCMinutes() < 17) t.setUTCMinutes(17);
  else if (t.getUTCMinutes() < 47) t.setUTCMinutes(47);
  else {
    t.setUTCHours(t.getUTCHours() + 1);
    t.setUTCMinutes(17);
  }
  return t;
}

const footnote = { fontSize: 12.5, marginTop: 10, color: 'var(--mute)' } as const;

export function Live(): JSX.Element {
  const nav = useNavigate();
  const { select } = useConsole();
  const [items, setItems] = useState<IndexItem[] | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [anchorSource, setAnchorSource] = useState<'live bundle' | 'replay evidence' | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [runs, setRuns] = useState<WfRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [req, setReq] = useState<{ state: 'idle' | 'busy' | 'accepted' | 'queued' | 'running' | 'completed' | 'no'; text?: string }>({ state: 'idle' });
  const [dispatchSince, setDispatchSince] = useState<string | null>(null);
  const [drillRun, setDrillRun] = useState<DrillRun | null>(null);

  const loadIndex = useCallback(async () => {
    try {
      const r = await fetch(`${DATA}/index.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status === 404 ? 'No drill has been published yet. The first one is running now.' : `HTTP ${r.status}`);
      const idx = (await r.json()) as { drills: IndexItem[] };
      setItems(idx.drills);
      setSelected((s) => s ?? idx.drills[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const loadRuns = useCallback(async () => {
    try {
      const r = await fetch(`${RUNS}&t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) setRuns(((await r.json()) as { workflow_runs: WfRun[] }).workflow_runs);
    } catch {
      /* runner status is optional */
    }
  }, []);

  const active = runs?.find((r) => r.status !== 'completed');
  useEffect(() => {
    void loadIndex();
    void loadRuns();
    const t = setInterval(() => {
      void loadRuns();
      void loadIndex();
    }, 30_000);
    return () => clearInterval(t);
  }, [loadIndex, loadRuns, active]);

  useEffect(() => {
    if (!dispatchSince) return undefined;
    let alive = true;
    let finished = false;
    const poll = async () => {
      if (finished) return;
      try {
        const run = await getDispatchedRun(dispatchSince);
        if (!alive || !run) return;
        setDrillRun(run);
        if (run.status === 'completed') {
          finished = true;
          setReq({ state: 'completed', text: `Workflow completed: ${run.conclusion ?? 'completed'}.` });
          void loadRuns();
          void loadIndex();
        } else if (run.status === 'in_progress') {
          setReq({ state: 'running', text: 'GitHub Actions is running the drill.' });
        } else {
          setReq({ state: 'queued', text: 'GitHub Actions queued the drill.' });
        }
      } catch (e) {
        if (alive) setReq({ state: 'accepted', text: `Dispatch accepted; workflow status check failed: ${(e as Error).message}` });
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5_000);
    return () => { alive = false; clearInterval(timer); };
  }, [dispatchSince, loadIndex, loadRuns]);

  useEffect(() => {
    if (!selected) return;
    setBundle(null);
    setAnchorSource(null);
    setChecks(null);
    void (async () => {
      try {
        const b = (await (await fetch(`${DATA}/drills/${selected}.json`)).json()) as Bundle;
        setBundle(b);
        setAnchorSource('live bundle');
        setChecks(await verify(b));
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [selected]);

  const runNow = async () => {
    setReq({ state: 'busy' });
    setDrillRun(null);
    try {
      const result = await requestDrill(DRILL_API);
      setDispatchSince(result.since);
      if (result.run) {
        setDrillRun(result.run);
        if (result.run.status === 'completed') setReq({ state: 'completed', text: `Workflow completed: ${result.run.conclusion ?? 'completed'}.` });
        else if (result.run.status === 'in_progress') setReq({ state: 'running', text: 'GitHub Actions is running the drill.' });
        else setReq({ state: 'queued', text: 'GitHub Actions queued the drill.' });
      } else {
        setReq({ state: 'accepted', text: result.message });
      }
      void loadRuns();
    } catch (e) {
      setReq({ state: 'no', text: (e as Error).message });
    }
  };

  const m = bundle?.certificate.chain.metrics;
  const openInConsole = (b: Bundle) => {
    const netId = (b.run as { networkId?: string } | null)?.networkId;
    if (netId) select(netId);
    nav('/overview');
  };
  return (
    <>
      <div className="head">
        <div>
          <div className="lab">Live proof of resilience · GitHub Actions</div>
          <h1>
            Live <span className="g">drills</span>
          </h1>
          <p style={{ maxWidth: 760 }}>Real two-node drills run every 30 minutes or on demand. Recovery is checked against GRANDPA finality, and each result is browser-verified.</p>
          <p className="sub">Run drill now dispatches the GitHub workflow through the server; its token stays off the browser.</p>
        </div>
        <div className="actions" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <Btn tone="pri" arrow disabled={req.state === 'busy' || Boolean(active)} onClick={() => void runNow()}>
            {req.state === 'busy' ? 'Requesting…' : 'Run drill now'}
          </Btn>
          {req.text && <span className={`sub ${req.state === 'completed' ? 'ok' : req.state === 'no' ? 'bad' : ''}`} role="status">{req.text}</span>}
          {drillRun && <a className="ext" href={drillRun.html_url} target="_blank" rel="noreferrer">Open this workflow run ↗</a>}
        </div>
      </div>

      <PublicMonitorCard />

      <div className="glass card" aria-label="Runner status" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
        {active ? (
          <span>
            <span className="chip warn">Drill running now</span>{' '}
            <span className="sub">
              started {ago(active.run_started_at ?? active.created_at)} · {active.event}
            </span>{' '}
            <a className="ext" href={active.html_url} target="_blank" rel="noreferrer">
              watch the live log →
            </a>
          </span>
        ) : (
          <span>
            <span className="chip ok">Idle</span>{' '}
            <span className="sub">next scheduled drill {nextScheduled().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' })}</span>
          </span>
        )}
      </div>

      {error && !items && <div className="errbox" role="alert">{error}</div>}

      {bundle && m && (
        <section id="latest" className="livegrid" aria-label="Selected drill">
          <div className="glass card">
            <div className="lab">Drill {items?.[0]?.id === bundle.id ? '(latest)' : ''}</div>
            <h2 style={{ margin: '6px 0 2px' }}>{m.recovered ? <span className="g">Recovered</span> : <span className="gc">Did not recover</span>}</h2>
            <div className="sub">
              validator {bundle.certificate.validatorId} · {ago(bundle.publishedAt)}
            </div>
            <div className="livemetrics">
              <div>
                <div className="lab">Time to recover</div>
                <b>{secs(m.timeToRecoverMs)}</b>
              </div>
              <div>
                <div className="lab">Finality gap</div>
                <b>{m.finalityGapBlocks ?? '—'} blocks</b>
              </div>
              <div>
                <div className="lab">Blocks missed</div>
                <b>{m.blocksMissed ?? '—'}</b>
              </div>
              <div>
                <div className="lab" title="Evidence score from repeated certified recovery drills. One successful drill can still have a low score.">Resilience score ⓘ</div>
                <b>{bundle.score?.score ?? '—'}/100</b>
              </div>
            </div>
            <div className="mono-s" style={{ marginTop: 14 }}>
              fingerprint {bundle.certificate.fingerprint}
            </div>
            <div className="lab" style={{ marginTop: 14 }}>Published chain anchor <span className="chip ok">{anchorSource === 'live bundle' ? 'LIVE BUNDLE' : 'REPLAY EVIDENCE'}</span></div>
            <div className="sub mono-s">
              {bundle.anchor.status === 'in-block' || bundle.anchor.status === 'finalized' ? (
                <>
                  {bundle.anchor.txHash ? <>tx {short(bundle.anchor.txHash)} · </> : 'transaction hash not published · '}
                  {bundle.anchor.blockNumber != null ? <>block #{bundle.anchor.blockNumber.toLocaleString('en-US')} · </> : 'block not published · '}
                  finality {bundle.anchor.finality ?? bundle.anchor.status} · signer {bundle.anchor.signerAddress ?? 'not published'}
                </>
              ) : `Not anchored: ${bundle.anchor.reason ?? bundle.anchor.status}`}
            </div>
            <div style={footnote}>
              Score reflects repeated certified recovery evidence, not this drill alone. Signed with{' '}
              {bundle.certificate.signature.dev ? 'the public dev key (integrity, not operator identity).' : bundle.certificate.signature.address}
            </div>
          </div>

                  <div className="glass card">
                    <ProofChecklist items={[
                      { label: 'Run files match their recorded hash', ok: check(checks ?? [], 'Run hash recomputed')?.ok ?? null, detail: check(checks ?? [], 'Run hash recomputed')?.detail, href: `${DATA}/drills/${bundle.id}.json`, linkLabel: 'Open run files' },
                      { label: 'Certificate fingerprint matches', ok: check(checks ?? [], 'Certificate fingerprint recomputed')?.ok ?? null, detail: check(checks ?? [], 'Certificate fingerprint recomputed')?.detail, href: `${DATA}/drills/${bundle.id}.json`, linkLabel: 'Open certificate' },
                      { label: 'Run block hashes checked against dev chain', ok: check(checks ?? [], 'Block hashes matched')?.ok ?? null, detail: check(checks ?? [], 'Block hashes matched')?.detail, href: bundle.certificate.chain.observations[0]?.finalized.hash ? consoleBlockUrl(bundle.certificate.chain.observations[0].finalized.hash) : null, linkLabel: 'Open checked block' },
                      { label: 'Certificate fingerprint recorded on Portaldot V3', ok: check(checks ?? [], 'Fingerprint found on Portaldot V3')?.ok ?? check(checks ?? [], 'Anchored on Portaldot V3')?.ok ?? null, detail: check(checks ?? [], 'Fingerprint found on Portaldot V3')?.detail ?? check(checks ?? [], 'Anchored on Portaldot V3')?.detail, href: bundle.anchor.blockHash ? consoleBlockUrl(bundle.anchor.blockHash) : null, linkLabel: 'Open V3 block' },
                    ]} />
                    {!checks && <div className="sub">checking…</div>}
                    <div className="actions" style={{ marginTop: 12 }}>
                      {bundle.anchor.blockHash && (
                        <a className="btn sm pri" href={consoleBlockUrl(bundle.anchor.blockHash)} target="_blank" rel="noreferrer">
                          V3 block #{bundle.anchor.blockNumber}
                        </a>
                      )}
                      {bundle.workflow && (
                        <a className="btn sm line" href={bundle.workflow.url} target="_blank" rel="noreferrer">
                          Runner log
                        </a>
                      )}
                      <a className="btn sm line" href={`${DATA}/drills/${bundle.id}.json`} target="_blank" rel="noreferrer">
                        Raw bundle
                      </a>
                      <Btn small tone="line" onClick={() => openInConsole(bundle)}>
                        Open in console
                      </Btn>
                    </div>
                  </div>

          <div className="glass card">
            <div className="lab">What the chain recorded</div>
            <table className="livetbl">
              <thead>
                <tr>
                  <td>phase</td>
                  <td>best</td>
                  <td>finalized</td>
                </tr>
              </thead>
              <tbody>
                {bundle.certificate.chain.observations.map((o, i) => (
                  <tr key={i}>
                    <td>{o.phase}</td>
                    <td>#{o.best.number}</td>
                    <td title={o.finalized.hash}>
                      #{o.finalized.number} <span className="mono-s">· {short(o.finalized.hash)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={footnote}>Recovery is declared only when finality advances past where it stalled.</div>
          </div>
        </section>
      )}

      {items && (
        <section id="history" className="glass card" aria-label="Drill history">
          <div className="lab">Drill history ({items.length})</div>
          <table className="livetbl">
            <thead>
              <tr>
                <td>when</td>
                <td>validator</td>
                <td>recovered</td>
                <td>time</td>
                <td>V3 anchor</td>
                <td>fingerprint</td>
                <td>runner</td>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className={it.id === selected ? 'sel' : ''} onClick={() => setSelected(it.id)} style={{ cursor: 'pointer' }}>
                  <td>{ago(it.publishedAt)}</td>
                  <td>{it.validatorId}</td>
                  <td style={{ fontSize: 16 }}>{mark(it.recovered)}</td>
                  <td>{secs(it.timeToRecoverMs)}</td>
                  <td>{it.anchor.blockNumber ? `#${it.anchor.blockNumber}` : it.anchor.status}</td>
                  <td className="mono-s">{short(it.fingerprint)}</td>
                  <td>
                    {it.workflowUrl ? (
                      <a href={it.workflowUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                        log ↗
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
