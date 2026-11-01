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

import type { DrillRecord } from './drill-record';
import type { EventBus, KaizenEventMap } from '../events/bus';
import { KaizenError } from '../errors';
import { httpUrlForPort } from '../process/args';
import type { StateStore } from '../state/store';
import type { NodeRecord } from '../types';
import { buildCertificateBundle, type CertificateBundle } from './bundle';
import { issueCertificate, checkCertificateSignature, type ResilienceCertificate } from './certificate';
import { ChainEvidenceRecorder, type ChainEvidence } from './evidence';
import { createHttpChainReader, type ChainReader } from './rpc';
import { classifyEvidence, computeResilienceScore, type EvidenceClass, type ResilienceScore, type ScoredRunInput } from './score';
import { loadResilienceSigner } from './signer';
import { verifyCertificate, verifyChainEvidence, type CertificateVerification } from './verify';

export const RESILIENCE_CAPTURE_ENV_KEY = 'KAIZEN_RESILIENCE_EVIDENCE';

export interface ResilienceServiceOptions {
  store: StateStore;
  events: EventBus;
  capture?: boolean;
  readerForNode?: (node: NodeRecord) => ChainReader;
  recoveryTimeoutMs?: number;
  recoveryIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
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
    });
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
  }

  // -------------------------------------------------------------------------
  // certify / query

  getEvidence(runId: string): ChainEvidence | null {
    return this.store.getResilienceEvidence(runId);
  }

  async certifyRun(runId: string, options: { allowDevKey?: boolean; drill?: DrillRecord } = {}): Promise<ResilienceCertificate> {
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
    const cert = await issueCertificate({ run, chain: evidence, signer, drill: options.drill });
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

  /** v1 score over certificates whose offline integrity check passes. */
  async score(validatorId: string, asOf: Date = new Date()): Promise<ResilienceScore & { excluded: string[] }> {
    return this.scoreCertificates(validatorId, asOf, false);
  }

  /**
   * Score v2 (T-9.7): like v1, but each run's weight is multiplied by its
   * evidence-class factor. Every counted certificate is signed, so it is at
   * least `signed-local`; with `verifyChain` each certificate's block hashes
   * are re-fetched from its network and a full match earns
   * `signed-chain-verified`. An unreachable network never upgrades a class.
   */
  async scoreV2(
    validatorId: string,
    options: { asOf?: Date; verifyChain?: boolean } = {},
  ): Promise<ResilienceScore & { excluded: string[] }> {
    return this.scoreCertificates(validatorId, options.asOf ?? new Date(), true, options.verifyChain === true);
  }

  private async scoreCertificates(
    validatorId: string,
    asOf: Date,
    withEvidenceClass: boolean,
    verifyChain = false,
  ): Promise<ResilienceScore & { excluded: string[] }> {
    const inputs: ScoredRunInput[] = [];
    const excluded: string[] = [];
    for (const cert of this.store.listResilienceCertificates({ validatorId })) {
      let run;
      try {
        run = this.store.getScenarioRun(cert.runId);
      } catch {
        excluded.push(cert.fingerprint);
        continue;
      }
      const check = await checkCertificateSignature(cert, run);
      if (!check.fingerprintMatches || !check.signatureValid || !check.addressMatchesKey || !check.metadataMatches) {
        excluded.push(cert.fingerprint);
        continue;
      }
      let evidenceClass: EvidenceClass | undefined;
      if (withEvidenceClass) {
        const chainVerified =
          verifyChain && (await verifyChainEvidence(cert.chain, this.readerForNetwork(cert.networkId))).status === 'verified';
        evidenceClass = classifyEvidence({ signatureValid: true, chainVerified });
      }
      inputs.push({
        runId: cert.runId,
        runState: run.state,
        recovered: cert.chain.metrics.recovered,
        timeToRecoverMs: cert.chain.metrics.timeToRecoverMs,
        finalityGapBlocks: cert.chain.metrics.finalityGapBlocks,
        blocksMissed: cert.chain.metrics.blocksMissed,
        certifiedAt: cert.signedAt,
        ...(evidenceClass ? { evidenceClass } : {}),
      });
    }
    return { ...computeResilienceScore(validatorId, inputs, asOf), excluded };
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

  /** Certificate + its run in one portable, offline-verifiable document. */
  exportBundle(fingerprint: string): CertificateBundle {
    const cert = this.getCertificate(fingerprint);
    return buildCertificateBundle(cert, this.store.getScenarioRun(cert.runId));
  }

  async verify(fingerprint: string): Promise<CertificateVerification> {
    const cert = this.getCertificate(fingerprint);
    const run = this.store.getScenarioRun(cert.runId);
    return verifyCertificate(cert, run, this.readerForNetwork(cert.networkId));
  }
}
