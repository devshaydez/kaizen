/**
 * ResilienceService (T-9.5) — the engine surface of Proof-of-Resilience.
 *
 *  - capture: when enabled (`KAIZEN_RESILIENCE_EVIDENCE=1` or the engine
 *    option), listens to scenario-run and fault events and records chain
 *    evidence for each run from a reference observer node that is NOT the
 *    fault target: before-fault heads at run start, during-fault heads at
 *    fault start and just before it is lifted, after-recovery heads polled
 *    after the run finishes until finality advances (bounded). Evidence is
 *    stored per run; nothing is signed automatically.
 *  - certify: explicit; signs the run + evidence (T-9.2) and stores the
 *    certificate (idempotent by fingerprint).
 *  - score / verify: pure score over a validator's certificates (excluding
 *    integrity failures) and the full verification (T-9.1).
 */

import type { EventBus, KaizenEventMap } from '../events/bus';
import { KaizenError } from '../errors';
import { httpUrlForPort } from '../process/args';
import type { StateStore } from '../state/store';
import type { NodeRecord } from '../types';
import { issueCertificate, checkCertificateSignature, type ResilienceCertificate } from './certificate';
import { ChainEvidenceRecorder, type ChainConsensusCapture, type ChainEvidence } from './evidence';
import { assessDrill, scoringFinalityGap } from './integrity';
import { createHttpChainReader, type ChainReader } from './rpc';
import { computeResilienceScore, type ResilienceScore } from './score';
import { loadResilienceSigner } from './signer';
import { verifyCertificate, type CertificateVerification } from './verify';

export const RESILIENCE_CAPTURE_ENV_KEY = 'KAIZEN_RESILIENCE_EVIDENCE';

export interface ResilienceServiceOptions {
  store: StateStore;
  events: EventBus;
  capture?: boolean;
  readerForNode?: (node: NodeRecord) => ChainReader;
  recoveryTimeoutMs?: number;
  recoveryIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Consensus capture source (BABE authorship / GRANDPA finality / era).
   * A factory receives the observer node and should read that node's own
   * endpoint. Optional: when absent, recorded evidence carries no consensus
   * context and is honestly marked incomplete for consensus (never
   * fabricated).
   */
  consensus?: ChainConsensusCapture | ((observer: NodeRecord) => ChainConsensusCapture | undefined);
}

interface ActiveCapture {
  runId: string;
  networkId: string;
  recorder: ChainEvidenceRecorder | null;
  targetNodeIds: Set<string>;
  observer: NodeRecord | null;
  validatorId: string | null;
  faultActive: boolean;
  chain: Promise<void>;
}

export class ResilienceService {
  private readonly store: StateStore;
  private readonly readerForNode: (node: NodeRecord) => ChainReader;
  private readonly active = new Map<string, ActiveCapture>(); // by networkId
  private readonly unsubs: Array<() => void> = [];
  private readonly pending = new Set<Promise<void>>();
  private readonly consensusByNode = new Map<string, ChainConsensusCapture | null>();
  private readonly ownedCaptures = new Set<{ close(): Promise<void> }>();
  readonly captureEnabled: boolean;

  constructor(private readonly opts: ResilienceServiceOptions) {
    this.store = opts.store;
    this.readerForNode = opts.readerForNode ?? ((n) => createHttpChainReader(httpUrlForPort(n.ports.rpc)));
    const env = opts.env ?? process.env;
    this.captureEnabled = opts.capture ?? env[RESILIENCE_CAPTURE_ENV_KEY] === '1';
    if (this.captureEnabled) this.attach();
  }

  // -------------------------------------------------------------------------
  // capture

  private attach(): void {
    this.unsubs.push(
      this.opts.events.subscribe((name, payload) => {
        if (name === 'scenario-run.created') {
          const p = payload as KaizenEventMap['scenario-run.created'];
          this.onRunCreated(p.runId, p.networkId);
        } else if (name === 'fault.state') {
          this.onFault(payload as KaizenEventMap['fault.state']);
        } else if (name === 'scenario-run.finished') {
          const p = payload as KaizenEventMap['scenario-run.finished'];
          this.onRunFinished(p.runId, p.networkId);
        }
      }),
    );
  }

  private enqueue(cap: ActiveCapture, step: () => Promise<void>): void {
    const next = cap.chain.then(step).catch(() => undefined);
    cap.chain = next;
    this.pending.add(next);
    void next.finally(() => this.pending.delete(next));
  }

  private pickObserver(networkId: string, exclude: Set<string>): NodeRecord | null {
    const nodes = this.store.listNodes(networkId).filter((n) => n.status === 'running');
    return nodes.find((n) => !exclude.has(n.id)) ?? null;
  }

