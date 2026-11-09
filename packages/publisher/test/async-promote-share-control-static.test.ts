/**
 * OT-RFC-73 AC1 check (3), share queue: every reference to the share control graph IRI (`urn:dkg:promote-queue:control-plane`)
 * in any package's src/ is covered, meaning the boundary recorder observed that site in a driven scenario, matched by a source
 * label unique to the site. Three static facts and one dynamic one:
 *   1. the files that reference the graph in code are exactly the classified ones (a new one fails until it is classified);
 *   2. each share source label is one string literal in one place (a label shared by several sites fails);
 *   3. every store call in a queue site file carries the options its row of the tagging table needs;
 *   4. the driven workload (the oracle's script) observed every label the scan found, with its row's options, and no label the
 *      scan did not find.
 * The scan reads every package's src/ directly, so a package's own pull request only runs it when the publisher lane runs; a
 * reference added elsewhere is caught on the next full run (merge queue).
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI } from '../src/async-promote-queue-utils.js';
import {
  SHARE_OWNERSHIP_READER_SOURCE,
  SHARE_QUEUE_USAGE_SOURCE,
  SHARE_RETENTION_SCAN_SOURCE,
  recordShareStore,
  shareRowOf,
  withControlPath,
} from './_helpers/share-control-recorder.js';
import {
  graphReferences,
  labelOccurrences,
  readPackageSources,
  storeSites,
  SHARE_CONTROL_GRAPH_IRI,
  type OptionsClass,
  type SourceText,
} from './_helpers/share-control-static.js';
import { driveRetentionWorkload } from './_helpers/share-retention-workload.js';
import { driveShareWorkload } from './_helpers/share-control-workload.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SRC = 'packages/publisher/src/';

/** The files that reference the share control graph in code, and what each is. A reference anywhere else fails the census. */
const GRAPH_REFERENCE_FILES: Readonly<Record<string, string>> = {
  [`${SRC}async-promote-queue-utils.ts`]: 'defines the graph constant',
  [`${SRC}async-promote-queue-impl.ts`]: 'queue store sites (the mutex)',
  [`${SRC}async-promote-ownership.ts`]: 'the conflict read, and the lock-free reader',
  [`${SRC}share-reconciliation.ts`]: 'the retained-share reconcile read (in the mutex)',
  [`${SRC}async-queue-depth.ts`]: 'the monitoring COUNT (background)',
  [`${SRC}async-promote-retention.ts`]: 'the retention sweep: verify and delete in the mutex (control), the graph its holds lock',
};

/**
 * The files whose store calls are queue sites, and the options classes a call there may carry. `bound-promote-job.ts` reaches
 * the graph through the `graphUri` the queue passes it, so it is a site file without naming the graph.
 */
const SITE_FILES: Readonly<Record<string, readonly OptionsClass[]>> = {
  [`${SRC}async-promote-queue-impl.ts`]: ['control'],
  [`${SRC}bound-promote-job.ts`]: ['control'],
  [`${SRC}share-reconciliation.ts`]: ['control'],
  [`${SRC}promote-job-page.ts`]: ['control'],
  [`${SRC}promote-job-listing.ts`]: ['control'],
  [`${SRC}promote-post-commit-sweep.ts`]: [],
  [`${SRC}async-promote-ownership.ts`]: ['parameter', 'reader'],
  [`${SRC}async-queue-depth.ts`]: ['parameter', 'monitoring'],
  [`${SRC}promote-admission-persistence.ts`]: [],
  [`${SRC}async-promote-retention.ts`]: ['control'],
  [`${SRC}async-promote-retention-scan.ts`]: ['retention-scan'],
};

const sources = readPackageSources(REPO_ROOT);
const byPath = new Map(sources.map((file) => [file.path, file]));
const site = (path: string): SourceText => byPath.get(path) ?? { path, text: '' };

