/**
 * OT-RFC-73 AC1 check (3), publisher queue: the static IRI-coverage test.
 *
 * Every reference to the publisher queue's control-plane, wallet-lock or journal graph IRI in ANY package's `src/`
 * must be covered: the boundary recorder observed that call site in a driven scenario (the workloads of
 * `async-lift-queue-boundary-oracle.test.ts`), matched by a source label unique to the site (every site is
 * labelled after P1b; the test fails on a label shared by several sites) or, for the option-less `createGraph`, by
 * its method and graph. A new file that touches a queue graph, a new label, or a new store call in a queue file
 * fails here until it is declared below AND driven by a scenario.
 *
 * What counts as a reference: the three graph IRIs, the constants that carry them (`DEFAULT_CONTROL_GRAPH_URI`,
 * `DEFAULT_WALLET_LOCK_GRAPH_URI`, `DEFAULT_JOURNAL_GRAPH_URI`, and the alias `DEFAULT_GRAPH_URI`), the bare family
 * prefix `urn:dkg:publisher:` as a string, and any `publisher.asyncLift.*` / `publisher.queueUsage.lift*` source
 * label (a queue module may reach its graph through a configured URI and never name the IRI). Comments are not
 * code and are ignored.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  PUBLISHER_ROW_SOURCES,
  ROUTING_COVERED_METHODS,
  auditPublisherCalls,
  type RecordedStoreCall,
} from './_helpers/queue-boundary-oracle.js';
import { runPublisherFundingScenario, runPublisherPagingScenario, runPublisherRetentionScenario, runPublisherWorkload, type PublisherStack } from './_helpers/publisher-queue-scenarios.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PACKAGES = join(REPO_ROOT, 'packages');

const GRAPH_IRIS = [
  'urn:dkg:publisher:control-plane',
  'urn:dkg:publisher:wallet-locks',
  'urn:dkg:publisher:journal',
] as const;
const GRAPH_PREFIX = 'urn:dkg:publisher:';
const GRAPH_IDENTIFIERS = new Set([
  'DEFAULT_CONTROL_GRAPH_URI', 'DEFAULT_WALLET_LOCK_GRAPH_URI', 'DEFAULT_JOURNAL_GRAPH_URI', 'DEFAULT_GRAPH_URI',
]);
/** Source labels of the publisher queue's graphs. (`publisher.queueUsage.share` and `publisher.asyncPromote.*` belong to the share queue.) */
const QUEUE_LABEL = /^publisher\.(?:asyncLift\.[\w.]+|queueUsage\.lift\w*)$/;

const STORE_METHODS = new Set([
  'query', 'update', 'insert', 'delete', 'deleteByPattern', 'deleteByPatternWithoutCount', 'deleteBySubjectPrefix',
  'replaceSubject', 'replaceSubjectAndInsert', 'replaceGraph', 'dropGraph', 'hasGraph', 'countQuads', 'createGraph', 'flush',
]);
const STORE_HELPERS = new Set([
  'deleteByPatternWithoutCount', 'tryReplaceSubjectAtomically', 'tryReplaceSubjectAndInsertAtomically',
  'replaceSubjectAtomicallyOrFallback',
]);

interface FileFacts {
  /** The graph IRIs, graph constants and family prefix the code names. */
  readonly references: string[];
  /** Queue source labels, one entry per string literal. */
  readonly labels: string[];
  /** Direct store calls: `store.m(...)` / `this.store.m(...)` and the free helpers that take the store. */
  readonly storeCalls: string[];
}

function factsOf(fileName: string, text: string): FileFacts {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const references: string[] = [];
  const labels: string[] = [];
  const storeCalls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      const value = node.text;
      if ((GRAPH_IRIS as readonly string[]).includes(value) || value === GRAPH_PREFIX) references.push(value);
      if (QUEUE_LABEL.test(value)) labels.push(value);
    } else if (ts.isIdentifier(node) && GRAPH_IDENTIFIERS.has(node.text)) {
      references.push(node.text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && STORE_METHODS.has(callee.name.text)
        && /(?:^|\.)store$/.test(callee.expression.getText(source))) {
        storeCalls.push(callee.name.text);
      } else if (ts.isIdentifier(callee) && STORE_HELPERS.has(callee.text)) {
        const first = node.arguments[0]?.getText(source) ?? '';
        if (/(?:^|\.)store$/.test(first)) storeCalls.push(callee.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { references, labels, storeCalls };
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
    }
  };
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    const src = join(PACKAGES, pkg.name, 'src');
    if (pkg.isDirectory() && existsSync(src)) walk(src);
  }
  return out;
}

