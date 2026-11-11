// SPDX-License-Identifier: Apache-2.0
import { AsyncResource } from 'node:async_hooks';
import { prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import type { GetView, ViewQuerySemantics } from '@origintrail-official/dkg-core';
import { withDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';
import type { QueryResult } from './query-engine.js';
import { detectSparqlQueryForm } from './sparql-guard.js';

/**
 * How the merged answer of a sampled view query differs from its per-asset answer:
 * - `none`: the same rows, as often;
 * - `copies-removed`: the same rows, some of them fewer times;
 * - `rows-added`: every per-asset row, and more rows or copies (a match across assets, or `ASK` turning true);
 * - `rows-removed-or-changed`: some per-asset row is gone or has another value.
 */
export type ViewSemanticsDeltaKind = 'none' | 'copies-removed' | 'rows-added' | 'rows-removed-or-changed';
export const VIEW_SEMANTICS_DELTA_KINDS: readonly ViewSemanticsDeltaKind[] =
  ['none', 'copies-removed', 'rows-added', 'rows-removed-or-changed'];

/** The `source` of the sampler's own reads; the engine offers none of them for sampling. */
export const VIEW_SEMANTICS_DELTA_SOURCE = 'view-semantics-delta';

const MAX_SHAPE_LENGTH = 400;

/** How often each row of a result occurs: bindings, or a quad's terms, with blank node labels hidden. */
function rowCounts(result: QueryResult): Map<string, number> {
  const blank = (term: string) => (term.startsWith('_:') ? '_:' : term);
  const keys = result.quads?.length
    ? result.quads.map(quad => JSON.stringify([blank(quad.subject), quad.predicate, blank(quad.object)]))
    : result.bindings.map(row => JSON.stringify(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => [name, blank(value)])));
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

/** Classify the difference between the two answers of one query. Row order is ignored. */
export function classifyViewSemanticsDelta(sparql: string, perAsset: QueryResult, merged: QueryResult): ViewSemanticsDeltaKind {
  if (detectSparqlQueryForm(sparql) === 'ASK') {
    const [before, after] = [perAsset, merged].map(result => result.bindings[0]?.result === 'true');
    return before === after ? 'none' : after ? 'rows-added' : 'rows-removed-or-changed';
  }
  const [before, after] = [rowCounts(perAsset), rowCounts(merged)];
  if ([...before.keys()].some(key => !after.has(key))) return 'rows-removed-or-changed';
  if ([...after].some(([key, count]) => count > (before.get(key) ?? 0))) return 'rows-added';
  return [...before].some(([key, count]) => count > (after.get(key) ?? 0)) ? 'copies-removed' : 'none';
}

/**
 * The shape of a query, without its values: IRIs, literals and numbers masked, the local
 * part of prefixed names masked, the prologue left out. Variables and keywords stay.
 */
export function viewQueryShape(sparql: string): string {
  const prepared = prepareSparql(sparql);
  let shape = '';
  let previousEnd = -1;
  for (const token of prepared.tokens.slice(prepared.prologue.endTokenIndex)) {
    let text: string;
    switch (token.kind) {
      case 'iri': text = '<…>'; break;
      case 'string': text = '"…"'; break;
      case 'number': text = '0'; break;
      case 'prefixed-name': text = `${token.logicalValue.slice(0, token.logicalValue.indexOf(':') + 1)}…`; break;
      default: text = token.logicalValue;
    }
    shape += (shape && token.start !== previousEnd ? ' ' : '') + text;
    previousEnd = token.end;
    if (shape.length > MAX_SHAPE_LENGTH) return `${shape.slice(0, MAX_SHAPE_LENGTH)}…`;
  }
  return shape;
}

/** A view query offered for sampling, after it was answered. */
export interface ViewSemanticsDeltaSample {
  readonly contextGraphId: string;
  readonly view: GetView;
  readonly sparql: string;
  /** Answers the query again with these semantics, as background work, until the signal aborts. */
  readonly run: (semantics: ViewQuerySemantics, signal: AbortSignal) => Promise<QueryResult>;
  /** Whether the read graph is still ready at the generation it had when the sample was offered. */
  readonly isCurrent: () => boolean;
  /** Runs both reads under the read graph's write lock, when the node has one. */
  readonly withWriteLock?: <T>(work: () => Promise<T>) => Promise<T>;
}

type KindCounts = Record<ViewSemanticsDeltaKind, number>;

export interface ViewSemanticsDeltaShape {
  readonly shape: string;
  readonly view: GetView;
  readonly samples: number;
  readonly kinds: Readonly<KindCounts>;
  readonly lastSampledAt: string;
}

/** What one context graph's sampled view queries would have answered merged. Shapes only, never values. */
export interface ViewSemanticsDeltaSummary {
  readonly contextGraphId: string;
  readonly since: string;
  readonly samples: number;
  /** Samples whose read graph changed while they ran, or whose reads failed. */
  readonly skipped: number;
  readonly kinds: Readonly<KindCounts>;
  /** Query shapes, those with the most changed answers first. */
  readonly shapes: readonly ViewSemanticsDeltaShape[];
}

export interface ViewSemanticsDeltaSamplerOptions {
  /** The share of offered queries that are sampled, from 0 to 1. Default 0.05. */
  readonly sampleRate?: number;
  /** Samples waiting at most; an offer beyond it is dropped. Default 8. */
  readonly maxQueued?: number;
  /** Query shapes kept per context graph; the least recently sampled one goes first. Default 50. */
  readonly maxShapes?: number;
  /** Context graphs kept; the least recently sampled one goes first. Default 500. */
  readonly maxContextGraphs?: number;
  /**
   * Milliseconds a sample may take, from waiting for the write lock to its second answer; a
   * slower one is aborted and skipped, so it holds the lock no longer. Default 5000.
   */
  readonly maxSampleMs?: number;
  /** Counts each classified sample, for example in the node's metrics. A failure here is ignored. */
  readonly onDelta?: (kind: ViewSemanticsDeltaKind) => void;
  readonly random?: () => number;
  readonly now?: () => Date;
}

interface MutableShape { shape: string; view: GetView; samples: number; kinds: KindCounts; lastSampledAt: string }
interface MutableSummary { contextGraphId: string; since: string; lastSampledAt: string; samples: number; skipped: number; kinds: KindCounts; shapes: Map<string, MutableShape> }

const noKinds = (): KindCounts => ({ 'none': 0, 'copies-removed': 0, 'rows-added': 0, 'rows-removed-or-changed': 0 });
const changed = (kinds: KindCounts) => kinds['rows-added'] + kinds['rows-removed-or-changed'];

/**
 * Samples answered view queries that could be answered merged, runs each both ways in the
 * background, one at a time, and keeps a summary per context graph. It is information for the
 * decision to answer a context graph merged by default, not a check of correctness: the two
 * semantics differ on purpose.
 */
export class ViewSemanticsDeltaSampler {
  private readonly queue: ViewSemanticsDeltaSample[] = [];
  private readonly summaries = new Map<string, MutableSummary>();
  private draining: Promise<void> | undefined;
  private closed = false;
  private readonly sampleRate: number;
  private readonly maxQueued: number;
  private readonly maxShapes: number;
  private readonly maxContextGraphs: number;
  private readonly maxSampleMs: number;
  private readonly random: () => number;
  private readonly now: () => Date;
  /** Samples run in the context the sampler was made in, never in that of the query that offered them. */
  private readonly scope = new AsyncResource('view-semantics-delta');

  constructor(private readonly options: ViewSemanticsDeltaSamplerOptions = {}) {
    this.sampleRate = options.sampleRate ?? 0.05;
    this.maxQueued = options.maxQueued ?? 8;
    this.maxShapes = options.maxShapes ?? 50;
    this.maxContextGraphs = options.maxContextGraphs ?? 500;
    this.maxSampleMs = options.maxSampleMs ?? 5000;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
  }

  /** Take a sample of this query, at the sample rate, while there is room. Never throws. */
  offer(sample: ViewSemanticsDeltaSample): void {
    if (this.closed || this.queue.length >= this.maxQueued || this.random() >= this.sampleRate) return;
    this.queue.push(sample);
    // A sample never fails the drain, so nothing here is left unhandled.
    this.draining ??= this.scope.runInAsyncScope(() => this.drain()).catch(() => undefined).finally(() => { this.draining = undefined; });
  }

  /** Resolves when every queued sample has been measured. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  /** Stop sampling and drop the waiting samples. */
  close(): void {
    this.closed = true;
    this.queue.length = 0;
  }

  /** The summaries of these context graphs, or of all, the most sampled first. */
  report(contextGraphIds?: readonly string[]): ViewSemanticsDeltaSummary[] {
    const wanted = contextGraphIds === undefined ? undefined : new Set(contextGraphIds);
    return [...this.summaries.values()]
      .filter(summary => wanted === undefined || wanted.has(summary.contextGraphId))
      .sort((a, b) => b.samples - a.samples)
      .map(summary => ({
        contextGraphId: summary.contextGraphId, since: summary.since, samples: summary.samples,
        skipped: summary.skipped, kinds: { ...summary.kinds },
        shapes: [...summary.shapes.values()]
          .sort((a, b) => changed(b.kinds) - changed(a.kinds) || b.samples - a.samples)
          .map(shape => ({ ...shape, kinds: { ...shape.kinds } })),
      }));
  }

  private async drain(): Promise<void> {
    // Foreground work goes first: the answer the sample was offered with, and other work between samples.
    await yieldToForeground();
    while (!this.closed && this.queue.length > 0) {
      const sample = this.queue.shift()!;
      const measured = await this.measure(sample).catch(() => undefined);
      const summary = this.summaryOf(sample.contextGraphId);
      if (measured) this.record(summary, sample.view, measured.shape, measured.kind);
      else summary.skipped += 1;
      await yieldToForeground();
    }
  }

  /** Both answers and their difference, or `undefined` when the read graph changed meanwhile. */
  private async measure(sample: ViewSemanticsDeltaSample): Promise<{ kind: ViewSemanticsDeltaKind; shape: string } | undefined> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('The sample ran past its deadline')), this.maxSampleMs);
    try {
      const both = async () => {
        // Past the deadline, waiting for the lock included, a sample does not read; one that read past it is skipped.
        deadline.signal.throwIfAborted();
        const perAsset = await sample.run('per-asset', deadline.signal);
        const merged = await sample.run('merged', deadline.signal);
        deadline.signal.throwIfAborted();
        return { perAsset, merged, current: sample.isCurrent() };
      };
      const answers = await withDefaultStoreWorkPriority('background', () => (sample.withWriteLock ? sample.withWriteLock(both) : both()));
      if (!answers.current) return undefined;
      return { kind: classifyViewSemanticsDelta(sample.sparql, answers.perAsset, answers.merged), shape: viewQueryShape(sample.sparql) };
    } finally {
      clearTimeout(timer);
    }
  }

  private record(summary: MutableSummary, view: GetView, shapeText: string, kind: ViewSemanticsDeltaKind): void {
    const at = this.now().toISOString();
    summary.samples += 1;
    summary.kinds[kind] += 1;
    summary.lastSampledAt = at;
    const key = `${view} ${shapeText}`;
    let shape = summary.shapes.get(key);
    if (!shape) {
      if (summary.shapes.size >= this.maxShapes) summary.shapes.delete(leastRecentKey(summary.shapes));
      shape = { shape: shapeText, view, samples: 0, kinds: noKinds(), lastSampledAt: at };
      summary.shapes.set(key, shape);
    }
    shape.samples += 1;
    shape.kinds[kind] += 1;
    shape.lastSampledAt = at;
    try {
      this.options.onDelta?.(kind);
    } catch {
      // Counting elsewhere is best effort; the summary above already holds the sample.
    }
  }

  private summaryOf(contextGraphId: string): MutableSummary {
    let summary = this.summaries.get(contextGraphId);
    if (!summary) {
      if (this.summaries.size >= this.maxContextGraphs) this.summaries.delete(leastRecentKey(this.summaries));
      const at = this.now().toISOString();
      summary = { contextGraphId, since: at, lastSampledAt: at, samples: 0, skipped: 0, kinds: noKinds(), shapes: new Map() };
      this.summaries.set(contextGraphId, summary);
    }
    return summary;
  }
}

const yieldToForeground = () => new Promise<void>(resolve => setImmediate(resolve));

/** The key of the entry sampled longest ago. */
function leastRecentKey(entries: ReadonlyMap<string, { readonly lastSampledAt: string }>): string {
  let oldest: [string, { readonly lastSampledAt: string }] | undefined;
  for (const entry of entries) if (!oldest || entry[1].lastSampledAt < oldest[1].lastSampledAt) oldest = entry;
  return oldest?.[0] ?? '';
}
