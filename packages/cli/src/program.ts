/**
 * kaizen — CLI program (command tree + actions).
 *
 * The CLI calls the SAME engine services as the API (DEC-002): it constructs
 * an in-process engine and never implements operational logic of its own.
 * Scenario execution/replay go through `engine.scenarioRuns.execute()` /
 * `.replay()` exactly like the API (DEC-021) — one executor, one gate chain,
 * one injector pipeline; the CLI adds no second execution path and holds no
 * network listener of its own.
 *
 * Output contract (unchanged from the original CLI):
 *  - human-readable text by default
 *  - `--json` for machine-readable output (stable envelope)
 *  - exit code 0 on success, 1 on any failure
 *
 * `buildProgram()` is exported (with an engine-factory DI seam) so tests can
 * drive real commands against a real engine without spawning a process.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { formatUpSummary, kaizenUp, UP_DEFAULT_NAME, UP_DEFAULT_PRESET } from './up';
import {
  createEngine,
  isKaizenError,
  KaizenError,
  KAIZEN_VERSION,
  isTerminalScenarioRunState,
  scenarioRunReplayNote,
  SCENARIO_RUN_STATES,
  toErrorJson,
  type CustomTopologyInput,
  type KaizenEngine,
  type NetworkPreset,
  type NodeRole,
  type OperationResult,
  type ScenarioListFilter,
  type ScenarioPage,
  type ScenarioRecord,
  type ScenarioRunListFilter,
  type ScenarioRunPage,
  type ScenarioRunRecord,
  type ScenarioRunState,
  type ScenarioRunSummary,
  type ScenarioValidationResult,
  type SerializedOperationDefinition,
  probeV3Connectivity,
  createHttpChainReader,
  parseCertificateBundle,
  verifyCertificateBundle,
  type CertificateVerification,
  type KaizenAttestation,
  ATTESTATION_SIGNER_ENV_KEY,
  ResilienceRegistryService,
  type ResilienceCertificate,
  type ResilienceChainJournalEntry,
  type V3AnchorMethod,
  type V3AnchorRecord,
  type V3ConnectivityReport,
} from '@kaizen/engine';

interface GlobalOpts {
  json?: boolean;
  dataDir?: string;
}

export interface CliDependencies {
  /** Engine factory (DI seam for tests). Default: in-process createEngine. */
  engineFactory?: () => KaizenEngine;
  /** On-chain resilience registry client (DI seam for tests). */
  resilienceRegistryFactory?: () => ResilienceRegistryService;
}