/** Facts of every `src/` file in every package that mentions a queue graph or label at all (cheap text filter first). */
function queueFiles(): Map<string, FileFacts> {
  const found = new Map<string, FileFacts>();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('urn:dkg:publisher') && !text.includes('_GRAPH_URI') && !text.includes('publisher.asyncLift.')
      && !text.includes('publisher.queueUsage.lift')) continue;
    const facts = factsOf(file, text);
    if (facts.references.length > 0 || facts.labels.length > 0) {
      found.set(relative(REPO_ROOT, file).split('\\').join('/'), facts);
    }
  }
  return found;
}

/** A label that more than one site carries cannot say which site it was observed at. */
export function sharedLabels(files: ReadonlyMap<string, Pick<FileFacts, 'labels'>>): string[] {
  const count = new Map<string, number>();
  for (const { labels } of files.values()) for (const label of labels) count.set(label, (count.get(label) ?? 0) + 1);
  return [...count].filter(([, n]) => n > 1).map(([label]) => label).sort();
}

interface QueueFile {
  /** Why the file is in the inventory. */
  readonly role: 'sites' | 'definitions' | 'offline' | 'wipe';
  /** The queue labels the file carries, each exactly once. */
  readonly labels: readonly string[];
  /** Direct store calls the file makes, in source order. */
  readonly storeCalls: readonly string[];
  readonly note?: string;
}

const L = (name: string): string => `publisher.asyncLift.${name}`;

/**
 * Every `src/` file in the repository that names a publisher queue graph or carries one of its labels. Adding a
 * store call, a label or a file changes what the scan finds, so the test fails until the entry is updated and the
 * driven scenarios cover the new site.
 */
