/**
 * Portaldot V3 (T-8.2 console surface): live endpoint probe, signer +
 * registry status, anchored-run evidence with node-console block links,
 * per-anchor on-chain verification, and an explicit, confirmed "Anchor run"
 * write to the V3 TEST network. Every value comes from /api/v3/* — the
 * console never signs anything itself (the backend holds the signer).
 */

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useSearchParams } from 'react-router-dom';
import { ApiError, apiClient } from '../api/client';
import type { V3AnchorMethod, V3AnchorRecord, V3AnchorVerification, V3EndpointProbeResult } from '../api/types';
import { Btn, ErrorBox, Seg, ease } from '../components/ui';
import { formatTs, shortId } from '../components/fmt';
import { blockUrl, formatTokens } from '../lib/model';
import { useEventsContext } from '../state/EventsContext';
import { useAsync, useInterval } from '../state/useAsync';
import { REPLAY } from '../lib/mode';

/** Observed V3 costs (T-8.2 live run, see docs/RISKS.md RSK-30). */
export const CONTRACT_ANCHOR_COST_NOTE =
  'Contract mode calls KaizenRunRegistry.anchor via pallet-revive and reserves a storage deposit — about 4 tPOT per anchor on the V3 test network (remark costs ≈0.02 tPOT).';

const ROLE_LABEL: Record<V3EndpointProbeResult['role'], string> = {
  'substrate-ws': 'Substrate WS',
  'evm-rpc': 'EVM JSON-RPC',
  explorer: 'Node console',
};

function observation(r: V3EndpointProbeResult): string {
  if (r.substrate) {
    const s = r.substrate;
    return [s.chainName, s.best ? `best #${s.best.number.toLocaleString('en-US')}` : null, s.health ? `${s.health.peers} peers` : null].filter(Boolean).join(' · ');
  }
  if (r.evm) {
    const e = r.evm;
    return [`chain id ${e.chainId ?? '—'} (expected ${e.expectedChainId})`, e.blockNumber !== null ? `block #${e.blockNumber.toLocaleString('en-US')}` : null].filter(Boolean).join(' · ');
  }
  if (r.explorer) return [r.explorer.httpStatus ? `HTTP ${r.explorer.httpStatus}` : null, r.explorer.documentTitle].filter(Boolean).join(' · ');
  return '';
}

function ProbeCard({ r }: { r: V3EndpointProbeResult }) {
  const tone = r.status === 'ok' ? '' : r.status === 'mismatch' ? 'warn' : 'bad';
  return (
    <motion.div className="glass" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease }} aria-label={`${ROLE_LABEL[r.role]} probe`}>
      <div className="lab">
        <span className={`dot ${tone}`} />
        {ROLE_LABEL[r.role]}
      </div>
      <div className={`num ${r.status === 'ok' ? 'ok' : tone}`} style={{ fontSize: 26 }}>
        {r.status}
      </div>
      <div className="sub">{observation(r) || r.detail}</div>
      <div className="sub mono-s">
        {r.endpoint} · {r.latencyMs} ms
      </div>
      {r.error && <div className="sub bad">{r.error.message}</div>}
    </motion.div>
  );
}

const statusTone = (s: V3AnchorRecord['status']) => (s === 'finalized' ? 'ok' : s === 'failed' ? 'bad' : 'warn');