/** Run outcomes that count as success for scripting. */
const SUCCESS_RUN_STATES = new Set<ScenarioRunState>(['completed', 'completed-with-warnings']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildProgram(deps: CliDependencies = {}): Command {
  const program = new Command();

  program
    .name('kaizen')
    .description('Kaizen — Portaldot node operations platform (CLI)')
    .version(KAIZEN_VERSION)
    .option('--json', 'machine-readable JSON output')
    .option('--data-dir <path>', 'Kaizen data directory (default: $KAIZEN_DATA_DIR or ./.kaizen)');

  const getOpts = (): GlobalOpts => program.opts<GlobalOpts>();

  function printJson(payload: unknown): void {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }

  function printResult(result: OperationResult): void {
    if (result.ok) {
      console.log(
        `${result.kind} OK — network ${result.networkId ?? '-'} (${result.durationMs}ms, operation #${result.operationId})`,
      );
    } else {
      console.error(
        `${result.kind} FAILED — [${result.error?.code ?? 'ERROR'}] ${result.error?.message ?? 'unknown error'}`,
      );
    }
  }

  /**
   * Shared runner: constructs an in-process engine (or the injected factory),
   * runs the action, converts any error into a structured envelope, and sets
   * the exit code.
   */
  async function run(
    fn: (engine: KaizenEngine, opts: GlobalOpts) => Promise<void>,
  ): Promise<void> {
    const opts = getOpts();
    const engine =
      deps.engineFactory ??
      (() =>
        createEngine({
          dataDir: opts.dataDir ? path.resolve(opts.dataDir) : undefined,
        }));
    const instance = engine();
    try {
      await fn(instance, opts);
    } catch (e) {
      const err = toErrorJson(e);
      if (opts.json) printJson({ ok: false, error: err });
      else console.error(`ERROR [${err.code}] ${err.message}`);
      process.exitCode = 1;
    } finally {
      await instance.close();
    }
  }

  // ---------------------------------------------------------------------------
  // setup / status

  program
    .command('setup')
    .description('Explicitly download and verify the Portaldot node binary (never happens implicitly)')
    .action(async () => {
      await run(async (engine, opts) => {
        const entry = await engine.binaries.setup();
        if (opts.json) {
          printJson({ ok: true, binary: entry });
          return;
        }
        console.log('Portaldot node binary ready:');
        console.log(`  version : ${entry.binaryVersion}`);
        console.log(`  platform: ${entry.platform}`);
        console.log(`  sha256  : ${entry.sha256}`);
        console.log(`  source  : ${entry.sourceUrl}`);
        console.log(`  path    : ${engine.binaries.nodePath()}`);
      });
    });

  program
    .command('status')
    .description('Show binary availability (never downloads)')
    .action(async () => {
      await run(async (engine, opts) => {
        const status = await engine.binaries.status();
        if (opts.json) {
          printJson({ ok: status.available, status });
          if (!status.available) process.exitCode = 1;
          return;
        }
        console.log(status.available ? 'Binary: available' : 'Binary: NOT available');
        if (status.entry) {
          console.log(`  version: ${status.entry.binaryVersion}`);
          console.log(`  sha256 : ${status.entry.sha256}`);
        }
        for (const problem of status.problems) console.log(`  - ${problem}`);
        if (!status.available) process.exitCode = 1;
      });
    });

  program
    .command('up')
    .description(
      'One command to a running local network: setup the binary if missing, create (or reuse) a preset network, start it health-gated, print endpoints',
    )
    .option('-n, --name <name>', 'network name (reused if it already exists)', UP_DEFAULT_NAME)
    .option('-p, --preset <preset>', 'preset for a new network: single-node | two-node | four-validator | validator-fullnode', UP_DEFAULT_PRESET)
    .option('-t, --target <target>', 'local (docker and kubernetes are planned — Phase 6)', 'local')
    .option('--no-setup', 'fail instead of downloading the binary when it is missing')
    .action(async (cmdOpts: { name: string; preset: string; target: string; setup: boolean }) => {
      await run(async (engine, opts) => {
        const summary = await kaizenUp(engine, cmdOpts, opts.json ? undefined : (l) => console.log(l));
        if (opts.json) {
          printJson(summary);
        } else if (summary.ok) {
          console.log('');
          for (const l of formatUpSummary(summary)) console.log(l);
        } else {
          console.error(`start FAILED — [${summary.error?.code}] ${summary.error?.message}`);
        }
        if (!summary.ok) process.exitCode = 1;
      });
    });

  // ---------------------------------------------------------------------------
  // network

  const network = program.command('network').description('Network operations');

  /**
   * Parse a custom topology spec string into typed input:
   *   "alice:validator,backup:validator:ferdie,full-1:full"
   *   → name:role[:wellKnownKey]. Validation happens in the engine; the CLI
   *   only translates syntax and reports parse errors as INVALID_INPUT.
   */
  function parseCustomNodes(spec: string): CustomTopologyInput {
    const nodes = spec.split(',').map((chunk) => {
      const parts = chunk.trim().split(':');
      const [name, role, key] = parts;
      if (!name || (role !== 'validator' && role !== 'full')) {
        throw new Error(
          `Invalid node "${chunk}" — expected name:role[:wellKnownKey] with role validator|full`,
        );
      }
      return { name: name.trim(), role: role as NodeRole, wellKnownKey: key?.trim() };
    });
    return { nodes };
  }

  network
    .command('create <name>')
    .description('Create a network definition (does not start it)')
    .option(
      '-p, --preset <preset>',
      'single-node | two-node | four-validator | validator-fullnode | custom',
      'single-node',
    )
    .option(
      '--nodes <spec>',
      'custom topology: "name:role[:wellKnownKey],…" (e.g. "alice:validator,full-1:full")',
    )
    .action(async (name: string, cmdOpts: { preset: string; nodes?: string }) => {
      await run(async (engine, opts) => {
        let custom: CustomTopologyInput | undefined;
        if (cmdOpts.nodes) {
          try {
            custom = parseCustomNodes(cmdOpts.nodes);
          } catch (e) {
            throw new KaizenError('INVALID_INPUT', e instanceof Error ? e.message : String(e));
          }
        }
        const record = await engine.networks.create({
          name,
          preset: cmdOpts.preset as NetworkPreset,
          custom,
        });
        if (opts.json) {
          printJson({ ok: true, network: record });
          return;
        }
        console.log(`Created network "${record.name}" (${record.id})`);
        console.log(`  preset  : ${record.preset}`);
        console.log(`  chain   : ${record.chain}`);
        console.log(`  baseDir : ${record.baseDir}`);
        console.log(`  test net: ${record.designatedTest ? 'yes' : 'no'}`);
        const { nodes } = engine.networks.getNetwork(record.id);
        for (const node of nodes) {
          console.log(
            `  node ${node.id}  ${node.name.padEnd(20)} role=${node.role.padEnd(9)} ${node.wellKnownKey ? `key=${node.wellKnownKey.padEnd(8)}` : 'key=-'} ports=${node.ports.p2p}/${node.ports.rpc}/${node.ports.ws}/${node.ports.prometheus}`,
          );
        }
      });
    });

  network
    .command('list')
    .description('List networks')
    .action(async () => {
      await run(async (engine, opts) => {
        const networks = engine.networks.list();
        if (opts.json) {
          printJson({ ok: true, networks });
          return;
        }
        if (networks.length === 0) {
          console.log('No networks yet. Create one with: kaizen network create <name>');
          return;
        }
        for (const n of networks) {
          console.log(
            `${n.id}  ${n.name.padEnd(20)} ${n.preset.padEnd(12)} ${n.status.padEnd(9)} nodes=${n.nodeCount}`,
          );
        }
      });
    });

  network
    .command('start <idOrName>')
    .description('Start all nodes of a network and wait until healthy')
    .action(async (idOrName: string) => {
      await run(async (engine, opts) => {
        const result = await engine.networks.start(idOrName);
        if (opts.json) printJson({ ok: result.ok, result });
        else printResult(result);
        if (!result.ok) process.exitCode = 1;
      });
    });

  network
    .command('stop <idOrName>')
    .description('Stop all nodes of a network (SIGTERM, escalating to SIGKILL)')
    .action(async (idOrName: string) => {
      await run(async (engine, opts) => {
        const result = await engine.networks.stop(idOrName);
        if (opts.json) printJson({ ok: result.ok, result });
        else printResult(result);
        if (!result.ok) process.exitCode = 1;
      });
    });

  network
    .command('status <idOrName>')
    .description('Inspect real node state via RPC (health, peers, block height)')
    .action(async (idOrName: string) => {
      await run(async (engine, opts) => {
        const inspection = await engine.networks.inspect(idOrName);
        if (opts.json) {
          printJson({ ok: true, inspection });
          return;
        }
        console.log(`Network ${inspection.name} (${inspection.networkId}) — ${inspection.status}`);
        for (const node of inspection.nodes) {
          const proc = `process=${node.process.state}${node.process.pid ? ` pid=${node.process.pid}` : ''}`;
          if (node.snapshot) {
            const s = node.snapshot;
            console.log(
              `  ${node.name.padEnd(24)} ${proc}  chain=${s.chain} height=${s.head.number} peers=${s.health.peers} syncing=${s.health.isSyncing} spec=${s.runtime.specName}@${s.runtime.specVersion}`,
            );
          } else {
            console.log(
              `  ${node.name.padEnd(24)} ${proc}  RPC unreachable: ${node.rpcError ?? 'unknown'}`,
            );
          }
        }
      });
    });

  network
    .command('remove <idOrName>')
    .description('Remove a stopped network and its on-disk state')
    .action(async (idOrName: string) => {
      await run(async (engine, opts) => {
        await engine.networks.remove(idOrName);
        if (opts.json) printJson({ ok: true, removed: idOrName });
        else console.log(`Removed network ${idOrName}`);
      });
    });

  network
    .command('purge <idOrName>')
    .description('Delete all node chain databases (keeps identities, ports, spec) so the next start boots from genesis')
    .action(async (idOrName: string) => {
      await run(async (engine, opts) => {
        const result = await engine.networks.purgeChain(idOrName);
        if (opts.json) printJson({ ok: result.ok, result });
        else printResult(result);
        if (!result.ok) process.exitCode = 1;
      });
    });

  network
    .command('monitor <idOrName>')
    .description('Sample every node now via real HTTP RPC and show health, peers, head/finalized')
    .action(async (idOrName: string) => {
      await run(async (engine, opts) => {
        const snapshot = await engine.monitoring.snapshotNow(idOrName);
        if (opts.json) {
          printJson({ ok: true, snapshot });
          return;
        }
        console.log(`Monitoring ${snapshot.name} (${snapshot.networkId}) at ${snapshot.at}`);
        for (const sample of snapshot.samples) {
          const health = snapshot.health.find((h) => h.nodeId === sample.nodeId);
          const proc = `process=${sample.process.status}${sample.process.pid ? ` pid=${sample.process.pid}` : ''}`;
          const chain = sample.rpc.reachable
            ? `head=#${sample.head?.number ?? '?'} finalized=#${sample.finalized?.number ?? '?'} peers=${sample.peers?.count ?? '?'}/${sample.peers?.expected ?? '?'}${sample.health?.isSyncing ? ' syncing' : ''}`
            : `RPC unreachable: ${sample.rpc.error ?? 'unknown'}`;
          console.log(`  ${sample.name.padEnd(24)} [${health?.state ?? 'unknown'}] ${proc}  ${chain}`);
          for (const reason of health?.reasons ?? []) console.log(`      - ${reason}`);
        }
      });
    });

  // ---------------------------------------------------------------------------
  // node (per-node lifecycle)

  const node = program.command('node').description('Single-node operations');

  node
    .command('list <network>')
    .description('List the nodes of a network with persisted configuration')
    .action(async (networkIdOrName: string) => {
      await run(async (engine, opts) => {
        const { network, nodes } = engine.networks.getNetwork(networkIdOrName);
        if (opts.json) {
          printJson({ ok: true, networkId: network.id, nodes });
          return;
        }
        for (const n of nodes) {
          console.log(
            `${n.id}  ${n.name.padEnd(20)} role=${n.role.padEnd(9)} status=${n.status.padEnd(8)} ${n.wellKnownKey ? `key=${n.wellKnownKey}` : ''} expectedPeers=${n.expectedPeers ?? 0}`,
          );
        }
      });
    });

  node
    .command('get <nodeId>')
    .description('Show one node: persisted config + latest monitoring sample/health if any')
    .action(async (nodeId: string) => {
      await run(async (engine, opts) => {
        const record = engine.store.tryGetNode(nodeId);
        if (!record) throw new KaizenError('NODE_NOT_FOUND', `No node with id "${nodeId}"`, { nodeId });
        const snapshot = engine.monitoring.getLatest(record.networkId);
        const sample = snapshot?.samples.find((s) => s.nodeId === nodeId) ?? null;
        const health = snapshot?.health.find((h) => h.nodeId === nodeId) ?? null;
        if (opts.json) {
          printJson({ ok: true, node: record, sample, health });
          return;
        }
        console.log(`${record.id} — ${record.name} (${record.networkId})`);
        console.log(`  role    : ${record.role}${record.wellKnownKey ? ` (key ${record.wellKnownKey})` : ''}`);
        console.log(`  status  : ${record.status}${record.pid ? ` pid=${record.pid}` : ''}`);
        console.log(`  ports   : p2p=${record.ports.p2p} rpc=${record.ports.rpc} ws=${record.ports.ws} prom=${record.ports.prometheus}`);
        console.log(`  expected peers: ${record.expectedPeers ?? 0}`);
        if (sample) {
          console.log(
            `  sample  : head=#${sample.head?.number ?? '?'} finalized=#${sample.finalized?.number ?? '?'} peers=${sample.peers?.count ?? '?'} rpc=${sample.rpc.reachable ? 'ok' : 'unreachable'}`,
          );
          console.log(`  health  : ${health?.state ?? 'unknown'} — ${(health?.reasons ?? []).join('; ')}`);
        } else {
          console.log('  sample  : none yet (start the network or run kaizen network monitor)');
        }
      });
    });

  node
    .command('start <nodeId>')
    .description('Start a single node of a network')
    .action(async (nodeId: string) => {
      await run(async (engine, opts) => {
        const result = await engine.networks.startNode(nodeId);
        if (opts.json) printJson({ ok: result.ok, result });
        else printResult(result);
        if (!result.ok) process.exitCode = 1;
      });
    });

  node
    .command('stop <nodeId>')
    .description('Stop a single node of a network (keeps its chain data)')
    .action(async (nodeId: string) => {
      await run(async (engine, opts) => {
        const result = await engine.networks.stopNode(nodeId);
        if (opts.json) printJson({ ok: result.ok, result });
        else printResult(result);
        if (!result.ok) process.exitCode = 1;
      });
    });

  // ---------------------------------------------------------------------------
  // scenario (authoring — saving/validating NEVER executes anything)

  const scenarioCmd = program
    .command('scenario')
    .description('Scenario authoring (validation + storage only — authoring never executes anything)');

  function readScenarioFile(file: string): unknown {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw new KaizenError(
        'INVALID_INPUT',
        `Cannot read scenario file "${file}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (e) {
      throw new KaizenError(
        'INVALID_INPUT',
        `Scenario file "${file}" is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  function printScenarioDetail(record: ScenarioRecord): void {
    console.log(`${record.id} — ${record.name} (${record.validationStatus})`);
    if (record.description) console.log(`  description: ${record.description}`);
    console.log(`  tags      : ${record.tags.length > 0 ? record.tags.join(', ') : '-'}`);
    console.log(
      `  validation: ${record.validation.errorCount} error(s), ${record.validation.warningCount} warning(s), steps=${record.validation.stepCount}, worst-case ${record.validation.worstCaseDurationMs}ms`,
    );
    console.log(
      `  requires  : designatedTest=${record.requires.designatedTest ?? '-'} preset=${record.requires.preset ?? '-'} minNodes=${record.requires.minNodes ?? '-'}`,
    );
    for (const step of record.steps) {
      const node = (step.operation.config as { node?: unknown }).node ?? '-';
      console.log(
        `  #${step.order} ${step.id.padEnd(12)} ${step.operation.type.padEnd(8)} node=${String(node).padEnd(12)} delayBefore=${step.delayBeforeMs}ms delayAfter=${step.delayAfterMs}ms timeout=${step.timeoutMs}ms`,
      );
    }
  }

  function printValidationIssues(result: ScenarioValidationResult): void {
    for (const issue of result.issues) {
      console.log(
        `  [${issue.severity}] ${issue.path || '(scenario)'}: ${issue.message}` +
          (issue.remediation ? ` — ${issue.remediation}` : ''),
      );
    }
  }

  scenarioCmd
    .command('list')
    .description('List saved scenarios')
    .option('--tag <tag>', 'filter by tag')
    .option('-q, --query <text>', 'filter by name/description text')
    .option('--status <valid|warning>', 'filter by validation status')
    .option('--limit <n>', 'page size (1-200)', '50')
    .option('--offset <n>', 'page offset', '0')
    .action(
      async (cmdOpts: {
        tag?: string;
        query?: string;
        status?: string;
        limit: string;
        offset: string;
      }) => {
        await run(async (engine, opts) => {
          if (cmdOpts.status !== undefined && cmdOpts.status !== 'valid' && cmdOpts.status !== 'warning') {
            throw new KaizenError(
              'INVALID_INPUT',
              `--status must be "valid" or "warning", got "${cmdOpts.status}"`,
            );
          }
          const filter: ScenarioListFilter = {
            limit: parseStrictInt(cmdOpts.limit, '--limit', { min: 1, max: 200 }),
            offset: parseStrictInt(cmdOpts.offset, '--offset', { min: 0 }),
            ...(cmdOpts.tag !== undefined ? { tag: cmdOpts.tag } : {}),
            ...(cmdOpts.query !== undefined ? { q: cmdOpts.query } : {}),
            ...(cmdOpts.status !== undefined ? { status: cmdOpts.status } : {}),
          };
          const page: ScenarioPage = engine.scenarios.list(filter);
          if (opts.json) {
            printJson({ ok: true, ...page });
            return;
          }
          if (page.scenarios.length === 0) {
            console.log('No scenarios match.');
          } else {
            for (const s of page.scenarios) {
              console.log(
                `${s.id}  ${s.name.padEnd(28)} ${s.validationStatus.padEnd(8)} steps=${s.steps.length}${s.tags.length > 0 ? ` tags=${s.tags.join(',')}` : ''}`,
              );
            }
            console.log(`(${page.total} total${page.total > page.scenarios.length ? `, showing ${page.scenarios.length} offset ${page.offset}` : ''})`);
          }
          for (const m of page.malformed) {
            console.log(`warning: unreadable scenario row ${m.id} [${m.code}]: ${m.message}`);
          }
        });
      },
    );

  scenarioCmd
    .command('get <id>')
    .description('Inspect one saved scenario (validation summary + ordered steps)')
    .action(async (id: string) => {
      await run(async (engine, opts) => {
        const record = engine.scenarios.get(id); // throws SCENARIO_NOT_FOUND
        if (opts.json) {
          printJson({ ok: true, scenario: record });
          return;
        }
        printScenarioDetail(record);
      });
    });

  scenarioCmd
    .command('create <file>')
    .description('Create (and store) a scenario from a JSON file — validation rules apply; never executes it')
    .action(async (file: string) => {
      await run(async (engine, opts) => {
        const record = engine.scenarios.create(readScenarioFile(file), 'cli');
        if (opts.json) {
          printJson({ ok: true, scenario: record });
          return;
        }
        console.log(`Created scenario "${record.name}" (${record.id}) — ${record.validationStatus}`);
        console.log(
          `  steps=${record.validation.stepCount} worst-case ${record.validation.worstCaseDurationMs}ms warnings=${record.validation.warningCount}`,
        );
        if (record.validation.warningCount > 0) printValidationIssues(record.validation);
      });
    });

  scenarioCmd
    .command('validate <file>')
    .description('Validate a scenario file WITHOUT saving or executing anything')
    .action(async (file: string) => {
      await run(async (engine, opts) => {
        const result = engine.scenarios.validate(readScenarioFile(file));
        // Validation outcome, not an operation failure: exit 1 only signals
        // "invalid" for scripting; the result itself is always reported.
        if (opts.json) {
          printJson({ ok: result.valid, result });
        } else if (result.valid) {
          console.log(
            `VALID — steps=${result.stepCount}, worst-case ${result.worstCaseDurationMs}ms, warnings=${result.warningCount}`,
          );
          if (result.warningCount > 0) printValidationIssues(result);
        } else {
          console.log(
            `INVALID — ${result.errorCount} error(s), ${result.warningCount} warning(s)`,
          );
          printValidationIssues(result);
        }
        if (!result.valid) process.exitCode = 1;
      });
    });

  scenarioCmd
    .command('operations')
    .description('Describe the safe operation registry (types, support status, config fields)')
    .action(async () => {
      await run(async (engine, opts) => {
        const operations: SerializedOperationDefinition[] = engine.scenarios.describeOperations();
        if (opts.json) {
          printJson({ ok: true, operations });
          return;
        }
        for (const op of operations) {
          console.log(
            `${op.type.padEnd(12)} ${op.status.padEnd(9)} ${op.kind.padEnd(9)} ${op.displayName} — config: ${op.configFields.join(', ')}`,
          );
          if (op.statusReason) console.log(`    reason : ${op.statusReason}`);
          if (op.statusUnblock) console.log(`    unblock: ${op.statusUnblock}`);
        }
      });
    });

  // ---------------------------------------------------------------------------
  // run (execution + history — the SAME engine path the API uses, DEC-021)

  const runCmd = program
    .command('run')
    .description(
      'Scenario execution runs: execute/replay go through the engine gates; runs are persisted before any side effect',
    );

  function parseStrictInt(raw: string, label: string, bounds: { min: number; max?: number }): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < bounds.min || (bounds.max !== undefined && n > bounds.max)) {
      throw new KaizenError(
        'INVALID_INPUT',
        `${label} must be an integer in ${bounds.min}..${bounds.max ?? 'no upper bound'}, got "${raw}"`,
      );
    }
    return n;
  }

  function requireRunState(value: string): ScenarioRunState {
    if (!(SCENARIO_RUN_STATES as readonly string[]).includes(value)) {
      throw new KaizenError(
        'INVALID_INPUT',
        `Unknown run state "${value}" — valid states: ${SCENARIO_RUN_STATES.join(', ')}`,
      );
    }
    return value as ScenarioRunState;
  }

  function printRunSummaryLine(r: ScenarioRunSummary): void {
    console.log(
      `${r.id}  ${r.state.padEnd(23)} ${r.scenarioName.padEnd(22)} network=${r.networkName.padEnd(14)} steps=${r.completedSteps}/${r.stepCount}` +
        `${r.replayOfRunId ? ` replay-of=${r.replayOfRunId}` : ''}${r.error ? ` error=[${r.error.code}]` : ''}`,
    );
  }

  function printRunDetail(runRecord: ScenarioRunRecord): void {
    console.log(`Run ${runRecord.id} — ${runRecord.state}`);
    console.log(`  scenario : ${runRecord.scenarioName} (${runRecord.scenarioId})`);
    console.log(`  network  : ${runRecord.networkName} (${runRecord.networkId})`);
    console.log(
      `  requested: ${runRecord.requestedBy}   created ${runRecord.createdAt}${runRecord.finishedAt ? `   finished ${runRecord.finishedAt}` : ''}`,
    );
    if (runRecord.error) {
      console.log(`  error    : [${runRecord.error.code}] ${runRecord.error.message}`);
    }
    for (const warning of runRecord.warnings) console.log(`  warning  : ${warning}`);
    if (runRecord.cancellation) {
      console.log(
        `  cancelled: requested by ${runRecord.cancellation.requestedBy} at ${runRecord.cancellation.requestedAt}`,
      );
    }
    for (const step of runRecord.steps) {
      console.log(
        `  #${step.order} ${step.stepId.padEnd(12)} ${step.operationType.padEnd(8)} node=${(step.nodeName ?? step.nodeLabel ?? '-').padEnd(12)} → ${step.state}${step.faultId ? ` fault=${step.faultId}` : ''}${step.outcome ? ` outcome=${step.outcome}` : ''}`,
      );
    }
    const note = scenarioRunReplayNote(runRecord);
    console.log(
      `  replay-of: ${runRecord.replayOfRunId ?? '— (original execution)'}`,
    );
    if (note) console.log(`  replay note: ${note}`);
  }

  /**
   * Gate refusals persist a rejected run BEFORE throwing (T-3.4). Surface
   * that run's id honestly (human hint + JSON field) instead of only the
   * error string — attributed by a created-at ≥ attempt-time guard, never
   * guessed.
   */
  function surfaceRejectedRun(
    engine: KaizenEngine,
    opts: GlobalOpts,
    e: unknown,
    attemptedAt: string,
  ): void {
    const err = toErrorJson(e);
    let rejectedRunId: string | undefined;
    let newest = '';
    for (const r of engine.scenarioRuns.list({ state: 'rejected', limit: 20 }).runs) {
      if (r.createdAt >= attemptedAt && r.createdAt >= newest) {
        newest = r.createdAt;
        rejectedRunId = r.id;
      }
    }
    if (opts.json) {
      printJson({
        ok: false,
        error: err,
        ...(rejectedRunId !== undefined ? { rejectedRunId } : {}),
      });
    } else {
      console.error(`ERROR [${err.code}] ${err.message}`);
      if (rejectedRunId !== undefined) {
        console.error(
          `note: a rejected run was persisted (${rejectedRunId}) — inspect: kaizen run get ${rejectedRunId}`,
        );
      }
    }
    process.exitCode = 1;
  }

  /** Await a terminal state; a wait timeout is reported honestly, never as success. */
  async function waitForRun(
    engine: KaizenEngine,
    accepted: ScenarioRunRecord,
    timeoutMs: number,
  ): Promise<ScenarioRunRecord> {
    try {
      return await engine.scenarioRuns.wait(accepted.id, timeoutMs);
    } catch (e) {
      if (isKaizenError(e) && e.code === 'OPERATION_TIMEOUT') {
        const current = engine.scenarioRuns.get(accepted.id);
        throw new KaizenError(
          'OPERATION_TIMEOUT',
          `run ${accepted.id} did not reach a terminal state within ${timeoutMs}ms (current state: ${current.state}); the run keeps executing — inspect with: kaizen run get ${accepted.id}`,
          { runId: accepted.id, state: current.state, ms: timeoutMs },
        );
      }
      throw e;
    }
  }

  function reportRunOutcome(opts: GlobalOpts, runRecord: ScenarioRunRecord): void {
    const ok = SUCCESS_RUN_STATES.has(runRecord.state);
    if (opts.json) {
      printJson({ ok, run: runRecord, replayNote: scenarioRunReplayNote(runRecord) });
    } else {
      printRunDetail(runRecord);
    }
    if (!ok) process.exitCode = 1;
  }

  runCmd
    .command('execute <scenarioId>')
    .description(
      'Execute a saved scenario against an EXPLICITLY selected eligible test network (engine gates apply; a refusal persists a rejected run)',
    )
    .requiredOption(
      '-n, --network <idOrName>',
      'target network id or name — explicit selection is required, never inferred',
    )
    .option('--timeout <ms>', 'bounded wait for a terminal run state', '300000')
    .action(async (scenarioId: string, cmdOpts: { network: string; timeout: string }) => {
      await run(async (engine, opts) => {
        const timeoutMs = parseStrictInt(cmdOpts.timeout, '--timeout', { min: 1, max: 3_600_000 });
        const attemptedAt = new Date().toISOString();
        let accepted: ScenarioRunRecord;
        try {
          accepted = engine.scenarioRuns.execute({
            scenarioId,
            networkIdOrName: cmdOpts.network,
            mode: 'execute',
            requestedBy: 'cli',
          });
        } catch (e) {
          surfaceRejectedRun(engine, opts, e, attemptedAt);
          return;
        }
        const finished = await waitForRun(engine, accepted, timeoutMs);
        reportRunOutcome(opts, finished);
      });
    });

  runCmd
    .command('replay <runId>')
    .description(
      "Replay a finished run's recorded actions as a NEW run against an EXPLICITLY selected network (provenance is not authorization; identical outcomes are NOT guaranteed)",
    )
    .requiredOption(
      '-n, --network <idOrName>',
      'target network id or name — re-confirmed explicitly; never inherited from the source run',
    )
    .option('--timeout <ms>', 'bounded wait for a terminal run state', '300000')
    .action(async (runId: string, cmdOpts: { network: string; timeout: string }) => {
      await run(async (engine, opts) => {
        const timeoutMs = parseStrictInt(cmdOpts.timeout, '--timeout', { min: 1, max: 3_600_000 });
        const attemptedAt = new Date().toISOString();
        let accepted: ScenarioRunRecord;
        try {
          accepted = engine.scenarioRuns.replay({
            runId,
            networkIdOrName: cmdOpts.network,
            mode: 'execute',
            requestedBy: 'cli',
          });
        } catch (e) {
          surfaceRejectedRun(engine, opts, e, attemptedAt);
          return;
        }
        const finished = await waitForRun(engine, accepted, timeoutMs);
        reportRunOutcome(opts, finished);
      });
    });

  runCmd
    .command('list')
    .description('List scenario runs — every state, including failed and rejected')
    .option('--scenario <id>', 'filter by scenario id')
    .option('--network <id>', 'filter by network id')
    .option('--state <state>', `filter by run state (${SCENARIO_RUN_STATES.join(' | ')})`)
    .option('--replay-of <runId>', 'only runs replayed FROM this source run (provenance)')
    .option('--limit <n>', 'page size (1-200)', '50')
    .option('--offset <n>', 'page offset', '0')
    .action(
      async (cmdOpts: {
        scenario?: string;
        network?: string;
        state?: string;
        replayOf?: string;
        limit: string;
        offset: string;
      }) => {
        await run(async (engine, opts) => {
          const filter: ScenarioRunListFilter = {
            limit: parseStrictInt(cmdOpts.limit, '--limit', { min: 1, max: 200 }),
            offset: parseStrictInt(cmdOpts.offset, '--offset', { min: 0 }),
            ...(cmdOpts.scenario !== undefined ? { scenarioId: cmdOpts.scenario } : {}),
            ...(cmdOpts.network !== undefined ? { networkId: cmdOpts.network } : {}),
            ...(cmdOpts.state !== undefined ? { state: requireRunState(cmdOpts.state) } : {}),
            ...(cmdOpts.replayOf !== undefined ? { replayOf: cmdOpts.replayOf } : {}),
          };
          const page: ScenarioRunPage = engine.scenarioRuns.list(filter);
          if (opts.json) {
            printJson({ ok: true, ...page });
            return;
          }
          if (page.runs.length === 0) {
            console.log('No runs match.');
          } else {
            for (const r of page.runs) printRunSummaryLine(r);
            console.log(
              `(${page.total} total${page.total > page.runs.length ? `, showing ${page.runs.length} offset ${page.offset}` : ''})`,
            );
          }
          for (const m of page.malformed) {
            console.log(`warning: unreadable run row ${m.id}: ${m.message}`);
          }
        });
      },
    );

  runCmd
    .command('get <runId>')
    .description(
      'Inspect one run: steps + evidence, failure details, cancellation, and replay provenance (replayOfRunId + honesty note + replays of this run)',
    )
    .action(async (runId: string) => {
      await run(async (engine, opts) => {
        const runRecord = engine.scenarioRuns.get(runId); // throws SCENARIO_RUN_NOT_FOUND
        const replayNote = scenarioRunReplayNote(runRecord);
        const replays = engine.scenarioRuns.list({ replayOf: runRecord.id, limit: 50 }).runs;
        if (opts.json) {
          printJson({ ok: true, run: runRecord, replayNote, replays });
          return;
        }
        printRunDetail(runRecord);
        if (replays.length > 0) {
          console.log('  replays of this run:');
          for (const r of replays) printRunSummaryLine(r);
        }
      });
    });

  runCmd
    .command('cancel <runId>')
    .description(
      'Request cancellation of a run — works cross-process (the durable request is honored by the executing process; interrupts in-flight faults via the injector and waits, bounded, for the terminal state)',
    )
    .option(
      '--timeout <ms>',
      'bounded wait for the cancellation to take effect (durable request observed by the executing process)',
      '60000',
    )
    .action(async (runId: string, cmdOpts: { timeout: string }) => {
      await run(async (engine, opts) => {
        const timeoutMs = parseStrictInt(cmdOpts.timeout, '--timeout', { min: 1, max: 3_600_000 });
        const requested = await engine.scenarioRuns.cancel(runId, 'cli');
        // The request may be durable (run executing in ANOTHER process): poll,
        // bounded, until the run reaches a terminal state. Honesty rule: a
        // request nobody observed is reported as a timeout, never as success.
        let final = requested;
        const deadline = Date.now() + timeoutMs;
        while (!isTerminalScenarioRunState(final.state) && Date.now() < deadline) {
          await sleep(500);
          final = engine.scenarioRuns.get(runId);
        }
        if (!isTerminalScenarioRunState(final.state)) {
          throw new KaizenError(
            'OPERATION_TIMEOUT',
            `cancellation of run ${runId} was recorded but the run did not stop within ${timeoutMs}ms (current state: ${final.state}); no process executing it observed the request — it may be orphaned by a crashed process and is terminalized by startup reconciliation. Inspect: kaizen run get ${runId}`,
            { runId, state: final.state, ms: timeoutMs },
          );
        }
        // Exit contract: clean outcomes only. 'cancelled' (the request took
        // effect) and completed* (finished before the request landed) are
        // success; failed/cleanup-failed are not.
        const ok = final.state === 'cancelled' || SUCCESS_RUN_STATES.has(final.state);
        if (opts.json) {
          printJson({ ok, run: final, replayNote: scenarioRunReplayNote(final) });
        } else {
          printRunDetail(final);
        }
        if (!ok) process.exitCode = 1;
      });
    });

  // ---------------------------------------------------------------------------
  // Portaldot V3 testnet (T-8.1 probe surface + T-8.2 anchoring)

  const v3Cmd = program
    .command('v3')
    .description('Portaldot V3 TEST network: connectivity probe and on-chain run anchoring');

  function formatTokens(planck: string | null, decimals: number | null, symbol: string | null): string {
    if (planck === null || decimals === null) return 'unknown';
    const v = BigInt(planck);
    const base = 10n ** BigInt(decimals);
    const whole = v / base;
    const frac = (v % base).toString().padStart(decimals, '0').slice(0, 4);
    return `${whole}.${frac} ${symbol ?? ''}`.trim();
  }

  function printAnchorLine(a: V3AnchorRecord): void {
    console.log(
      `  ${a.id}  run=${a.runId}  ${a.method.padEnd(8)} ${a.status.padEnd(9)} block=${a.blockNumber ?? '-'}  tx=${a.txHash ?? '-'}${a.contractAddress ? `  contract=${a.contractAddress}` : ''}`,
    );
  }

  function printAnchorDetail(a: V3AnchorRecord, template: string): void {
    console.log(`anchor ${a.id} — ${a.status.toUpperCase()} via ${a.method}`);
    console.log(`  run       : ${a.runId}`);
    console.log(`  run hash  : ${a.runHash}`);
    console.log(`  payload   : ${a.payload}`);
    console.log(`  chain     : ${a.chainName ?? '-'} (${a.genesisHash ?? '-'})`);
    if (a.contractAddress) console.log(`  contract  : ${a.contractAddress}`);
    console.log(`  signer    : ${a.signerAddress}`);
    console.log(`  tx hash   : ${a.txHash ?? '-'}`);
    console.log(`  block     : ${a.blockNumber ?? '-'} ${a.blockHash ?? ''}`);
    if (a.blockHash) console.log(`  explorer  : ${template.replace('{block}', a.blockHash)}`);
    if (a.error) console.log(`  error     : ${a.error}`);
  }

  function printProbe(report: V3ConnectivityReport): void {
    console.log(`V3 connectivity — ${report.healthy ? 'HEALTHY' : 'DEGRADED'} (${report.at})`);
    for (const r of [report.substrate, report.evm, report.explorer]) {
      console.log(`  ${r.role.padEnd(13)} ${r.status.padEnd(18)} ${r.endpoint}  ${r.latencyMs}ms  ${r.detail}`);
    }
  }

  v3Cmd
    .command('probe')
    .description('Read-only probe of the configured V3 endpoints (Substrate WS, EVM JSON-RPC, explorer)')
    .action(async () => {
      await run(async (_engine, opts) => {
        const report = await probeV3Connectivity();
        if (opts.json) printJson({ ok: report.healthy, report });
        else printProbe(report);
        if (!report.healthy) process.exitCode = 1;
      });
    });

  v3Cmd
    .command('status')
    .description('Signer (public address + balance), registry in effect, and chain identity — never prints secrets')
    .action(async () => {
      await run(async (engine, opts) => {
        const status = await engine.v3Anchors.status();
        if (opts.json) {
          printJson({ ok: status.error === null, status });
        } else {
          console.log(`V3 anchoring status (${status.at})`);
          console.log(`  chain     : ${status.chainName ?? 'unreachable'} ${status.genesisHash ?? ''}`);
          console.log(
            `  signer    : ${status.signer.configured ? (status.signer.address ?? 'invalid') : 'not configured (export KAIZEN_V3_SIGNER_SURI)'}`,
          );
          if (status.signer.evmAddress) console.log(`  evm addr  : ${status.signer.evmAddress}`);
          console.log(
            `  balance   : ${formatTokens(status.signer.freeBalance, status.signer.tokenDecimals, status.signer.tokenSymbol)}`,
          );
          console.log(`  registry  : ${status.registryAddress ?? 'none'}${status.registrySource ? ` (${status.registrySource})` : ''}`);
          if (status.error) console.log(`  error     : ${status.error}`);
        }
        if (status.error) process.exitCode = 1;
      });
    });

  v3Cmd
    .command('deploy-registry')
    .description('Deploy the KaizenRunRegistry contract to the V3 TEST network (spends tPOT from KAIZEN_V3_SIGNER_SURI)')
    .action(async () => {
      await run(async (engine, opts) => {
        const contract = await engine.v3Anchors.deployRegistry();
        if (opts.json) {
          printJson({ ok: true, contract });
          return;
        }
        console.log(`KaizenRunRegistry deployed at ${contract.address}`);
        console.log(`  tx hash : ${contract.txHash}`);
        console.log(`  block   : ${contract.blockNumber} ${contract.blockHash}`);
        console.log(`  chain   : ${contract.chainName}`);
      });
    });

  // Proof-of-Resilience on V3 (T-9.8): KaizenResilienceRegistry deploy /
  // record / read. Writes spend tPOT from KAIZEN_V3_SIGNER_SURI; with
  // --journal, a JSON line is appended BEFORE signing (persist-first, DEC-026)
  // and again with the chain's answer.

  const registryClient = (): ResilienceRegistryService =>
    deps.resilienceRegistryFactory ? deps.resilienceRegistryFactory() : new ResilienceRegistryService();

  function journalTo(file: string | undefined): ((e: ResilienceChainJournalEntry) => void) | undefined {
    if (file === undefined) return undefined;
    const target = path.resolve(file);
    return (e) => fs.appendFileSync(target, `${JSON.stringify(e)}\n`);
  }

  async function runChain(fn: (opts: GlobalOpts) => Promise<void>): Promise<void> {
    const opts = getOpts();
    try {
      await fn(opts);
    } catch (e) {
      const err = toErrorJson(e);
      if (opts.json) printJson({ ok: false, error: err });
      else console.error(`ERROR [${err.code}] ${err.message}`);
      process.exitCode = 1;
    }
  }

  v3Cmd
    .command('deploy-resilience-registry')
    .description('Deploy KaizenResilienceRegistry to the V3 TEST network (spends tPOT from KAIZEN_V3_SIGNER_SURI)')
    .option('--journal <file>', 'append persist-first JSON lines (before signing, then the result)')
    .action(async (cmdOpts: { journal?: string }) => {
      await runChain(async (opts) => {
        const d = await registryClient().deploy({ journal: journalTo(cmdOpts.journal) });
        if (opts.json) {
          printJson({ ok: true, deployment: d });
          return;
        }
        console.log(`KaizenResilienceRegistry deployed at ${d.address}`);
        console.log(`  tx hash : ${d.txHash}`);
        console.log(`  block   : ${d.blockNumber} ${d.blockHash}${d.finalized ? ' (finalized)' : ''}`);
        console.log(`  spent   : ${formatTokens(d.spent, d.tokenDecimals, d.tokenSymbol)}`);
        console.log(`  balance : ${formatTokens(d.balanceAfter, d.tokenDecimals, d.tokenSymbol)}`);
      });
    });

  v3Cmd
    .command('anchor-certificate <certificateFile>')
    .description('Record a signed resilience certificate + its v1 score in KaizenResilienceRegistry (spends tPOT)')
    .requiredOption('--score <n>', 'v1 resilience score 0-100 to store with the certificate (docs/RESILIENCE_SCORE.md)')
    .option('--registry <address>', 'registry H160 (default: $KAIZEN_V3_RESILIENCE_REGISTRY_ADDRESS)')
    .option('--journal <file>', 'append persist-first JSON lines (before signing, then the result)')
    .action(async (certificateFile: string, cmdOpts: { score: string; registry?: string; journal?: string }) => {
      await runChain(async (opts) => {
        const score = Number(cmdOpts.score);
        if (!Number.isInteger(score) || score < 0 || score > 100) {
          throw new KaizenError('INVALID_INPUT', '--score must be an integer 0..100');
        }
        let cert: ResilienceCertificate;
        try {
          cert = JSON.parse(fs.readFileSync(path.resolve(certificateFile), 'utf8')) as ResilienceCertificate;
        } catch {
          throw new KaizenError('INVALID_INPUT', `cannot read certificate JSON from ${certificateFile}`);
        }
        const a = await registryClient().anchor(cert, score, {
          ...(cmdOpts.registry !== undefined ? { registry: cmdOpts.registry } : {}),
          journal: journalTo(cmdOpts.journal),
        });
        if (opts.json) {
          printJson({ ok: true, anchor: a });
          return;
        }
        console.log(`certificate ${a.fingerprint} recorded in ${a.contract}`);
        console.log(`  validator : ${a.validatorId} (key ${a.validatorKey})  score=${a.score}  flags=${a.evidenceFlags}`);
        console.log(`  tx hash   : ${a.txHash}`);
        console.log(`  block     : ${a.blockNumber} ${a.blockHash}${a.finalized ? ' (finalized)' : ''}`);
        console.log(`  spent     : ${formatTokens(a.spent, a.tokenDecimals, a.tokenSymbol)}`);
      });
    });

  v3Cmd
    .command('resilience-score <validator>')
    .description('Read a validator\'s on-chain resilience score from KaizenResilienceRegistry (free dry-run read)')
    .option('--registry <address>', 'registry H160 (default: $KAIZEN_V3_RESILIENCE_REGISTRY_ADDRESS)')
    .option('--fingerprint <hex>', 'also check recorded(fingerprint)')
    .action(async (validator: string, cmdOpts: { registry?: string; fingerprint?: string }) => {
      await runChain(async (opts) => {
        const r = await registryClient().read(validator, {
          ...(cmdOpts.registry !== undefined ? { registry: cmdOpts.registry } : {}),
          ...(cmdOpts.fingerprint !== undefined ? { fingerprint: cmdOpts.fingerprint } : {}),
        });
        if (opts.json) {
          printJson({ ok: true, read: r });
          return;
        }
        console.log(`${r.validatorId} on ${r.contract} (best block ${r.bestNumber})`);
        console.log(`  score       : ${r.score.score}/100  certificates=${r.score.count}  block=${r.score.block}`);
        if (r.cert) console.log(`  certOf      : score=${r.cert.score} block=${r.cert.block}`);
        if (r.recorded !== null) console.log(`  recorded    : ${r.recorded}`);
      });
    });

  v3Cmd
    .command('import-deployment <blockHash> <txHash>')
    .description('Record an existing KaizenRunRegistry deployment from chain evidence (read-only; verifies revive.Instantiated)')
    .action(async (blockHash: string, txHash: string) => {
      await run(async (engine, opts) => {
        const contract = await engine.v3Anchors.importDeployment(blockHash, txHash);
        if (opts.json) printJson({ ok: true, contract });
        else console.log(`registry ${contract.address} recorded (block ${contract.blockNumber}, tx ${contract.txHash})`);
      });
    });

  v3Cmd
    .command('hash <runId>')
    .description('Compute the deterministic run hash offline (what `anchor` would write)')
    .action(async (runId: string) => {
      await run(async (engine, opts) => {
        const h = engine.v3Anchors.hashRun(runId);
        if (opts.json) printJson({ ok: true, ...h });
        else console.log(`${h.runHash}  run=${h.runId} state=${h.state}${h.anchorable ? '' : ' (not anchorable)'}`);
      });
    });

  v3Cmd
    .command('anchor <runId>')
    .description(
      "Anchor a finished run's hash on the V3 TEST network (default: KaizenRunRegistry contract; --method remark for system.remarkWithEvent)",
    )
    .option('--method <method>', 'contract | remark (default: contract when a registry is known)')
    .action(async (runId: string, cmdOpts: { method?: string }) => {
      await run(async (engine, opts) => {
        let method: V3AnchorMethod | undefined;
        if (cmdOpts.method !== undefined) {
          if (cmdOpts.method !== 'contract' && cmdOpts.method !== 'remark') {
            throw new KaizenError('INVALID_INPUT', '--method must be contract or remark');
          }
          method = cmdOpts.method;
        }
        const anchor = await engine.v3Anchors.anchorRun(runId, { requestedBy: 'cli', ...(method ? { method } : {}) });
        const ok = anchor.status === 'in-block' || anchor.status === 'finalized';
        if (opts.json) printJson({ ok, anchor });
        else printAnchorDetail(anchor, engine.v3Anchors.explorerBlockUrlTemplate());
        if (!ok) process.exitCode = 1;
      });
    });

  v3Cmd
    .command('anchors')
    .description('List recorded V3 anchors (every status, including failed attempts)')
    .option('--run <runId>', 'filter by run id')
    .option('--limit <n>', 'max rows (1-500)', '50')
    .action(async (cmdOpts: { run?: string; limit: string }) => {
      await run(async (engine, opts) => {
        const anchors = engine.v3Anchors.list({
          limit: parseStrictInt(cmdOpts.limit, '--limit', { min: 1, max: 500 }),
          ...(cmdOpts.run !== undefined ? { runId: cmdOpts.run } : {}),
        });
        const contracts = engine.v3Anchors.contracts();
        if (opts.json) {
          printJson({ ok: true, anchors, contracts });
          return;
        }
        for (const c of contracts) console.log(`registry ${c.address} (block ${c.blockNumber}, tx ${c.txHash})`);
        if (anchors.length === 0) console.log('No anchors recorded.');
        for (const a of anchors) printAnchorLine(a);
      });
    });

  v3Cmd
    .command('verify <anchorId>')
    .description('Recompute the run hash and re-check the anchor on chain (block hash, registry anchoredAt, eth_getCode / remark text)')
    .action(async (anchorId: string) => {
      await run(async (engine, opts) => {
        const v = await engine.v3Anchors.verify(anchorId);
        if (opts.json) printJson({ ok: v.verdict === 'verified', verification: v });
        else {
          console.log(`anchor ${v.anchorId} — ${v.verdict.toUpperCase()}`);
          console.log(`  recorded hash   : ${v.recordedRunHash}`);
          console.log(`  recomputed hash : ${v.recomputedRunHash ?? 'unavailable'} (${v.hashMatches ? 'match' : 'NO MATCH'})`);
          if (v.blockHashMatches !== null) console.log(`  block hash      : ${v.blockHashMatches ? 'match' : 'NO MATCH'}`);
          if (v.onChainAnchoredAt !== null) console.log(`  registry        : anchoredAt=${v.onChainAnchoredAt}`);
          if (v.contractCodePresent !== null) console.log(`  eth_getCode     : ${v.contractCodePresent ? 'code present' : 'NO CODE'}`);
          for (const n of v.notes) console.log(`  note: ${n}`);
        }
        if (v.verdict !== 'verified') process.exitCode = 1;
      });
    });

  // ---------------------------------------------------------------------------
  // Proof-of-Resilience (T-9.5): certificates + resilience scores

  program
    .command('certify <runId>')
    .description(
      'Sign a chain-bound resilience certificate for a finished run (KAIZEN_RESILIENCE_SIGNER_SURI / _FILE; --dev-key = public //Alice, local test networks only)',
    )
    .option('--dev-key', 'allow the public //Alice DEV key (labelled; integrity only, not identity)')
    .action(async (runId: string, cmdOpts: { devKey?: boolean }) => {
      await run(async (engine, opts) => {
        const cert = await engine.resilience.certifyRun(runId, { allowDevKey: cmdOpts.devKey === true });
        if (opts.json) {
          printJson({ ok: true, certificate: cert });
          return;
        }
        const m = cert.chain.metrics;
        console.log(`certificate ${cert.fingerprint}`);
        console.log(`  run        : ${cert.runId} (run hash ${cert.runHash})`);
        console.log(`  validator  : ${cert.validatorId} on ${cert.networkId}`);
        console.log(`  signer     : ${cert.signature.address}${cert.signature.dev ? '  [DEV KEY — integrity only, not identity]' : ''}`);
        console.log(
          `  recovery   : ${m.recovered ? 'recovered' : 'NOT recovered'}  ttr=${m.timeToRecoverMs ?? '-'}ms  finality gap=${m.finalityGapBlocks ?? '-'}  missed=${m.blocksMissed ?? '-'}`,
        );
        console.log(`  evidence   : ${cert.chain.observations.length} observations, ${cert.chain.gaps.length} gaps`);
      });
    });

  program
    .command('certificates')
    .description('List resilience certificates')
    .option('--validator <id>', 'filter by validator')
    .action(async (cmdOpts: { validator?: string }) => {
      await run(async (engine, opts) => {
        const certs = engine.resilience.listCertificates(
          cmdOpts.validator !== undefined ? { validatorId: cmdOpts.validator } : {},
        );
        if (opts.json) {
          printJson({ ok: true, certificates: certs });
          return;
        }
        if (certs.length === 0) console.log('No certificates.');
        for (const c of certs) {
          console.log(
            `  ${c.fingerprint}  ${c.validatorId.padEnd(12)} run=${c.runId}  ${c.chain.metrics.recovered ? 'recovered' : 'not-recovered'}  ${c.signedAt}${c.signature.dev ? '  [dev key]' : ''}`,
          );
        }
      });
    });

  program
    .command('export-certificate <fingerprint>')
    .description('Write a certificate and its run as one portable bundle that anyone can verify with verify-certificate --bundle')
    .option('--out <file>', 'write the bundle to a file instead of stdout')
    .action(async (fingerprint: string, cmdOpts: { out?: string }) => {
      await run(async (engine, opts) => {
        const bundle = engine.resilience.exportBundle(fingerprint);
        const text = `${JSON.stringify(bundle, null, 2)}\n`;
        if (cmdOpts.out !== undefined) {
          fs.writeFileSync(path.resolve(cmdOpts.out), text);
          if (opts.json) printJson({ ok: true, out: path.resolve(cmdOpts.out), fingerprint });
          else console.log(`wrote bundle for ${fingerprint} to ${path.resolve(cmdOpts.out)}`);
        } else process.stdout.write(text);
      });
    });

  program
    .command('verify-certificate [fingerprint]')
    .description(
      'Recompute the fingerprint, check the sr25519 signature and drill record, and re-fetch the block hashes from the network (offline → unverifiable). With --bundle, verify an exported file instead of the local store',
    )
    .option('--bundle <file>', 'verify an exported certificate bundle (no local state needed)')
    .option('--rpc <url>', 'HTTP RPC endpoint to re-fetch block hashes from (bundle mode; omitted → chain binding unverifiable)')
    .action(async (fingerprint: string | undefined, cmdOpts: { bundle?: string; rpc?: string }) => {
      await run(async (engine, opts) => {
        let label: string;
        let v: CertificateVerification;
        if (cmdOpts.bundle !== undefined) {
          const bundle = parseCertificateBundle(fs.readFileSync(path.resolve(cmdOpts.bundle), 'utf8'));
          label = bundle.certificate.fingerprint;
          v = await verifyCertificateBundle(bundle, cmdOpts.rpc !== undefined ? createHttpChainReader(cmdOpts.rpc) : null);
        } else {
          if (fingerprint === undefined) throw new KaizenError('INVALID_INPUT', 'give a fingerprint, or --bundle <file>');
          label = fingerprint;
          v = await engine.resilience.verify(fingerprint, cmdOpts.rpc !== undefined ? { rpc: cmdOpts.rpc } : {});
        }
        let attestations: KaizenAttestation[] = [];
        if (cmdOpts.bundle !== undefined) {
          attestations = parseCertificateBundle(fs.readFileSync(path.resolve(cmdOpts.bundle), 'utf8')).attestations ?? [];
        } else if (fingerprint !== undefined) {
          attestations = engine.resilience.listAttestations(fingerprint);
        }
        if (opts.json) printJson({ ok: v.status === 'verified', verification: v, attestations });
        else {
          console.log(`certificate ${label} — ${v.status.toUpperCase()}`);
          for (const r of v.reasons) console.log(`  ${r}`);
          if (attestations.length > 0) {
            console.log(`  attestations: ${attestations.length}`);
            for (const a of attestations) console.log(`    ${a.attester.address}  ${a.verdict}  checked ${a.checkedAt}`);
          }
        }
        if (v.status !== 'verified') process.exitCode = 1;
      });
    });

  program
    .command('score [validator]')
    .description('Resilience score (0-100) from certified runs (docs/RESILIENCE_SCORE.md); all validators when omitted. --v2 weights each run by its evidence class')
    .option('--v2', 'score v2: weight runs by evidence class (signed-local 0.7; signed-chain-verified 1 with --verify-chain)')
    .option('--verify-chain', 'with --v2: re-fetch each certificate\'s block hashes from its running network')
    .action(async (validator: string | undefined, cmdOpts: { v2?: boolean; verifyChain?: boolean }) => {
      await run(async (engine, opts) => {
        if (cmdOpts.verifyChain && !cmdOpts.v2) throw new KaizenError('INVALID_INPUT', '--verify-chain needs --v2');
        const ids = validator !== undefined ? [validator] : engine.resilience.listValidators();
        const scores = [];
        for (const id of ids) {
          scores.push(
            cmdOpts.v2
              ? await engine.resilience.scoreV2(id, { verifyChain: cmdOpts.verifyChain === true })
              : await engine.resilience.score(id),
          );
        }
        if (opts.json) {
          printJson({ ok: true, scores });
          return;
        }
        if (scores.length === 0) console.log('No certified validators.');
        for (const s of scores) {
          console.log(
            `${s.validatorId.padEnd(14)} ${String(s.score).padStart(3)}/100  runs=${s.runs} survived=${s.faultsSurvived} quality=${s.quality.toFixed(3)} confidence=${s.confidence.toFixed(3)}${s.excluded.length ? `  excluded=${s.excluded.length} (integrity failed)` : ''}${s.notes.length > 0 ? `  notes=${s.notes.length}` : ''}`,
          );
        }
      });
    });

  program
    .command('attest <fingerprint>')
    .description(
      `Re-verify a stored certificate against the chain and sign the result with an independent attester key (${ATTESTATION_SIGNER_ENV_KEY}). verdict=verified only on a full chain match; otherwise mismatch. Does NOT spend tPOT`,
    )
    .option('--rpc <url>', 'HTTP RPC endpoint to re-fetch block hashes from (omitted: the running network, else unverifiable -> mismatch)')
    .action(async (fingerprint: string, cmdOpts: { rpc?: string }) => {
      await run(async (engine, opts) => {
        const att = await engine.resilience.attest(fingerprint, cmdOpts.rpc !== undefined ? { rpc: cmdOpts.rpc } : {});
        if (opts.json) {
          printJson({ ok: true, attestation: att });
          return;
        }
        console.log(`attestation ${att.certificateFingerprint}`);
        console.log(`  verdict  : ${att.verdict.toUpperCase()}`);
        console.log(`  checkedAt: ${att.checkedAt}`);
        console.log(`  attester : ${att.attester.address}`);
        if (att.verdict !== 'verified') process.exitCode = 1;
      });
    });

  return program;
}