const QUEUE_FILES: Readonly<Record<string, QueueFile>> = {
  'packages/publisher/src/async-lift-control-plane.ts': {
    role: 'definitions', labels: [], storeCalls: [], note: 'defines the graph IRIs and constants; no store call',
  },
  'packages/publisher/src/async-lift-publisher-utils.ts': {
    role: 'definitions', labels: [], storeCalls: [], note: 'imports the constants for the serializers; no store call',
  },
  'packages/publisher/src/async-lift-publisher-impl.ts': {
    role: 'sites',
    labels: [L('getStatus'), L('lookupVmPublishIntent'), L('writeVmPublishIntentIndex'), L('readJournalEntries'), L('deleteJob'),
      L('deleteJobRequest'), L('retryList')].sort(),
    storeCalls: ['query', 'query', 'insert', 'createGraph', 'createGraph', 'createGraph', 'query', 'deleteByPatternWithoutCount',
      'deleteByPatternWithoutCount', 'flush'].sort(),
    note: 'getStatus, job-by-intent, journal-by-key, job deletes: control. The boot backfill insert: normal. retryList is the label of '
      + 'bulk retry()\'s list, issued through the selectors (not a direct store call). createGraph and flush take no options.',
  },
  'packages/publisher/src/lift-job-store-selectors.ts': {
    role: 'sites',
    labels: [L('list'), L('reconciliationInventory'), L('findActiveVmPublish'), L('ensureVmPublishIntentIndex'), L('nextAccepted'),
      L('claimCandidates'), L('hasRunnableWork')].sort(),
    storeCalls: ['query', 'query', 'query', 'query', 'query', 'query', 'query'],
  },
  'packages/publisher/src/lift-job-listing-selectors.ts': {
    role: 'sites',
    labels: [L('listPage'), L('stats')].sort(),
    storeCalls: ['query'],
    note: 'P9a: the bounded page (one query) and the stats COUNT (issued through the shared countByState helper); both keep the caller\'s lane',
  },
  'packages/publisher/src/async-lift-guarded-clear.ts': {
    role: 'sites',
    labels: [L('clear.keys'), L('clear.siblings')].sort(),
    storeCalls: ['query'],
    note: 'P11: bulk clear\'s sibling read, whose label is issued through the selectors by the publisher; #3562: the read of the job\'s stored lifecycle-key triples, its one store call',
  },
  'packages/publisher/src/async-lift-retention-access.ts': {
    role: 'sites',
    labels: [L('retention.siblings')],
    storeCalls: [],
    note: 'P11: retention\'s sibling read inside the claim transaction, issued through the selectors; control',
  },
  'packages/publisher/src/async-lift-retention-scan.ts': {
    role: 'sites',
    labels: [L('retention.scan')],
    storeCalls: ['query', 'query'],
    note: 'P11: the candidate scan (range and tie shapes), outside the claim lock: explicit background lane, no control tag',
  },
  'packages/publisher/src/async-lift-retention.ts': {
    role: 'sites',
    labels: [L('retention.verify'), L('retention.walletLocks')].sort(),
    storeCalls: ['query', 'query', 'flush'].sort(),
    note: 'P11: the verify and wallet-lock reads inside the claim transaction (control); the flush after it takes no options. Deletes go through the job\'s own removal scope (deleteJob, deleteJobRequest)',
  },
  'packages/publisher/src/job-record-atomic-write.ts': {
    role: 'sites',
    labels: [L('writeJob'), L('writeJobRequest')].sort(),
    storeCalls: ['tryReplaceSubjectAndInsertAtomically', 'insert', 'replaceSubjectAtomicallyOrFallback'].sort(),
    note: 'one options object serves the atomic write and the fallback\'s delete and insert',
  },
  'packages/publisher/src/async-lift-wallet-persistence.ts': {
    role: 'sites',
    labels: [L('walletLock.write'), L('walletLock.delete'), L('walletLock.read'), L('walletLock.ownership')].sort(),
    storeCalls: ['replaceSubjectAtomicallyOrFallback', 'deleteByPatternWithoutCount', 'query', 'query'].sort(),
  },
  'packages/publisher/src/async-lift-claim-session.ts': {
    role: 'sites', labels: [L('walletLock.sweep')], storeCalls: ['query'],
  },
  'packages/publisher/src/async-lift-journal-completion.ts': {
    role: 'sites',
    labels: [L('appendJournalEntry'), L('allocateJournalSeq')].sort(),
    storeCalls: ['insert', 'query'].sort(),
  },
  'packages/publisher/src/async-queue-depth.ts': {
    role: 'sites',
    labels: ['publisher.queueUsage.lift', 'publisher.queueUsage.liftJournal'].sort(),
    storeCalls: ['query', 'query'],
    note: 'P1b queue_usage COUNTs, background; the same countByState call also serves the share queue',
  },
  'packages/publisher/src/legacy-raw-lift-import.ts': {
    role: 'offline',
    labels: [],
    storeCalls: ['createGraph', 'deleteByPatternWithoutCount', 'deleteByPatternWithoutCount', 'insert'].sort(),
    note: 'offline migration; absent from the package index and from every runtime path (asserted below)',
  },
  'packages/cli/src/daemon/chain-reset-wipe.ts': {
    role: 'wipe',
    labels: [],
    storeCalls: [],
    note: 'one-shot boot cleanup: a scoped DELETE over the whole urn:dkg:publisher: prefix sent straight to the endpoint, '
      + 'before any queue exists; it is not a queue call and must never ride the control path',
  },
};

const facts = queueFiles();

