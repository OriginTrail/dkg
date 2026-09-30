/**
 * SWM public-quads digest across host locales, on a real devnet.
 *
 * The digest of a Shared-Working-Memory snapshot names its file on disk and is
 * recomputed by every node that syncs it. It used to depend on the host
 * collation (`LANG` / `LC_ALL`), so nodes with different locales computed
 * different digests for byte-identical quads and rejected each other's
 * snapshots as "corrupt". This suite runs real nodes with different host
 * locales and proves, through the daemon HTTP API, the node logs and the
 * snapshot files on disk, that:
 *
 *   PHASE A - today's default (no gate). Only node 5 is a da-DK host; the four
 *     cores are en-US and node 1 (en-US) originates a share, recording and
 *     naming its snapshot by the en-US digest. A da-DK edge that joins AFTER the
 *     write catches the graph up through sync, which verifies that advertised
 *     digest against the bytes: it sees all the Shared Working Memory and logs
 *     no digest validation failure (before this change it rejected them).
 *   PHASE A2 - still without the gate, the da-DK edge originates a share of its
 *     own: it records a DIFFERENT digest than an en-US node does for the same
 *     kind of content. This is the drift the change removes.
 *   PHASE B - `DKG_SWM_DIGEST_ORDERING=code-unit` on the cores and one edge,
 *     mixed locales (nodes 1, 3 and 5 are da-DK): identical content written by a
 *     da-DK originator (node 3) and an en-US originator (node 2) records and
 *     names its snapshot by the same digest; a late da-DK edge with the gate on
 *     and a late en-US edge WITHOUT it (a legacy-mode node running this build)
 *     both sync it. Snapshots persisted before the flip stay in place.
 *
 * Only the node that originates a share records a digest and a snapshot file;
 * peers that receive the write hold the data but no digest, so digests are read
 * from the originators. Late joiners are where a peer-advertised digest is
 * checked against bytes.
 *
 * Rows are chosen so the canonical order really differs between the en-US,
 * da-DK and code-unit collations: an ordinary test corpus would give every
 * node the same digest and prove nothing.
 *
 * Run (the suite restarts nodes 1 to 6 with per-node environment through
 * `DEVNET_NODE_ENV_<N>`, see scripts/devnet.sh):
 *   pnpm run build && pnpm --dir packages/cli run build:prepared
 *   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
 *   pnpm test:devnet:swm-digest-locale
 *
 * Isolation: only self-created context graphs are written to; the shared
 * devnet-test graph and every node wallet are untouched. Every node is
 * restarted with the default environment at the start and again at the end.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEVNET_DIR,
  REPO_ROOT,
  detectDevnet,
  ensureAllIdentities,
  lexical,
  postJson,
  queryNode,
  sleep,
  waitFor,
  type DevnetNode,
  type DevnetState,
} from '../_bootstrap/harness.js';

const PREDICATE = 'https://schema.org/name';
const DA = 'LC_ALL=da_DK.UTF-8 LANG=da_DK.UTF-8';
const EN = 'LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8';
const CODE_UNIT = 'DKG_SWM_DIGEST_ORDERING=code-unit';
/** Names whose rows sort three different ways: `aa` collates after `z` in da-DK. */
const NAMES = ['aa', 'b', 'B', 'A', 'z', '_', '1', 'a-b'];
/** What a node logs at startup when it has restarted with the given digest configuration. */
const CONFIG_LINE = /SWM public-quads digest ordering=(\S+) collatorLocale=(\S+)/g;
/** Every log line that means a node rejected a snapshot on its digest. */
const DIGEST_FAILURE = /failed digest\/count validation|snapshot is missing or corrupt|failed integrity/i;

let nodes: Record<number, DevnetNode>;
let provider: DevnetState['provider'];
let counter = 0;

const unique = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

// ───────────────────────────── digest oracle ─────────────────────────────

interface Row { subject: string; predicate: string; object: string }

function digestOf(rows: readonly Row[], order: 'code-unit' | 'en-US' | 'da-DK'): string {
  const json = rows.map((row) => JSON.stringify([row.subject, row.predicate, row.object, '']));
  json.sort(order === 'code-unit' ? undefined : new Intl.Collator(order).compare);
  return `sha256:${createHash('sha256').update(`[${json.join(',')}]`).digest('hex')}`;
}