  private onRunCreated(runId: string, networkId: string): void {
    let targets = new Set<string>();
    try {
      targets = new Set(this.store.getScenarioRun(runId).targetNodes.map((t) => t.nodeId));
    } catch {
      /* run row not readable yet: no exclusions until the fault names its target */
    }
    const observer = this.pickObserver(networkId, targets);
    const cap: ActiveCapture = {
      runId,
      networkId,
      recorder: null,
      targetNodeIds: targets,
      observer,
      validatorId: null,
      faultActive: false,
      chain: Promise.resolve(),
    };
    this.active.set(networkId, cap);
    if (observer) {
      cap.recorder = this.newRecorder(cap, observer);
      this.enqueue(cap, async () => {
        await cap.recorder?.observe('before-fault');
      });
    }
  }

  private newRecorder(cap: ActiveCapture, observer: NodeRecord): ChainEvidenceRecorder {
    return new ChainEvidenceRecorder({
      networkId: cap.networkId,
      validatorId: cap.validatorId ?? 'unknown',
      observerNodeId: observer.id,
      reader: this.readerForNode(observer),
      consensus: this.consensusFor(observer),
    });
  }

  /** Resolve (and own, for lifecycle) the consensus source for one observer. */
  private consensusFor(observer: NodeRecord): ChainConsensusCapture | undefined {
    const cached = this.consensusByNode.get(observer.id);
    if (cached !== undefined) return cached ?? undefined;
    const source = this.opts.consensus;
    const resolved = typeof source === 'function' ? source(observer) : source;
    this.consensusByNode.set(observer.id, resolved ?? null);
    if (resolved && typeof (resolved as unknown as { close?: unknown }).close === 'function') {
      this.ownedCaptures.add(resolved as unknown as { close(): Promise<void> });
    }
    return resolved;
  }

  private onFault(p: KaizenEventMap['fault.state']): void {
    const cap = this.active.get(p.networkId);
    if (!cap) return;
    if (p.to === 'executing' && !cap.faultActive) {
      cap.faultActive = true;
      cap.validatorId = p.nodeName;
      cap.targetNodeIds.add(p.nodeId);
      // The observer must not be the faulted node; re-pick if needed. A
      // re-picked observer has no before-fault reading (recorded as a gap).
      if (!cap.observer || cap.observer.id === p.nodeId) {
        cap.observer = this.pickObserver(p.networkId, cap.targetNodeIds);
        cap.recorder = cap.observer ? this.newRecorder(cap, cap.observer) : null;
      }
      const startedAt = new Date(p.at);
      this.enqueue(cap, async () => {
        cap.recorder?.markFaultStarted(startedAt);
        await cap.recorder?.observe('during-fault');
      });
    } else if (cap.faultActive && ['cleaning-up', 'completed', 'failed', 'cancelled', 'cleanup-failed'].includes(p.to)) {
      cap.faultActive = false;
      this.enqueue(cap, async () => {
        await cap.recorder?.observe('during-fault');
        cap.recorder?.markFaultEnded(new Date());
      });
    }
  }

  private onRunFinished(runId: string, networkId: string): void {
    const cap = this.active.get(networkId);
    if (!cap || cap.runId !== runId) return;
    this.active.delete(networkId);
    this.enqueue(cap, async () => {
      if (!cap.recorder || cap.validatorId === null) return; // no fault executed → nothing to certify
      await cap.recorder.awaitRecovery({
        timeoutMs: this.opts.recoveryTimeoutMs ?? 60_000,
        intervalMs: this.opts.recoveryIntervalMs ?? 2_000,
      });
      const evidence = { ...cap.recorder.finish(), validatorId: cap.validatorId };
      this.store.upsertResilienceEvidence(runId, evidence);
    });
  }

