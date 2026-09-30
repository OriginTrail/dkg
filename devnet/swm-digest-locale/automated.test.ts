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
 *     cores are en-US and write en-US digests. A late-joining da-DK edge syncs
 *     that public graph, sees all its Shared Working Memory, stores the
 *     snapshot under the digest its peers advertised, and logs no digest
 *     validation failure. Before this change it rejected them.
 *   PHASE B - `DKG_SWM_DIGEST_ORDERING=code-unit` on the cores and one edge,
 *     mixed locales (cores 1 and 3 are da-DK): every core writes the SAME
 *     snapshot file name, a late da-DK edge with the gate on and a late en-US
 *     edge WITHOUT it (a legacy-mode node running this build) both sync it,
 *     and the snapshots written in phase A stay readable after the flip.
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
 * devnet-test graph and every node wallet are untouched. The nodes are left
 * running with the environment of the last phase; restart the devnet before
 * running another suite that assumes default nodes.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEVNET_DIR,
  REPO_ROOT,
  detectDevnet,
  ensureAllIdentities,
  postJson,
  queryNode,
  sleep,
  waitFor,
  type DevnetNode,
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
}

async function subscribe(node: DevnetNode, contextGraphId: string): Promise<void> {
  const result = await postJson(node, '/api/context-graph/subscribe', {
    contextGraphId,
    includeSharedMemory: true,
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
  expect(result.status, `share ${name}: ${JSON.stringify(result.json)}`).toBe(200);
}

async function visibleSubjects(node: DevnetNode, contextGraphId: string, tag: string): Promise<number> {
  const rows = await queryNode(
    node,
    `SELECT ?s WHERE { GRAPH ?g { ?s <${PREDICATE}> ?o } FILTER(STRCONTAINS(STR(?s), "urn:swm-digest:${tag}:")) }`,
    { contextGraphId, view: 'shared-working-memory' },
  );
  return new Set(rows.map((row) => String((row as Record<string, unknown>).s))).size;
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
}, 300_000);

describe('the divergent corpus', () => {
  it('sorts three different ways, so no assertion below can pass vacuously', () => {
    const rows = quadsFor('probe');
    expect(new Set([oracle.codeUnit(rows), oracle.enUS(rows), oracle.daDK(rows)]).size).toBe(3);
  });
});

describe('SWM digests across host locales on a real devnet', () => {
  const phaseA = { tag: 'a', cg: unique('swm-digest-a') };
  const phaseB = { tag: 'b', cg: unique('swm-digest-b') };

  it('starts node 5 on a da-DK host and every other node on the default locale', async () => {
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

  it('phase A: a late da-DK edge syncs digests that en-US nodes wrote, with no digest failure', async () => {
    const offsets = logOffsets();
    await createContextGraph(nodes[1]!, phaseA.cg);
    for (const n of [2, 3, 4]) await subscribe(nodes[n]!, phaseA.cg);
    await shareKnowledgeAsset(nodes[1]!, phaseA.cg, phaseA.tag);
    for (const n of [1, 2, 3, 4]) await waitForSharedMemory(nodes[n]!, phaseA.cg, phaseA.tag);

    // The edge subscribes AFTER the write: its data arrives through catch-up
    // sync from the en-US cores, which verifies the digest a peer advertised
    // against the bytes. A da-DK node's own digest for them would differ.
    await subscribe(nodes[5]!, phaseA.cg);
    await waitForSharedMemory(nodes[5]!, phaseA.cg, phaseA.tag);
    await sleep(3_000);

    for (const n of [1, 2, 3, 4, 5]) {
      expect(digestFailures(n, offsets[n]!), `node${n} logged a digest validation failure`).toEqual([]);
      assertNoHeadIdentityConflict(n, offsets[n]!);
    }

    const rows = quadsFor(phaseA.tag);
    const [enUS, daDK] = [oracle.enUS(rows), oracle.daDK(rows)];
    expect(enUS).not.toBe(daDK);
    // Every en-US core wrote the en-US digest ...
    for (const n of [1, 2, 3, 4]) {
      expect(snapshotDigestsFor(n, phaseA.tag), `core node${n} snapshot name`).toEqual([enUS]);
    }
    // ... and the da-DK edge, whose own-locale digest would be different, holds
    // the snapshot under the digest its peers advertised.
    expect(snapshotDigestsFor(5, phaseA.tag)).toEqual([enUS]);
    expect(snapshotRows(1, phaseA.tag)).toHaveLength(NAMES.length);
  });

  it('phase B: with the gate on, every core writes the same snapshot file whatever its locale', async () => {
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
    await createContextGraph(nodes[3]!, phaseB.cg);
    for (const n of [1, 2, 4]) await subscribe(nodes[n]!, phaseB.cg);
    await shareKnowledgeAsset(nodes[3]!, phaseB.cg, phaseB.tag);
    for (const n of [1, 2, 3, 4]) await waitForSharedMemory(nodes[n]!, phaseB.cg, phaseB.tag);

    const codeUnit = oracle.codeUnit(quadsFor(phaseB.tag));
    for (const n of [1, 2, 3, 4]) {
      expect(snapshotDigestsFor(n, phaseB.tag), `node${n} snapshot name`).toEqual([codeUnit]);
    }

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
      expect(snapshotDigestsFor(n, phaseB.tag), `late node${n} snapshot name`).toEqual([codeUnit]);
    }
  });

  it('keeps phase A snapshots readable after the gate flipped: nothing renamed, nothing orphaned', async () => {
    const rows = quadsFor(phaseA.tag);
    const enUS = oracle.enUS(rows);
    // The file a node persisted before the flip is still there under its
    // original name, and its shared memory still answers.
    for (const n of [1, 2]) {
      expect(snapshotDigestsFor(n, phaseA.tag), `node${n} phase A snapshot after flip`).toEqual([enUS]);
      expect(await visibleSubjects(nodes[n]!, phaseA.cg, phaseA.tag)).toBe(NAMES.length);
    }
  });
});