function quadsFor(tag: string): Row[] {
  return NAMES.map((name) => ({
    subject: `urn:swm-digest:${tag}:${name}`,
    predicate: PREDICATE,
    object: `"value ${name}"`,
  }));
}

// ───────────────────────────── node control ─────────────────────────────

/**
 * The environment a relaunched daemon should see: this shell's, minus what the
 * test runner injects (NODE_ENV=test switches code paths in the agent, VITEST*
 * and Vite's MODE/DEV/PROD are irrelevant to a node), plus the per-node override.
 */
function daemonEnvironment(num: number, environment: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, [`DEVNET_NODE_ENV_${num}`]: environment };
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITEST') || ['NODE_ENV', 'TEST', 'MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL'].includes(key)) {
      delete env[key];
    }
  }
  // A locale the suite did not choose must not leak into a node it did not configure.
  if (!/LC_ALL|LANG/.test(environment)) {
    delete env.LC_ALL;
    delete env.LANG;
    delete env.LC_COLLATE;
  }
  if (!environment.includes('DKG_SWM_DIGEST_ORDERING')) delete env.DKG_SWM_DIGEST_ORDERING;
  return env;
}

function restartNode(num: number, environment: string): void {
  const result = spawnSync('bash', ['./scripts/devnet.sh', 'restart-node', String(num)], {
    cwd: REPO_ROOT,
    env: daemonEnvironment(num, environment),
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (result.status !== 0) {
    throw new Error(`restart-node ${num} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
}

function daemonLog(num: number): string {
  const path = join(DEVNET_DIR, `node${num}`, 'daemon.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** The digest configuration a node logged at its most recent start. */
function lastDigestConfiguration(num: number): { ordering: string; collatorLocale: string } | null {
  const matches = [...daemonLog(num).matchAll(CONFIG_LINE)];
  const last = matches.at(-1);
  return last ? { ordering: last[1]!, collatorLocale: last[2]! } : null;
}

/** Head-identity trouble: a digest string that disagrees between operations of one head. */
const HEAD_RESIDUE = /CORRUPT_SWM_HEAD|ambiguous shareOperationId|multi-valued/i;

function headResidue(num: number, fromOffset: number): string[] {
  return daemonLog(num).slice(fromOffset).split('\n').filter((line) => HEAD_RESIDUE.test(line));
}

/** Deferrals of a multi-valued head are reported; an operation-identity conflict is a failure. */
function assertNoHeadIdentityConflict(num: number, fromOffset: number): void {
  const residue = headResidue(num, fromOffset);
  if (residue.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`node${num}: ${residue.length} head-residue log line(s), first: ${residue[0]}`);
  }
  expect(
    residue.filter((line) => /ambiguous shareOperationId/i.test(line)),
    `node${num} found operations of one head that disagree on their digest`,
  ).toEqual([]);
}

function digestFailures(num: number, fromOffset: number): string[] {
  return daemonLog(num).slice(fromOffset).split('\n').filter((line) => DIGEST_FAILURE.test(line));
}

function logOffsets(): Record<number, number> {
  return Object.fromEntries(Object.keys(nodes).map((n) => [Number(n), daemonLog(Number(n)).length]));
}

// ───────────────────────────── snapshot files ─────────────────────────────

function listSnapshotFiles(num: number): string[] {
  const root = join(DEVNET_DIR, `node${num}`, 'swm-public-snapshots');
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.nq')) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

/** `sha256:<hash>` names of the snapshot files on a node whose content mentions `tag`. */
function snapshotDigestsFor(num: number, tag: string): string[] {
  return listSnapshotFiles(num)
    .filter((file) => readFileSync(file, 'utf8').includes(`urn:swm-digest:${tag}:`))
    .map((file) => `sha256:${file.slice(file.lastIndexOf('/') + 1, -'.nq'.length)}`)
    .sort();
}

/** The quads a node persisted for `tag`, read back from its snapshot file. */
function snapshotRows(num: number, tag: string): Row[] {
  const rows: Row[] = [];
  for (const file of listSnapshotFiles(num)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes(`urn:swm-digest:${tag}:`)) continue;
    for (const line of text.split('\n')) {
      const match = /^<([^>]+)> <([^>]+)> (.+) \.$/.exec(line.trim());
      if (match) rows.push({ subject: match[1]!, predicate: match[2]!, object: match[3]! });
    }
  }
  return rows;
}

// ───────────────────────────── API helpers ─────────────────────────────

async function createContextGraph(node: DevnetNode, id: string): Promise<void> {
  const created = await postJson(node, '/api/context-graph/create', { id, name: `SWM digest locale ${id}` });
  expect(created.status, `create ${id}: ${JSON.stringify(created.json)}`).toBe(200);
  const registered = await postJson(node, '/api/context-graph/register', { id });
  expect(registered.status, `register ${id}: ${JSON.stringify(registered.json)}`).toBe(200);
  // A node treats the graph as confirmed once its registration is a few blocks
  // deep, and Hardhat only mines when a transaction arrives: mine them here so a
  // node that restarted moments ago is not left waiting on an idle chain.
  for (let block = 0; block < 10; block++) await provider.send('evm_mine', []);
}

async function subscribe(node: DevnetNode, contextGraphId: string): Promise<void> {
  // A node that just restarted answers 503 CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE
  // (retryable) until its chain and metadata reads have recovered.
  const result = await waitFor(`node${node.num} subscribes to ${contextGraphId}`, 120_000, 4_000, async () => {
    const attempt = await postJson(node, '/api/context-graph/subscribe', {
      contextGraphId,
      includeSharedMemory: true,
    });
    if (attempt.status === 503 && attempt.json?.retryable === true) return null;
    return attempt;
  });
  expect(result.status, `subscribe node${node.num} ${contextGraphId}: ${JSON.stringify(result.json)}`).toBe(200);
}

async function shareKnowledgeAsset(node: DevnetNode, contextGraphId: string, tag: string): Promise<void> {
  const name = unique(`swm-digest-${tag}-${++counter}`);
  const result = await postJson(node, '/api/knowledge-assets', {
    contextGraphId,
    name,
    quads: quadsFor(tag).map((row) => ({ ...row, graph: '' })),
    finalize: true,
    alsoShareSwm: true,
  });
  expect([200, 201], `share ${name} (HTTP ${result.status}): ${JSON.stringify(result.json)}`).toContain(result.status);
}

async function visibleSubjects(node: DevnetNode, contextGraphId: string, tag: string): Promise<number> {
  const rows = await queryNode(
    node,
    `SELECT ?s WHERE { GRAPH ?g { ?s <${PREDICATE}> ?o } FILTER(CONTAINS(STR(?s), "urn:swm-digest:${tag}:")) }`,
    { contextGraphId, view: 'shared-working-memory' },
  );
  return new Set(rows.map((row) => String((row as Record<string, unknown>).s))).size;
}

/**
 * The `dkg:publicQuadsDigest` values a node recorded for a context graph, read
 * from its shared-memory metadata. Only the node that originated a share (and a
 * node that caught one up from a descriptor) records one: peers that receive the
 * write over gossip hold the data but no digest.
 */
async function recordedDigests(node: DevnetNode, contextGraphId: string): Promise<string[]> {
  const rows = await queryNode(
    node,
    'SELECT ?d WHERE { GRAPH ?g { ?op <http://dkg.io/ontology/publicQuadsDigest> ?d } }',
    { contextGraphId },
  );
  return rows.map((row) => lexical((row as Record<string, unknown>).d as string)).sort();
}

async function waitForSharedMemory(node: DevnetNode, contextGraphId: string, tag: string): Promise<void> {
  await waitFor(
    `node${node.num} holds all ${NAMES.length} shared-memory subjects of ${tag}`,
    240_000,
    4_000,
    async () => ((await visibleSubjects(node, contextGraphId, tag)) === NAMES.length ? true : null),
  );
}

// ─────────────────────────────── the suite ───────────────────────────────

const oracle = {
  codeUnit: (rows: readonly Row[]) => digestOf(rows, 'code-unit'),
  enUS: (rows: readonly Row[]) => digestOf(rows, 'en-US'),
  daDK: (rows: readonly Row[]) => digestOf(rows, 'da-DK'),
};

beforeAll(async () => {
  const detected = await detectDevnet(6);
  if (!detected) {
    throw new Error('No devnet detected - run pnpm run build && ./scripts/devnet.sh start 6 before this suite.');
  }
  await ensureAllIdentities(detected, 4);
  nodes = detected.nodes;
  provider = detected.provider;
}, 300_000);

afterAll(() => {
  // Leave the devnet as the next suite expects it: every node on the default
  // locale with the legacy digest ordering.
  for (const n of [1, 2, 3, 4, 5, 6]) restartNode(n, '');
}, 600_000);

describe('the divergent corpus', () => {
  it('sorts three different ways, so no assertion below can pass vacuously', () => {
    const rows = quadsFor('probe');
    expect(new Set([oracle.codeUnit(rows), oracle.enUS(rows), oracle.daDK(rows)]).size).toBe(3);
  });
});

describe('SWM digests across host locales on a real devnet', () => {
  const phaseA = { tag: 'a', cg: unique('swm-digest-a') };
  const phaseA2 = { tag: 'a2', cg: phaseA.cg };
  const phaseB = { tag: 'b', cg: unique('swm-digest-b') };
  const phaseB2 = { tag: 'b', cg: unique('swm-digest-c') };

  it('starts node 5 on a da-DK host and every other node on the default locale', async () => {
    // A known starting point whatever an earlier run left behind.
    for (const n of [1, 2, 3, 4, 6]) restartNode(n, '');
    restartNode(5, DA);
    expect(lastDigestConfiguration(5)).toMatchObject({ ordering: 'locale' });
    expect(lastDigestConfiguration(5)?.collatorLocale).toMatch(/^da/);
    for (const n of [1, 2, 3, 4]) {
      expect(lastDigestConfiguration(n), `node${n} startup digest configuration`).toMatchObject({
        ordering: 'locale',
        collatorLocale: 'en-US',
      });
    }
  });

  it('phase A: a late da-DK edge syncs digests that an en-US node wrote, with no digest failure', async () => {
    const offsets = logOffsets();
    await createContextGraph(nodes[1]!, phaseA.cg);
    for (const n of [2, 3, 4]) await subscribe(nodes[n]!, phaseA.cg);
    await shareKnowledgeAsset(nodes[1]!, phaseA.cg, phaseA.tag);
    for (const n of [1, 2, 3, 4]) await waitForSharedMemory(nodes[n]!, phaseA.cg, phaseA.tag);

    const rows = quadsFor(phaseA.tag);
    const [enUS, daDK] = [oracle.enUS(rows), oracle.daDK(rows)];
    expect(enUS).not.toBe(daDK);
    // The en-US originator recorded the en-US digest and named its snapshot by it.
    expect(await recordedDigests(nodes[1]!, phaseA.cg)).toEqual([enUS]);
    expect(snapshotDigestsFor(1, phaseA.tag)).toEqual([enUS]);

    // The edge subscribes AFTER the write: its data arrives through catch-up,
    // which verifies the digest the peer advertised against the bytes. The
    // digest a da-DK node computes for the same quads is different.
    await subscribe(nodes[5]!, phaseA.cg);
    await waitForSharedMemory(nodes[5]!, phaseA.cg, phaseA.tag);
    await sleep(3_000);

    for (const n of [1, 2, 3, 4, 5]) {
      expect(digestFailures(n, offsets[n]!), `node${n} logged a digest validation failure`).toEqual([]);
      assertNoHeadIdentityConflict(n, offsets[n]!);
    }
    // Whatever the edge recorded is the advertised digest, never its own-locale one.
    const recorded = await recordedDigests(nodes[5]!, phaseA.cg);
    // eslint-disable-next-line no-console
    console.log(`phase A: node5 recorded digests ${JSON.stringify(recorded)} (advertised ${enUS})`);
    expect(recorded.filter((digest) => digest !== enUS)).toEqual([]);
    expect(snapshotRows(1, phaseA.tag)).toHaveLength(NAMES.length);
  });

  it('phase A2: without the gate, a da-DK node still writes a different digest for the same content', async () => {
    // The drift this change removes: the same rows, another host locale.
    await shareKnowledgeAsset(nodes[5]!, phaseA2.cg, phaseA2.tag);
    const rows = quadsFor(phaseA2.tag);
    const [enUS, daDK] = [oracle.enUS(rows), oracle.daDK(rows)];
    expect(enUS).not.toBe(daDK);
    const recorded = await waitFor('node5 records the digest of its own share', 60_000, 3_000, async () => {
      const digests = (await recordedDigests(nodes[5]!, phaseA2.cg)).filter((digest) => digest === daDK || digest === enUS);
      return digests.length > 0 ? digests : null;
    });
    expect(recorded).toEqual([daDK]);
    expect(snapshotDigestsFor(5, phaseA2.tag)).toEqual([daDK]);
  });

  it('phase B: with the gate on, originators on different locales write the same digest', async () => {
    restartNode(1, `${CODE_UNIT} ${DA}`);
    restartNode(2, `${CODE_UNIT} ${EN}`);
    restartNode(3, `${CODE_UNIT} ${DA}`);
    restartNode(4, CODE_UNIT);
    restartNode(5, `${CODE_UNIT} ${DA}`);
    restartNode(6, EN); // a legacy-mode node running this build: accepts, does not yet write, code-unit digests
    for (const n of [1, 3, 5]) {
      expect(lastDigestConfiguration(n)).toMatchObject({ ordering: 'code-unit' });
      expect(lastDigestConfiguration(n)?.collatorLocale).toMatch(/^da/);
    }
    expect(lastDigestConfiguration(2)).toMatchObject({ ordering: 'code-unit', collatorLocale: 'en-US' });
    expect(lastDigestConfiguration(6)).toMatchObject({ ordering: 'locale', collatorLocale: 'en-US' });

    const offsets = logOffsets();
    const codeUnit = oracle.codeUnit(quadsFor(phaseB.tag));
    // Identical content written by a da-DK originator (node 3) and an en-US
    // originator (node 2), into two different graphs.
    await createContextGraph(nodes[3]!, phaseB.cg);
    await createContextGraph(nodes[2]!, phaseB2.cg);
    for (const n of [1, 2, 4]) await subscribe(nodes[n]!, phaseB.cg);
    for (const n of [1, 3, 4]) await subscribe(nodes[n]!, phaseB2.cg);
    await shareKnowledgeAsset(nodes[3]!, phaseB.cg, phaseB.tag);
    await shareKnowledgeAsset(nodes[2]!, phaseB2.cg, phaseB2.tag);
    for (const n of [1, 2, 3, 4]) await waitForSharedMemory(nodes[n]!, phaseB.cg, phaseB.tag);
    for (const n of [1, 2, 3, 4]) await waitForSharedMemory(nodes[n]!, phaseB2.cg, phaseB2.tag);

    expect(await recordedDigests(nodes[3]!, phaseB.cg)).toEqual([codeUnit]);
    expect(await recordedDigests(nodes[2]!, phaseB2.cg)).toEqual([codeUnit]);
    // Both originators named their snapshot file by that one digest.
    expect(snapshotDigestsFor(3, phaseB.tag)).toEqual([codeUnit]);
    expect(snapshotDigestsFor(2, phaseB2.tag)).toEqual([codeUnit]);

    // Late subscribers: one with the gate on (da-DK), one without it (en-US).
    for (const n of [5, 6]) {
      await subscribe(nodes[n]!, phaseB.cg);
      await waitForSharedMemory(nodes[n]!, phaseB.cg, phaseB.tag);
    }
    await sleep(3_000);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(digestFailures(n, offsets[n]!), `node${n} logged a digest validation failure`).toEqual([]);
      assertNoHeadIdentityConflict(n, offsets[n]!);
    }
    for (const n of [5, 6]) {
      const recorded = await recordedDigests(nodes[n]!, phaseB.cg);
      // eslint-disable-next-line no-console
      console.log(`phase B: node${n} recorded digests ${JSON.stringify(recorded)} (advertised ${codeUnit})`);
      expect(recorded.filter((digest) => digest !== codeUnit)).toEqual([]);
    }
  });

  it('keeps what phase A persisted readable after the gate flipped: nothing renamed, nothing orphaned', async () => {
    const enUS = oracle.enUS(quadsFor(phaseA.tag));
    const daDK = oracle.daDK(quadsFor(phaseA2.tag));
    // Restarted with the gate on, node 1 still holds its en-US-named snapshot and
    // digest, and its shared memory still answers; node 5 still holds the da-DK-named
    // snapshot it wrote before the flip (its on-demand subscription did not survive
    // the restart, so its shared memory is not queried).
    expect(snapshotDigestsFor(1, phaseA.tag)).toEqual([enUS]);
    expect(await recordedDigests(nodes[1]!, phaseA.cg)).toEqual([enUS]);
    expect(await visibleSubjects(nodes[1]!, phaseA.cg, phaseA.tag)).toBe(NAMES.length);
    expect(snapshotDigestsFor(5, phaseA2.tag)).toEqual([daDK]);
  });
});