/** Reference census: which of `files` reference the graph in code, outside the classified ones. */
const unclassifiedReferences = (files: readonly SourceText[]) =>
  files.filter((file) => graphReferences(file).length > 0 && !(file.path in GRAPH_REFERENCE_FILES)).map((file) => file.path);

/** Label census: every share label that is not exactly one string literal in the files. */
function sharedLabels(files: readonly SourceText[]): string[] {
  const seen = new Map<string, number>();
  for (const file of files) for (const { label } of labelOccurrences(file)) seen.set(label, (seen.get(label) ?? 0) + 1);
  return [...seen].filter(([, count]) => count !== 1).map(([label]) => label).sort();
}

describe('the share control graph census over every package\'s src/', () => {
  it('scans the packages it claims to', () => {
    expect(sources.length).toBeGreaterThan(1_000);
    const packages = new Set(sources.map((file) => file.path.split('/')[1]));
    for (const name of ['agent', 'cli', 'core', 'publisher', 'storage']) expect(packages.has(name), name).toBe(true);
    for (const path of Object.keys(GRAPH_REFERENCE_FILES)) expect(byPath.has(path), path).toBe(true);
  });

  it('finds the graph referenced in code only in the classified files, each of which still references it', () => {
    expect(unclassifiedReferences(sources)).toEqual([]);
    for (const path of Object.keys(GRAPH_REFERENCE_FILES)) {
      expect(graphReferences(site(path)).length, `${path} no longer references the graph; update the classification`).toBeGreaterThan(0);
    }
  });

  it('gives every share source label to exactly one site', () => {
    expect(sharedLabels(sources)).toEqual([]);
  });

  it.each(Object.entries(SITE_FILES))('%s: every store call carries the options its row of the tagging table needs', (path, allowed) => {
    const sites = storeSites(site(path));
    const offenders = sites.filter((s) => !allowed.includes(s.options)).map((s) => `${path}:${s.line} ${s.callee} (${s.options})`);
    expect(offenders).toEqual([]);
  });

  it('has no caller of the ownership read outside the queue files, and the read\'s own options parameter has no default', () => {
    const callers = sources.filter((file) => /\breadPromoteOwnershipCandidates\(/.test(file.text)).map((file) => file.path);
    expect(callers).toEqual([`${SRC}async-promote-ownership.ts`, `${SRC}async-promote-queue-impl.ts`]);   // its definition and the in-lock check
    expect(callers.every((path) => path in SITE_FILES)).toBe(true);
    const read = storeSites(site(`${SRC}async-promote-ownership.ts`)).filter((s) => s.callee === 'query');
    expect(read.map((s) => s.options)).toEqual(['parameter']);
  });

  it('finds store calls in the queue files (the scan is not vacuous)', () => {
    const control = Object.keys(SITE_FILES).flatMap((path) => storeSites(site(path))).filter((s) => s.options === 'control');
    expect(control.length).toBeGreaterThanOrEqual(8);
    expect(storeSites(site(`${SRC}async-promote-ownership.ts`)).map((s) => s.options).sort()).toEqual(['parameter', 'reader']);
  });
});

describe('every site the scan found is observed by the recorder in a driven scenario', () => {
  const fileLabels = (path: string): string[] => labelOccurrences(site(path)).map((o) => o.label);
  const scanned = sources.flatMap((file) => labelOccurrences(file).map((o) => o.label));
  // The retention sweep's sites are driven by their own scenario below (the share workload does not run a sweep).
  const retentionLabels = scanned.filter((l) => l.startsWith('publisher.asyncPromote.retention.')).sort();
  const controlLabels = scanned.filter((l) => l !== SHARE_OWNERSHIP_READER_SOURCE && l !== SHARE_QUEUE_USAGE_SOURCE && !retentionLabels.includes(l)).sort();

  it.each([
    { name: 'atomic', atomic: true, hidden: [] as string[] },
    { name: 'fallback', atomic: false, hidden: ['replaceSubject', 'replaceSubjectAndInsert'] },
  ])('$name branch: the control labels, the reader and the COUNT are all observed with the options of their row', async ({ atomic, hidden }) => {
    const recorder = recordShareStore(new OxigraphStore(), { hidden });
    await withControlPath(true, () => driveShareWorkload(recorder, { atomic }));
    const onGraph = recorder.calls.filter((call) => call.graphs.includes(DEFAULT_PROMOTE_CONTROL_GRAPH_URI));
    const rowLabels = (row: string) => [...new Set(onGraph.filter((call) => shareRowOf(call, [DEFAULT_PROMOTE_CONTROL_GRAPH_URI]) === row).map((call) => call.source))].sort();

    // Observed on the control rows, all tagged: exactly the control labels the scan found (nothing unseen, nothing unknown).
    expect(rowLabels('control')).toEqual(controlLabels);
    expect(onGraph.filter((call) => shareRowOf(call, [DEFAULT_PROMOTE_CONTROL_GRAPH_URI]) === 'control').every((call) => call.options?.controlQueue === 'share')).toBe(true);
    expect(rowLabels('ownership-reader')).toEqual([SHARE_OWNERSHIP_READER_SOURCE]);
    expect(rowLabels('queue-usage')).toEqual([SHARE_QUEUE_USAGE_SOURCE]);
  });

  it.each(['report', 'delete'] as const)('retention sweep (%s mode): its verify and delete sites are control rows, its scan a background row, and the scan found no other label', async (mode) => {
    const inner = new OxigraphStore();
    const recorder = recordShareStore(inner);
    await withControlPath(true, async () => { await driveRetentionWorkload(recorder, inner, { mode }); });
    const onGraph = recorder.calls.filter((call) => call.graphs.includes(DEFAULT_PROMOTE_CONTROL_GRAPH_URI));
    const rowLabels = (row: string) => [...new Set(onGraph.filter((call) => shareRowOf(call, [DEFAULT_PROMOTE_CONTROL_GRAPH_URI]) === row).map((call) => call.source))].sort();
    expect(rowLabels('retention-scan')).toEqual([SHARE_RETENTION_SCAN_SOURCE]);
    // report mode deletes nothing, so only its verify is observed; delete mode observes both control sites
    expect(rowLabels('control')).toEqual(retentionLabels.filter((l) => l !== SHARE_RETENTION_SCAN_SOURCE && (mode === 'delete' || l.endsWith('.verify'))));
    if (mode === 'delete') expect([...rowLabels('control'), ...rowLabels('retention-scan')].sort()).toEqual(retentionLabels);
    expect(onGraph.filter((call) => shareRowOf(call, [DEFAULT_PROMOTE_CONTROL_GRAPH_URI]) === 'control').every((call) => call.options?.controlQueue === 'share')).toBe(true);
  });

  it('attributes each queue file\'s labels to that file: the site files between them hold every label', () => {
    const inSiteFiles = Object.keys(SITE_FILES).flatMap(fileLabels).sort();
    expect(inSiteFiles).toEqual([...scanned].sort());
    for (const path of Object.keys(GRAPH_REFERENCE_FILES).filter((p) => p in SITE_FILES)) {
      expect(fileLabels(path).length, `${path} references the graph but names no source label`).toBeGreaterThan(0);
    }
  });
});

describe('the scanners report what they must', () => {
  const fixture = (path: string, text: string): SourceText => ({ path, text });

  it('reports a code reference outside the classified files, by IRI and by constant, and ignores comments', () => {
    const files = [
      fixture('packages/cli/src/a.ts', `const g = '${SHARE_CONTROL_GRAPH_IRI}';`),
      fixture('packages/agent/src/b.ts', `import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI } from '@origintrail-official/dkg-publisher';`),
      fixture('packages/agent/src/c.ts', `// the queue's control graph (${SHARE_CONTROL_GRAPH_IRI}) lives in the store\nexport const x = 1;`),
      fixture(`${SRC}async-promote-queue-impl.ts`, `const g = '${SHARE_CONTROL_GRAPH_IRI}';`),
    ];
    expect(unclassifiedReferences(files)).toEqual(['packages/cli/src/a.ts', 'packages/agent/src/b.ts']);
  });

  it('reports a label that is two string literals, in one file or two', () => {
    const label = 'publisher.asyncPromote.readJob';
    expect(sharedLabels([fixture('a.ts', `a('${label}'); b('${label}');`)])).toEqual([label]);
    expect(sharedLabels([fixture('a.ts', `a('${label}');`), fixture('b.ts', `b("${label}");`)])).toEqual([label]);
    expect(sharedLabels([fixture('a.ts', `a('${label}'); b('publisher.asyncPromote.writeJob'); // '${label}'`)])).toEqual([]);
  });

  it('reports a pass-through options parameter with a default or a question mark, not only a required one', () => {
    const text = [
      "async function required(store, options: QueryOptions) { return store.query(sql, options); }",
      "async function defaulted(store, options: QueryOptions = { source: 'publisher.asyncPromote.findActiveConflict' }) { return store.query(sql, options); }",
      "async function optional(store, options?: QueryOptions) { return store.query(sql, options); }",
      "const options = controlStoreOptions('share', 'publisher.asyncPromote.a');",
      "async function shadowed(store) { return store.query(sql, options); }",
    ].join('\n');
    expect(storeSites(fixture('fixture.ts', text)).map((s) => s.options)).toEqual(['parameter', 'defaulted-parameter', 'defaulted-parameter', 'control']);
  });

  it('reports a store call whose options lost the control tag, or never had options', () => {
    const text = [
      "import { controlStoreOptions } from '@origintrail-official/dkg-storage';",
      "const tagged = controlStoreOptions('share', 'publisher.asyncPromote.a');",
      "await this.store.query(sql, controlStoreOptions('share', 'publisher.asyncPromote.b'));",
      "await this.store.query(sql, tagged);",
      "await this.store.query(sql, { ...controlStoreOptions('share', 'publisher.asyncPromote.c'), signal });",
      "await this.store.query(sql, { source: 'publisher.asyncPromote.d' });",
      "await this.store.query(sql);",
      "await this.store.query(sql, controlStoreOptions('publisher', 'publisher.asyncLift.e'));",
      "await deleteByPatternWithoutCount(this.store, pattern, { source: 'publisher.asyncPromote.f' });",
      "await replaceSubjectAtomicallyOrFallback(store, graph, subject, quads, 'publisher.asyncPromote.g');",
      "await this.store.createGraph(graph); await this.store.flush?.();",
    ].join('\n');
    expect(storeSites(fixture('fixture.ts', text)).map((s) => [s.callee, s.options])).toEqual([
      ['query', 'control'], ['query', 'control'], ['query', 'control'],
      ['query', 'other'], ['query', 'missing'], ['query', 'other'],
      ['deleteByPatternWithoutCount', 'other'], ['replaceSubjectAtomicallyOrFallback', 'other'],
    ]);
  });
  it('classes the retention scan\'s options as such, and nothing that merely resembles them', () => {
    const text = [
      "const SCAN_OPTIONS = { source: RETENTION_SCAN_SOURCE, priority: 'background' };",
      'await ctx.store.query(sql, SCAN_OPTIONS);',
      "await ctx.store.query(sql, { source: 'publisher.asyncPromote.retention.scan', priority: 'background' });",
      "await ctx.store.query(sql, { source: RETENTION_SCAN_SOURCE, priority: 'normal' });",
      'await ctx.store.query(sql, { source: RETENTION_SCAN_SOURCE });',
      "await ctx.store.query(sql, { source: RETENTION_SCAN_SOURCE, priority: 'background', signal });",
      "await ctx.store.query(sql, { source: 'publisher.asyncPromote.retention.other', priority: 'background' });",
    ].join('\n');
    expect(storeSites(fixture('fixture.ts', text)).map((s) => s.options)).toEqual(['retention-scan', 'retention-scan', 'other', 'other', 'other', 'other']);
  });
});