  /** Wait for in-flight captures (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  async close(): Promise<void> {
    for (const u of this.unsubs.splice(0)) u();
    await this.idle();
    for (const capture of this.ownedCaptures) {
      await capture.close().catch(() => undefined);
    }
    this.ownedCaptures.clear();
    this.consensusByNode.clear();
  }

  // -------------------------------------------------------------------------
  // certify / query

  getEvidence(runId: string): ChainEvidence | null {
    return this.store.getResilienceEvidence(runId);
  }

  async certifyRun(runId: string, options: { allowDevKey?: boolean } = {}): Promise<ResilienceCertificate> {
    const run = this.store.getScenarioRun(runId);
    const evidence = this.store.getResilienceEvidence(runId);
    if (!evidence) {
      throw new KaizenError(
        'RESILIENCE_NOT_CERTIFIABLE',
        `run ${runId} has no chain evidence (capture with ${RESILIENCE_CAPTURE_ENV_KEY}=1 while the run executes)`,
      );
    }
    let localTestNetwork = false;
    try {
      localTestNetwork = this.store.getNetwork(run.networkId).designatedTest;
    } catch {
      localTestNetwork = false;
    }
    const signer = await loadResilienceSigner({
      env: this.opts.env,
      allowDevKey: options.allowDevKey,
      localTestNetwork,
    });
    const cert = await issueCertificate({ run, chain: evidence, signer });
    if (!this.store.insertResilienceCertificate(cert)) {
      return this.store.getResilienceCertificate(cert.fingerprint) ?? cert;
    }
    this.opts.events.emit('resilience.certified', {
      fingerprint: cert.fingerprint,
      runId,
      validatorId: cert.validatorId,
      networkId: cert.networkId,
      dev: cert.signature.dev,
      at: cert.signedAt,
    });
    return cert;
  }

  listCertificates(filter: { validatorId?: string; runId?: string } = {}): ResilienceCertificate[] {
    return this.store.listResilienceCertificates(filter);
  }

  getCertificate(fingerprint: string): ResilienceCertificate {
    const cert = this.store.getResilienceCertificate(fingerprint);
    if (!cert) throw new KaizenError('RESILIENCE_CERTIFICATE_NOT_FOUND', `no certificate ${fingerprint}`);
    return cert;
  }

  /** Distinct validators with at least one certificate. */
  listValidators(): string[] {
    return [...new Set(this.store.listResilienceCertificates().map((c) => c.validatorId))].sort();
  }

  /**
   * Score over certificates whose offline integrity check passes AND whose
   * evidence supports a drill outcome. Inconclusive evidence (tampered
   * metrics, missing phases, underivable metrics) is excluded with a reason;
   * a `failed` drill is eligible and scores 0 quality. Expected GRANDPA set
   * transitions are removed from the finality signal before scoring.
   */
  async score(
    validatorId: string,
    asOf: Date = new Date(),
  ): Promise<ResilienceScore & { excluded: string[]; excludedReasons: Record<string, string> }> {
    const inputs = [];
    const excluded: string[] = [];
    const excludedReasons: Record<string, string> = {};
    const exclude = (fingerprint: string, reason: string) => {
      excluded.push(fingerprint);
      excludedReasons[fingerprint] = reason;
    };
    for (const cert of this.store.listResilienceCertificates({ validatorId })) {
      let run;
      try {
        run = this.store.getScenarioRun(cert.runId);
      } catch {
        exclude(cert.fingerprint, 'run record is no longer available');
        continue;
      }
      const check = await checkCertificateSignature(cert, run);
      if (!check.fingerprintMatches || !check.signatureValid || !check.addressMatchesKey || !check.metadataMatches) {
        exclude(cert.fingerprint, 'certificate integrity check failed');
        continue;
      }
      const assessment = assessDrill(cert.chain, run.state);
      if (typeof cert.evidenceHash === 'string' && cert.evidenceHash !== assessment.integrity.evidenceHash) {
        exclude(cert.fingerprint, 'stored evidenceHash does not match the evidence document');
        continue;
      }
      if (assessment.outcome === 'inconclusive') {
        exclude(cert.fingerprint, `evidence inconclusive: ${assessment.reasons.join('; ')}`);
        continue;
      }
      inputs.push({
        runId: cert.runId,
        runState: run.state,
        recovered: cert.chain.metrics.recovered,
        timeToRecoverMs: cert.chain.metrics.timeToRecoverMs,
        finalityGapBlocks: scoringFinalityGap(cert.chain),
        blocksMissed: cert.chain.metrics.blocksMissed,
        certifiedAt: cert.signedAt,
        evidenceOutcome: assessment.outcome,
        consensusComplete: cert.chain.consensus ? !cert.chain.consensus.incomplete : false,
      });
    }
    return { ...computeResilienceScore(validatorId, inputs, asOf), excluded, excludedReasons };
  }

  /** Reader for a network's chain, or null when no node is running (offline). */
  readerForNetwork(networkId: string): ChainReader | null {
    try {
      const node = this.store.listNodes(networkId).find((n) => n.status === 'running');
      return node ? this.readerForNode(node) : null;
    } catch {
      return null;
    }
  }

  async verify(fingerprint: string): Promise<CertificateVerification> {
    const cert = this.getCertificate(fingerprint);
    const run = this.store.getScenarioRun(cert.runId);
    return verifyCertificate(cert, run, this.readerForNetwork(cert.networkId));
  }
}
