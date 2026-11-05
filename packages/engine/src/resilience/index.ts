/**
 * Proof-of-Resilience (Phase 9): chain-bound, signed run certificates and
 * per-validator resilience scores. See docs/RESILIENCE_SCORE.md and DEC-029.
 */

export {
  CHAIN_EVIDENCE_VERSION,
  CHAIN_EVIDENCE_PHASES,
  DEFAULT_EXPECTED_BLOCK_TIME_MS,
  ChainEvidenceRecorder,
  computeRecoveryMetrics,
  isBlockRef,
} from './evidence';
export type {
  BabeAuthorshipCapture,
  BabeObservedBlockRef,
  BlockRef,
  ChainConsensusCapture,
  ChainEvidence,
  ChainEvidenceGap,
  ChainEvidencePhase,
  ChainEvidenceRecorderOptions,
  ChainObservation,
  HeadReader,
  RecoveryMetrics,
} from './evidence';
export { ChainUnreachableError, createHttpChainReader } from './rpc';
export type { ChainReader, FetchLike, HttpChainReaderOptions } from './rpc';
export {
  BABE_AUTHORSHIP_VERSION,
  DEFAULT_EXPECTED_FINALITY_LAG_BLOCKS,
  DEFAULT_TRANSITION_TOLERANCE_MS,
  GRANDPA_FINALITY_VERSION,
  attributeBabeAuthorship,
  babeSecondaryAuthorIndex,
  buildConsensusEvidence,
  checkGrandpaTransitionHistory,
  classifyFinalityGap,
  classifyFinalityObservations,
  decodeBabePreDigest,
  epochTransitionsFrom,
  stripCompactLengthPrefix,
} from './consensus';
export type {
  AttributeBabeInput,
  BabeAttributionOutcome,
  BabeAuthorship,
  BabeAuthority,
  BabeAuthoritySet,
  BabeEpochContext,
  BabeEpochTransition,
  BabePreDigest,
  BabePreDigestKind,
  ChainConsensusEvidence,
  ClassifyFinalityInput,
  ConsensusContext,
  FinalityClassification,
  GrandpaFinalityObservation,
  GrandpaSetTransition,
} from './consensus';
export { ValidatorDiscovery, authoritySetId, isZeroHash } from './discovery';
export type {
  AuthorityEntry,
  ConsensusRuntime,
  ConsensusRuntimeView,
  DiscoveredValidator,
  EraContext,
  SessionKeySet,
  ValidatorDiscoveryOptions,
  ValidatorDiscoverySnapshot,
} from './discovery';
export { NodeConsensusCapture, PolkadotConsensusRuntime, createNodeConsensusCapture } from './consensus-runtime';
export type { ConsensusRuntimeOptions } from './consensus-runtime';
export {
  KAIZEN_CERTIFICATE_VERSION,
  certificateDocument,
  certificateMessage,
  checkCertificateSignature,
  computeCertificateFingerprint,
  issueCertificate,
} from './certificate';
export type {
  CertificateSignature,
  ResilienceCertificate,
  SignatureCheck,
} from './certificate';
export {
  DEV_RESILIENCE_SIGNER_URI,
  RESILIENCE_SIGNER_ENV_KEY,
  RESILIENCE_SIGNER_FILE_ENV_KEY,
  loadResilienceSigner,
  resilienceSignerConfigured,
} from './signer';
export type { LoadResilienceSignerOptions, ResilienceSigner, ResilienceSignerSource } from './signer';
export { verifyCertificate, verifyChainEvidence } from './verify';
export type {
  BlockCheck,
  CertificateVerification,
  CertificateVerdict,
  ChainCheck,
  ChainCheckStatus,
} from './verify';
export { assessDrill, checkEvidenceIntegrity, scoringFinalityGap } from './integrity';
export type {
  ConsensusIntegrity,
  DrillAssessment,
  DrillOutcome,
  EvidenceCheck,
  EvidenceIntegrity,
} from './integrity';
export { RESILIENCE_SCORE_PARAMS, RESILIENCE_SCORE_VERSION, computeResilienceScore, scoreRun } from './score';
export type { ResilienceScore, ScoredRun, ScoredRunInput } from './score';
export {
  CERTIFICATE_RECORDED_TOPIC,
  EVIDENCE_FLAGS,
  RESILIENCE_REGISTRY_SIGNATURES,
  UNKNOWN_U16,
  UNKNOWN_U32,
  decodeLatest,
  decodeScore,
  encodeGetLatestCall,
  encodeGetScoreCall,
  encodeRecordCall,
  recordInputFromCertificate,
  validatorKey,
} from './registry-abi';
export type { OnChainCertificate, RecordCallInput } from './registry-abi';
export { KAIZEN_RESILIENCE_REGISTRY_ARTIFACT } from './registry-artifact';
export { RESILIENCE_CAPTURE_ENV_KEY, ResilienceService } from './service';
export type { ResilienceServiceOptions } from './service';
