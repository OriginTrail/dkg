/**
 * Mixed-version devnet interop.
 *
 * The rollout reality: a cluster runs MULTIPLE releases at once — cores upgraded
 * first, edges lagging one version "behind". The 2026-07-07 mainnet incident was
 * first (wrongly) blamed on exactly this, and every devnet lane before now ran a
 * single build, so cross-version behaviour was untested. This suite exercises
 * it: an older EDGE publishes through the newer CORES and confirms on-chain, and
 * a current core reaches quorum in the mixed cluster.
 *
 * Start a mixed-version devnet with the version-layout the harness now supports
 * (see scripts/devnet.sh `DEVNET_VERSION_LAYOUT`):
 *
 *   DEVNET_VERSION_LAYOUT="all:current,edges:prev" ./scripts/devnet.sh start 6
 *
 * `prev` resolves to the latest release tag — the version immediately preceding
 * the code under test on main (e.g. v10.0.3 while 10.0.4 is in development).
 * N-version layouts also work:
 *
 *   DEVNET_VERSION_LAYOUT="1-2:current,3-4:v10.0.3,5-6:v10.0.2" ./scripts/devnet.sh start 6
 *
 * When run against a SINGLE-version devnet the version-skew checks skip with an
 * explanatory message (the functional publishes still run), so the suite is
 * green-and-informative on ordinary lanes and only enforces skew when one is
 * actually present.
 *
 * Run: pnpm test:devnet:mixed-version
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectDevnet,
  makeNquadsFile,
  publishViaCli,
  fetchRetry,
  CONTEXT_GRAPH,
  type DevnetNode,
  type DevnetState,
} from '../_bootstrap/harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const NODE_COUNT = Number(process.env.DEVNET_NODE_COUNT ?? 6);

interface NodeVersion {
  num: number;
  role: string;
  version: string;
}

/** Parse `MAJOR.MINOR.PATCH`, or null if the string carries no semver — callers
 *  must handle null explicitly rather than silently comparing a 0.0.0 stand-in
 *  (otReviewAgent #1513: coercing an unknown version to 0.0.0 hides the very
 *  invariant the skew assertions depend on). */
function parseSemver(v: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const KNOWN_ROLES = new Set(['core', 'edge']);

/** Standard semver compare over two ALREADY-PARSED versions. */
function cmpSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Raw /api/status — no magic fallbacks. Missing fields surface as empty
 *  strings so the reachability test can fail loudly on a malformed boundary
 *  instead of silently mislabeling a node's version/role. */
async function statusOf(node: DevnetNode): Promise<{ version: string; nodeRole: string }> {
  const res = await fetchRetry(`http://127.0.0.1:${node.apiPort}/api/status`);
  const j = (await res.json()) as { version?: string; nodeRole?: string };
  return { version: j.version ?? '', nodeRole: j.nodeRole ?? '' };
}

let devnet: DevnetState | null = null;
let versions: NodeVersion[] = [];

describe('mixed-version devnet interop', () => {
  beforeAll(async () => {
    devnet = await detectDevnet(NODE_COUNT);
    if (!devnet) return;
    const nums = Object.keys(devnet.nodes).map(Number).sort((a, b) => a - b);
    versions = [];
    for (const num of nums) {
      const s = await statusOf(devnet.nodes[num]);
      versions.push({ num, role: s.nodeRole, version: s.version });
    }
    // eslint-disable-next-line no-console
    console.log(
      '[mixed-version] cluster: ' +
        versions.map((v) => `node${v.num}=${v.role}:${v.version}`).join(' '),
    );
  }, 60_000);

  it('devnet is reachable (otherwise the suite skips)', () => {
    if (!devnet) {
      // eslint-disable-next-line no-console
      console.warn('[mixed-version] no devnet detected — start one to run this suite');
      return;
    }
    expect(versions.length).toBeGreaterThan(0);
    // Fail loudly on a malformed status boundary rather than silently coercing:
    // the whole suite reasons over versions and core/edge roles, so every node
    // MUST report a parseable version and a known role (otReviewAgent #1513).
    const badVersion = versions.filter((v) => parseSemver(v.version) === null);
    expect(
      badVersion,
      `nodes with a missing/unparseable /api/status version: ${badVersion.map((v) => `node${v.num}="${v.version}"`).join(', ')}`,
    ).toEqual([]);
    const badRole = versions.filter((v) => !KNOWN_ROLES.has(v.role));
    expect(
      badRole,
      `nodes with an unexpected /api/status nodeRole (want core|edge): ${badRole.map((v) => `node${v.num}="${v.role}"`).join(', ')}`,
    ).toEqual([]);
  });

  it('runs at least two distinct versions (else skips the skew checks with guidance)', () => {
    if (!devnet) return;
    const distinct = [...new Set(versions.map((v) => v.version))];
    if (distinct.length < 2) {
      // eslint-disable-next-line no-console
      console.warn(
        `[mixed-version] single-version cluster (${distinct.join(', ')}). ` +
          'Start with DEVNET_VERSION_LAYOUT="all:current,edges:prev" to exercise version skew.',
      );
      return;
    }
    expect(distinct.length).toBeGreaterThanOrEqual(2);
  });

  it('edges are NOT ahead of cores (rollout shape: edges lag the cores)', () => {
    if (!devnet) return;
    // Parse up front; the reachability test above already guaranteed every node
    // has a parseable version, so a null here is a real invariant break, not a
    // silent 0.0.0.
    const parsed = (role: string) =>
      versions
        .filter((v) => v.role === role)
        .map((v) => {
          const p = parseSemver(v.version);
          if (!p) throw new Error(`node${v.num} has an unparseable version "${v.version}"`);
          return p;
        });
    const cores = parsed('core');
    const edges = parsed('edge');
    if (cores.length === 0 || edges.length === 0) return;
    const minCore = [...cores].sort(cmpSemver)[0];
    const maxEdge = [...edges].sort(cmpSemver)[edges.length - 1];
    // Every edge <= every core (edges behind, or equal on a single-version lane).
    expect(
      cmpSemver(maxEdge, minCore),
      `expected max edge version (${maxEdge.join('.')}) <= min core version (${minCore.join('.')})`,
    ).toBeLessThanOrEqual(0);
  });

  it('an EDGE publishes a public KA that confirms through the (newer) cores', async () => {
    if (!devnet) return;
    const edge = versions.find((v) => v.role === 'edge');
    if (!edge) {
      // eslint-disable-next-line no-console
      console.warn('[mixed-version] no edge node in the cluster — skipping edge publish');
      return;
    }
    const { path } = makeNquadsFile(HERE, 'mixed-edge-pub', CONTEXT_GRAPH);
    // publishViaCli asserts a confirmed/finalized status + positive kaId itself.
    const result = await publishViaCli(devnet.nodes[edge.num], CONTEXT_GRAPH, path);
    expect(result.kaId).toBeGreaterThan(0n);
  }, 180_000);

  it('a CORE publishes and reaches ACK quorum in the mixed cluster', async () => {
    if (!devnet) return;
    const core = versions.find((v) => v.role === 'core');
    if (!core) return;
    const { path } = makeNquadsFile(HERE, 'mixed-core-pub', CONTEXT_GRAPH);
    const result = await publishViaCli(devnet.nodes[core.num], CONTEXT_GRAPH, path);
    expect(result.kaId).toBeGreaterThan(0n);
  }, 180_000);
});