export function V3() {
  const [params] = useSearchParams();
  const { events } = useEventsContext();
  const probe = useAsync(() => apiClient.v3Probe(), []);
  const status = useAsync(() => apiClient.v3Status(), []);
  const anchors = useAsync(() => apiClient.v3Anchors({ limit: 50 }), []);
  const runs = useAsync(() => apiClient.listScenarioRuns({ limit: 25 }), []);
  const [runId, setRunId] = useState<string>(params.get('run') ?? '');
  const [method, setMethod] = useState<V3AnchorMethod>('remark');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [last, setLast] = useState<V3AnchorRecord | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, V3AnchorVerification | ApiError>>({});
  const [seen, setSeen] = useState(0);

  const completed = useMemo(() => (runs.data?.runs ?? []).filter((r) => r.state.startsWith('completed')), [runs.data]);
  useEffect(() => {
    if (!runId && completed[0]) setRunId(completed[0].id);
  }, [completed, runId]);
  const hash = useAsync(() => (runId ? apiClient.runHash(runId) : Promise.resolve(null)), [runId]);

  // Refresh the existing backend RPC/monitor reads so head, endpoint health,
  // signer balance, anchors, and run history do not wait for manual probing.
  useInterval(() => {
    probe.reload();
    status.reload();
    anchors.reload();
    runs.reload();
  }, 30_000);

  // Live anchor lifecycle (v3.anchor events) → refresh the evidence list.
  useEffect(() => {
    const fresh = events.filter((e) => e.seq > seen);
    if (!fresh.length) return;
    setSeen(fresh[fresh.length - 1]!.seq);
    if (fresh.some((e) => e.name === 'v3.anchor' || e.name === 'v3.contract')) anchors.reload();
  }, [events, seen, anchors]);

  const template = anchors.data?.explorerBlockUrlTemplate ?? status.data?.status.explorerBlockUrlTemplate ?? null;
  const st = status.data?.status;
  const anchorable = hash.data?.anchorable === true;

  const anchor = async () => {
    setConfirm(false);
    setBusy(true);
    setError(null);
    setLast(null);
    try {
      const res = await apiClient.anchorRun(runId, method);
      setLast(res.anchor);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0));
    } finally {
      setBusy(false);
      anchors.reload();
      status.reload();
    }
  };

  const verify = async (id: string) => {
    setVerifying(id);
    try {
      const res = await apiClient.verifyAnchor(id);
      setVerdicts((v) => ({ ...v, [id]: res.verification }));
    } catch (e) {
      setVerdicts((v) => ({ ...v, [id]: e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0) }));
    } finally {
      setVerifying(null);
    }
  };

  const healthy = probe.data?.report.healthy;
  return (
    <>
      <div className="head">
        <div>
          <div className={`lab ${healthy ? 'ok' : healthy === false ? 'bad' : ''}`}>
            Portaldot V3 test network{st?.chainName ? ` · ${st.chainName}` : ''}
          </div>
          <h1>Proof on chain</h1>
          <p>Anchor completed drill evidence on Portaldot V3, then verify each record against the chain.</p>
        </div>
        <div className="actions">
          <Btn onClick={probe.reload} disabled={probe.loading}>
            {probe.loading ? 'Probing…' : 'Re-probe endpoints'}
          </Btn>
        </div>
      </div>

      <ErrorBox error={probe.error} title="V3 probe failed" />
      {probe.loading && !probe.data && <div className="sub">Probing Substrate WS, EVM RPC and the node console…</div>}
      {probe.data && (
        <div className="probe">
          <ProbeCard r={probe.data.report.substrate} />
          <ProbeCard r={probe.data.report.evm} />
          <ProbeCard r={probe.data.report.explorer} />
        </div>
      )}

      <div className="grid2">
        <div className="glass card" aria-label="Signer and registry">
          <div className="lab">Signer & registry</div>
          <ErrorBox error={status.error} title="Status unavailable" />
          {st && (
            <>
              <div className="kv">
                <span>Signer</span>
                <b className="mono-s">{st.signer.configured ? st.signer.address : REPLAY ? 'none — replay is read-only (the browser never signs)' : 'not configured (KAIZEN_V3_SIGNER_SURI)'}</b>
              </div>
              <div className="kv">
                <span>Free balance</span>
                <b>{formatTokens(st.signer.freeBalance, st.signer.tokenDecimals, st.signer.tokenSymbol)}</b>
              </div>
              <div className="kv">
                <span>Registry</span>
                <b className="mono-s">
                  {st.registryAddress ?? 'none deployed'}
                  {st.registrySource ? ` (${st.registrySource})` : ''}
                </b>
              </div>
              {st.error && <div className="sub bad">{st.error}</div>}
            </>
          )}
          {(anchors.data?.contracts ?? []).map((c) => {
            const href = blockUrl(template, c.blockHash);
            return (
              <div className="kv" key={c.address}>
                <span>
                  Deployed
                  {c.name ? (
                    <>
                      <br />
                      <small className="sub">{c.name}</small>
                    </>
                  ) : null}
                </span>
                <b className="mono-s">
                  {href ? (
                    <a className="ext" href={href} target="_blank" rel="noreferrer">
                      block #{c.blockNumber.toLocaleString('en-US')}
                    </a>
                  ) : (
                    `block #${c.blockNumber}`
                  )}{' '}
                  · tx {shortId(c.txHash, 12)}
                </b>
              </div>
            );
          })}
        </div>

        <div className="glass card" aria-label="Anchor a run">
          <div className="lab">Anchor a finished run</div>
          {completed.length === 0 && !runs.loading && <div className="sub">No completed runs yet — run a scenario first.</div>}
          {completed.length > 0 && (
            <select aria-label="Run to anchor" value={runId} onChange={(e) => setRunId(e.target.value)} style={{ width: '100%', margin: '8px 0' }}>
              {completed.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.scenarioName} · {r.id} · {r.state}
                </option>
              ))}
            </select>
          )}
          {hash.data && (
            <div className="sub mono-s" aria-label="Run hash">
              run hash {hash.data.runHash} {hash.data.anchorable ? '' : `(not anchorable: ${hash.data.state})`}
            </div>
          )}
          <div className="field-l" style={{ marginTop: 12 }}>
            Method
          </div>
          <Seg
            id="method"
            label="Anchor method"
            value={method}
            onChange={setMethod}
            items={[
              { v: 'remark', l: 'Remark (cheap)' },
              { v: 'contract', l: 'Registry contract' },
            ]}
          />
          {method === 'contract' && (
            <div className="wbox" style={{ marginTop: 10 }} role="note">
              {CONTRACT_ANCHOR_COST_NOTE}
            </div>
          )}
          <ErrorBox error={error} title="Anchor failed" />
          {last && (
            <div className={last.status === 'failed' ? 'wbox' : 'okbox'} aria-label="Anchor result" style={{ marginTop: 10 }}>
              {last.method} anchor {last.status}
              {last.blockNumber !== null ? ` in block #${last.blockNumber.toLocaleString('en-US')}` : ''}
              {last.txHash ? ` · tx ${shortId(last.txHash, 14)}` : ''}
              {last.error ? ` · ${last.error}` : ''}
            </div>
          )}
          <div className="actions" style={{ marginTop: 12 }}>
            <Btn tone="pri" arrow disabled={!runId || !anchorable || busy || st?.signer.configured === false} onClick={() => setConfirm(true)}>
              {busy ? 'Anchoring… (waits for finality)' : 'Anchor run'}
            </Btn>
          </div>
        </div>
      </div>

      <div className="lab">Anchored runs (evidence)</div>
      <ErrorBox error={anchors.error} title="Anchors unavailable" />
      {anchors.data?.anchors.length === 0 && <div className="sub">No anchors recorded in this data directory yet.</div>}
      <div className="list" aria-label="Anchors">
        {anchors.data && anchors.data.anchors.length > 0 && (
          <div className="anchor-row rowline h">
            <span>Run</span>
            <span>Method · status</span>
            <span>Block</span>
            <span>Transaction · contract</span>
          </div>
        )}
        {anchors.data?.anchors.map((a) => {
          const href = blockUrl(template, a.blockHash);
          const v = verdicts[a.id];
          return (
            <div key={a.id}>
              <div className="anchor-row">
                <span>
                  <b className="mono-s">{a.runId}</b>
                  <br />
                  <small className="sub mono-s" title={a.runHash}>
                    {shortId(a.runHash, 18)} · {formatTs(a.createdAt)}
                  </small>
                </span>
                <span className={statusTone(a.status)}>
                  {a.method} · {a.status}
                </span>
                <span>
                  {a.blockNumber !== null ? (
                    href ? (
                      <a className="ext" href={href} target="_blank" rel="noreferrer" aria-label={`Open block ${a.blockNumber} in the node console`}>
                        #{a.blockNumber.toLocaleString('en-US')}
                      </a>
                    ) : (
                      `#${a.blockNumber.toLocaleString('en-US')}`
                    )
                  ) : (
                    '—'
                  )}
                </span>
                <span>
                  <span className="mono-s" title={a.txHash ?? undefined}>
                    {a.txHash ? shortId(a.txHash, 20) : a.error ? `failed: ${a.error}` : '—'}
                  </span>
                  {a.contractAddress && (
                    <>
                      <br />
                      <small className="sub mono-s">contract {a.contractAddress}</small>
                    </>
                  )}
                  <br />
                  <Btn small tone="line" disabled={a.status === 'failed' || verifying === a.id} onClick={() => void verify(a.id)}>
                    {verifying === a.id ? 'Verifying…' : 'Verify'}
                  </Btn>
                </span>
              </div>
              {v && (
                <div className={v instanceof ApiError ? 'wbox' : v.verdict === 'verified' ? 'okbox' : 'wbox'} aria-label={`Verification ${a.id}`}>
                  {v instanceof ApiError ? (
                    `Verify failed: ${v.message}`
                  ) : (
                    <>
                      <b>{v.verdict}</b> — hash {v.hashMatches ? 'matches' : 'MISMATCH'}
                      {v.blockHashMatches !== null ? ` · block hash ${v.blockHashMatches ? 'matches' : 'MISMATCH'}` : ''}
                      {v.contractCodePresent !== null ? ` · registry code ${v.contractCodePresent ? 'present' : 'absent'}` : ''}
                      {v.onChainAnchoredAt !== null ? ` · anchoredAt ${new Date(v.onChainAnchoredAt * 1000).toISOString()}` : ''}
                      {v.notes.map((n) => (
                        <div key={n} className="sub">
                          {n}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <AnimatePresence>
        {confirm && (
          <motion.div className="modal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setConfirm(false)}>
            <motion.div className="glass dialog" role="dialog" aria-modal aria-label="Confirm anchor" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.26, ease }} onClick={(e) => e.stopPropagation()}>
              <h2>Anchor on Portaldot V3?</h2>
              <p>
                Writes run <b>{runId}</b> ({method}) to the V3 <b>test</b> network, signed by the backend&apos;s operator key. This spends testnet funds and cannot be undone.
              </p>
              {method === 'contract' && <div className="wbox">{CONTRACT_ANCHOR_COST_NOTE}</div>}
              <div className="actions" style={{ marginTop: 12 }}>
                <Btn onClick={() => setConfirm(false)}>Cancel</Btn>
                <Btn tone="danger" onClick={() => void anchor()}>
                  Anchor
                </Btn>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
