import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  atomicWriteExactBytes,
} from '../rfc64-persistence-lifecycle/evidence.ts';
import {
  createRfc64SemanticSnapshot,
  type Rfc64KnowledgeAssetObservation,
} from '../_bootstrap/rfc64-evidence.ts';
import {
  canonicalJson,
  createSelectiveCoverageCorpus,
  type GraphSnapshotExpectationV1,
  type SelectiveCoverageGraphV1,
} from './manifest.ts';
import {
  TESTNET_OPERATOR_CONFIG_SCHEMA,
  requireJson,
  type TestnetOperatorAssetV1,
  type TestnetOperatorGraphV1,
  type TestnetOperatorRoleV1,
} from './testnet-operator-common.ts';

const apiUrl = requiredEnvironment('DKG_RFC64_M1_PREPUBLISHER_API');
const corpusPath = resolve(requiredEnvironment('DKG_RFC64_M1_CORPUS_FILE'));
const configPath = resolve(requiredEnvironment('DKG_RFC64_M1_OPERATOR_CONFIG'));
const rolesPath = resolve(requiredEnvironment('DKG_RFC64_M1_OPERATOR_ROLES_FILE'));
const runId = (process.env['DKG_RFC64_M1_RUN_ID'] ?? Date.now().toString(36))
  .toLowerCase().replace(/[^a-z0-9-]/gu, '-').slice(0, 24);
if (!runId) throw new Error('DKG_RFC64_M1_RUN_ID normalized to an empty value');

const publisher: TestnetOperatorRoleV1 = {
  transport: 'local',
  apiUrl,
  repoRoot: process.cwd(),
  dataDir: '.',
  command: ['unused'],
  environment: {},
};
const roleConfig = JSON.parse(await readFile(rolesPath, 'utf8')) as Record<string, unknown>;
const identity = await requireJson(publisher, '/api/agent/identity');
const agentAddress = requiredText(identity['agentAddress'], 'publisher agent address');
const status = await requireJson(publisher, '/api/status');
const networkId = requiredText(status['networkId'], 'publisher network ID');

const policyCells = [
  { suffix: 'public-open-ondemand', accessPolicy: 0 as const, publishPolicy: 1 as const, edgePolicy: 'on-demand' as const },
  { suffix: 'public-curated-always', accessPolicy: 0 as const, publishPolicy: 0 as const, edgePolicy: 'always-on' as const },
  { suffix: 'public-open-unselected', accessPolicy: 0 as const, publishPolicy: 1 as const, edgePolicy: 'unselected' as const },
  { suffix: 'private-open-unselected', accessPolicy: 1 as const, publishPolicy: 1 as const, edgePolicy: 'unselected' as const },
  { suffix: 'private-curated-unselected', accessPolicy: 1 as const, publishPolicy: 0 as const, edgePolicy: 'unselected' as const },
];

const operatorGraphs: TestnetOperatorGraphV1[] = [];
const corpusGraphs: SelectiveCoverageGraphV1[] = [];
for (const [graphIndex, policy] of policyCells.entries()) {
  const contextGraphId = `m1-${runId}-${graphIndex + 1}`;
  const create = await requireJson(publisher, '/api/context-graph/create', {
    method: 'POST',
    body: JSON.stringify({
      id: contextGraphId,
      name: `RFC64 M1 ${runId} ${policy.suffix}`,
      accessPolicy: policy.accessPolicy,
      publishPolicy: policy.publishPolicy,
      allowedAgents: [agentAddress],
      register: true,
    }),
  });
  if (create['registered'] !== true || create['onChainId'] === undefined) {
    throw new Error(`context graph ${contextGraphId} did not register: ${JSON.stringify(create)}`);
  }

  const assets: TestnetOperatorAssetV1[] = [];
  const semantic: Rfc64KnowledgeAssetObservation[] = [];
  let selectedSnapshot: GraphSnapshotExpectationV1 | undefined;
  for (const wave of ['selected', 'final'] as const) {
    const name = `${wave}-${graphIndex + 1}`;
    const subject = `urn:dkg:rfc64:m1:${runId}:g${graphIndex + 1}:${wave}`;
    const lines = Array.from({ length: 24 }, (_, tripleIndex) => {
      const predicate = `urn:dkg:rfc64:m1:predicate:${tripleIndex.toString().padStart(2, '0')}`;
      const object = JSON.stringify(`${runId}|g${graphIndex + 1}|${wave}|${tripleIndex}`);
      return `<${subject}> <${predicate}> ${object} .`;
    });
    const quads = lines.map((line) => {
      const match = /^<([^>]+)> <([^>]+)> (.+) \.$/u.exec(line);
      if (!match) throw new Error('generated M1 N-Quad is malformed');
      return { subject: match[1], predicate: match[2], object: match[3] };
    });
    await requireJson(publisher, '/api/knowledge-assets', {
      method: 'POST',
      body: JSON.stringify({ contextGraphId, name, quads, finalize: true }),
    }, [201]);
    const descriptor = await requireJson(
      publisher,
      `/api/knowledge-assets/${encodeURIComponent(name)}?contextGraphId=${encodeURIComponent(contextGraphId)}`,
    );
    const ual = requiredText(descriptor['reservedUal'], `${contextGraphId}/${name} reserved UAL`);
    assets.push({ name, subject, ual, wave });
    semantic.push({ ual, semanticNQuads: lines });
    const snapshot = await createRfc64SemanticSnapshot(semantic);
    const expectation = {
      vm: {
        headDigest: snapshot.ualsSha256,
        inventoryDigest: snapshot.semanticNQuadsSha256,
        assetCount: snapshot.kaCount,
        dataTripleCount: snapshot.quadCount,
      },
      swm: {
        headDigest: snapshot.ualsSha256,
        inventoryDigest: snapshot.semanticNQuadsSha256,
        assetCount: snapshot.kaCount,
        dataTripleCount: snapshot.quadCount,
      },
    } satisfies GraphSnapshotExpectationV1;
    if (wave === 'selected') selectedSnapshot = expectation;
    else {
      if (!selectedSnapshot) throw new Error('selected snapshot was not constructed');
      corpusGraphs.push({
        contextGraphId,
        accessPolicy: policy.accessPolicy,
        publishPolicy: policy.publishPolicy,
        edgePolicy: policy.edgePolicy,
        selectedSnapshot,
        finalSnapshot: expectation,
      });
    }
  }
  operatorGraphs.push({
    contextGraphId,
    accessPolicy: policy.accessPolicy,
    publishPolicy: policy.publishPolicy,
    edgePolicy: policy.edgePolicy,
    assets,
  });
}

const corpus = createSelectiveCoverageCorpus({
  networkId,
  coreAutomaticBatchSize: 3,
  coreCoverageRoundLimit: 2,
  graphs: corpusGraphs,
});
const operatorConfig = {
  schema: TESTNET_OPERATOR_CONFIG_SCHEMA,
  roles: roleConfig,
  graphs: operatorGraphs,
  pollIntervalMs: 2_000,
  operationTimeoutMs: 20 * 60_000,
};
writeJson(corpusPath, corpus);
writeJson(configPath, operatorConfig);
process.stdout.write(
  `[rfc64-m1] prepared ${operatorGraphs.length} registered CGs and 10 sealed KAs; `
    + `corpus=${corpusPath} operatorConfig=${configPath}\n`,
);

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteExactBytes(path, Buffer.from(`${canonicalJson(value)}\n`, 'utf8'));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is missing`);
  return value;
}
