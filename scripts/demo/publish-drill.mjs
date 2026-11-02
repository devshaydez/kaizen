#!/usr/bin/env node
/**
 * Public live demo: turn one CI drill into a published, verifiable bundle.
 *
 * Input:  $KAIZEN_ATTESTATION_DIR (written by test/integration/resilience.int.test.ts)
 *           certificate-*.json, run.json, verification-online.json,
 *           verification-offline.json, score.json
 * Output: $KAIZEN_DEMO_OUT/drills/<id>.json and an updated index.json
 *
 * Steps
 *  1. Recompute the certificate fingerprint from the run record + chain
 *     evidence (same canonical JSON as packages/engine). Refuse to publish
 *     if it does not match: the bundle must verify for anyone.
 *  2. If KAIZEN_V3_SIGNER_SURI is set, anchor the fingerprint on the
 *     Portaldot V3 TEST network with System.remarkWithEvent
 *     ("kaizen:certificate:v1:<fingerprint>") and record block + extrinsic.
 *     The secret is read from the environment only and never printed.
 *  3. Write the bundle. Nothing here is mocked; a failed anchor is recorded
 *     as failed, never as success.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IN = process.env.KAIZEN_ATTESTATION_DIR;
const OUT = process.env.KAIZEN_DEMO_OUT;
const V3_WS = process.env.KAIZEN_V3_WS ?? 'wss://test-node-v3.portaldot.dev';
if (!IN || !OUT) {
  console.error('KAIZEN_ATTESTATION_DIR and KAIZEN_DEMO_OUT are required');
  process.exit(2);
}

function canonicalJson(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
    }
    default:
      throw new Error(`unsupported ${typeof value}`);
  }
}
const sha256 = (s) => `0x${createHash('sha256').update(s, 'utf8').digest('hex')}`;
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(IN, f), 'utf8'));

const certFile = fs.readdirSync(IN).find((f) => /^certificate-.*\.json$/.test(f));
if (!certFile) {
  console.error('no certificate in attestation dir');
  process.exit(3);
}
const certificate = readJson(certFile);
const run = readJson('run.json');
const opt = (f) => (fs.existsSync(path.join(IN, f)) ? readJson(f) : null);

const runHash = sha256(canonicalJson({ kaizenAnchor: 1, run }));
const fingerprint = sha256(canonicalJson({ kaizenCertificate: 1, runHash, run, chain: certificate.chain }));
if (runHash !== certificate.runHash || fingerprint !== certificate.fingerprint) {
  console.error(`recomputation mismatch: runHash ${runHash} vs ${certificate.runHash}; fingerprint ${fingerprint} vs ${certificate.fingerprint}`);
  process.exit(4);
}
console.log(`fingerprint recomputed and matches: ${fingerprint}`);

let anchor = { status: 'skipped', reason: 'no V3 signer configured for this run' };
const suri = process.env.KAIZEN_V3_SIGNER_SURI;
if (suri) {
  const scrub = (t) => String(t).split(suri).join('<redacted>');
  try {
    const { ApiPromise, WsProvider, Keyring } = await import('@polkadot/api');
    const api = await ApiPromise.create({ provider: new WsProvider(V3_WS), noInitWarn: true });
    const signer = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(suri);
    const remark = `kaizen:certificate:v1:${fingerprint}`;
    const tx = api.tx.system.remarkWithEvent(remark);
    anchor = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('anchor timed out after 180s')), 180_000);
      tx.signAndSend(signer, ({ status, dispatchError, txIndex }) => {
        if (dispatchError) {
          clearTimeout(timer);
          reject(new Error(`dispatch error: ${dispatchError.toString()}`));
          return;
        }
        if (status.isInBlock || status.isFinalized) {
          const blockHash = (status.isFinalized ? status.asFinalized : status.asInBlock).toHex();
          clearTimeout(timer);
          resolve({ status: status.isFinalized ? 'finalized' : 'in-block', blockHash, extrinsicIndex: txIndex ?? null, txHash: tx.hash.toHex(), remark, signer: signer.address });
        }
      }).catch(reject);
    });
    const header = await api.rpc.chain.getHeader(anchor.blockHash);
    anchor.blockNumber = header.number.toNumber();
    anchor.network = { ws: V3_WS, genesisHash: api.genesisHash.toHex() };
    await api.disconnect();
    console.log(`anchored on V3 block ${anchor.blockNumber} (${anchor.status})`);
  } catch (err) {
    anchor = { status: 'failed', reason: scrub(err?.message ?? err) };
    console.error(`anchor failed: ${anchor.reason}`);
  }
}

const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${fingerprint.slice(2, 10)}`;
const workflow = process.env.GITHUB_RUN_ID
  ? { runId: process.env.GITHUB_RUN_ID, url: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`, event: process.env.GITHUB_EVENT_NAME, sha: process.env.GITHUB_SHA }
  : null;
const bundle = {
  kaizenDemoBundle: 1,
  id,
  publishedAt: new Date().toISOString(),
  certificate,
  run,
  verificationOnline: opt('verification-online.json'),
  verificationOffline: opt('verification-offline.json'),
  score: opt('score.json'),
  anchor,
  workflow,
};

fs.mkdirSync(path.join(OUT, 'drills'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'drills', `${id}.json`), JSON.stringify(bundle, null, 2));
const idxPath = path.join(OUT, 'index.json');
const index = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, 'utf8')) : { drills: [] };
index.drills.unshift({
  id,
  publishedAt: bundle.publishedAt,
  fingerprint,
  validatorId: certificate.validatorId,
  recovered: certificate.chain?.metrics?.recovered ?? null,
  timeToRecoverMs: certificate.chain?.metrics?.timeToRecoverMs ?? null,
  finalityGapBlocks: certificate.chain?.metrics?.finalityGapBlocks ?? null,
  score: bundle.score?.score ?? null,
  anchor: {
    status: anchor.status,
    txHash: anchor.txHash ?? null,
    blockNumber: anchor.blockNumber ?? null,
    finality: anchor.status === 'finalized' ? 'finalized' : anchor.status === 'in-block' ? 'in-block' : null,
    signerAddress: anchor.signer ?? null,
  },
  workflowUrl: workflow?.url ?? null,
});
index.drills = index.drills.slice(0, 200);
index.updatedAt = bundle.publishedAt;
fs.writeFileSync(idxPath, JSON.stringify(index, null, 2));
console.log(`published drills/${id}.json`);