describe('publisher queue graph references (static)', () => {
  it('finds exactly the declared files', () => {
    expect([...facts.keys()].sort()).toEqual(Object.keys(QUEUE_FILES).sort());
  });

  it.each(Object.entries(QUEUE_FILES))('%s carries exactly its declared labels and store calls', (file, declared) => {
    const found = facts.get(file);
    expect(found, `${file} was not found`).toBeDefined();
    expect([...found!.labels].sort(), `${file} labels`).toEqual([...declared.labels]);
    expect([...found!.storeCalls].sort(), `${file} direct store calls`).toEqual([...declared.storeCalls]);
  });

  it('keeps every queue source label unique to one site', () => {
    expect(sharedLabels(facts)).toEqual([]);
    const all = [...facts.values()].flatMap((entry) => entry.labels);
    expect(new Set(all).size).toBe(all.length);
  });

  it('fails on a label shared by several sites (the check can fail)', () => {
    const twice = new Map([
      ['a.ts', { labels: [L('getStatus'), L('list')] }],
      ['b.ts', { labels: [L('getStatus')] }],
    ]);
    expect(sharedLabels(twice)).toEqual([L('getStatus')]);
    // The same label twice in one file is two sites too.
    expect(sharedLabels(new Map([['c.ts', { labels: [L('writeJob'), L('writeJob')] }]]))).toEqual([L('writeJob')]);
  });

  it('names every labelled site in a tagging row, and every tagging row source at exactly one site', () => {
    const declared = Object.values(QUEUE_FILES).flatMap((file) => file.labels).sort();
    expect(declared).toEqual([...PUBLISHER_ROW_SOURCES.keys()].sort());
  });

  it('scans the whole repository: it sees a queue label in a file that never names a graph IRI', () => {
    // The claim session and the selectors reach their graphs through configured URIs; only their labels find them.
    expect(facts.get('packages/publisher/src/lift-job-store-selectors.ts')!.references).toEqual([]);
    expect(facts.get('packages/publisher/src/async-lift-claim-session.ts')!.references).toEqual([]);
    expect(facts.get('packages/cli/src/daemon/chain-reset-wipe.ts')!.references).toEqual([GRAPH_PREFIX]);
  });

  it('keeps the offline legacy import out of every runtime path', () => {
    const importers = sourceFiles().filter((file) => readFileSync(file, 'utf8').includes('legacy-raw-lift-import'));
    expect(importers).toEqual([]);
  });

  it('keeps the routing-covered method list in step with the storage routing test', () => {
    const routing = readFileSync(join(PACKAGES, 'storage/test/store-control-routing.test.ts'), 'utf8');
    const drivenBy: Readonly<Record<string, RegExp>> = {
      query: /\bs\.query\(/,
      insert: /\bs\.insert\(/,
      delete: /\bs\.delete\(/,
      deleteByPattern: /\bs\.deleteByPattern\(/,
      deleteByPatternWithoutCount: /deleteByPatternWithoutCount\(s,/,
      deleteBySubjectPrefix: /\bs\.deleteBySubjectPrefix\(/,
      replaceSubject: /tryReplaceSubjectAtomically\(s,/,
      replaceSubjectAndInsert: /tryReplaceSubjectAndInsertAtomically\(s,/,
      update: /\bs\.update!?\(/,
      createGraph: /\bs\.createGraph\(/,
      flush: /\bs\.flush\?\.\(/,
    };
    expect(Object.keys(drivenBy).sort()).toEqual([...ROUTING_COVERED_METHODS].sort());
    for (const [method, pattern] of Object.entries(drivenBy)) {
      expect(routing, `P3's routing test no longer drives ${method}`).toMatch(pattern);
    }
  });
});

describe('publisher queue graph references (observed)', () => {
  const STACKS: readonly PublisherStack[] = ['atomic', 'fallback'];

  it('observes every labelled site and every option-less createGraph site in a driven scenario', async () => {
    const calls: RecordedStoreCall[] = [];
    for (const stack of STACKS) {
      // The paging scenario is separate from the workload the AC2 lane trace compares with the base SHA, which has no page read.
      for (const run of [
        await runPublisherWorkload(stack), await runPublisherPagingScenario(stack), await runPublisherFundingScenario(stack),
        await runPublisherRetentionScenario(stack, { mode: 'delete' }),
      ]) {
        expect(auditPublisherCalls(run.calls, { pathOn: true }).violations).toEqual([]);
        calls.push(...run.calls);
      }
    }
    const observed = new Set(calls.map((call) => call.source));
    const declared = Object.values(QUEUE_FILES).flatMap((file) => file.labels);
    expect(declared.filter((label) => !observed.has(label))).toEqual([]);
    // createGraph (no options, no label): matched by method and graph, once per queue graph the publisher creates.
    const created = new Set(calls.filter((call) => call.method === 'createGraph').flatMap((call) => call.graphs));
    expect([...created].sort()).toEqual(['job', 'journal', 'wallet']);
    expect(QUEUE_FILES['packages/publisher/src/async-lift-publisher-impl.ts']!.storeCalls.filter((m) => m === 'createGraph')).toHaveLength(3);
  });

  it('observes the fallback-only site only on the stack without the atomic capabilities', async () => {
    const atomic = await runPublisherWorkload('atomic');
    const fallback = await runPublisherWorkload('fallback');
    expect(atomic.calls.some((call) => call.source === L('writeJobRequest'))).toBe(false);
    expect(fallback.calls.some((call) => call.source === L('writeJobRequest'))).toBe(true);
  });
});
