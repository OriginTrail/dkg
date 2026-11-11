// SPDX-License-Identifier: Apache-2.0

/** How a sampled view query's merged answer differs from its per-asset answer. */
type ViewSemanticsDeltaKind = 'none' | 'copies-removed' | 'rows-added' | 'rows-removed-or-changed';

interface ViewSemanticsDeltaShapeEntry {
  readonly shape: string;
  readonly view: string;
  readonly samples: number;
  readonly kinds: Readonly<Record<ViewSemanticsDeltaKind, number>>;
  readonly lastSampledAt: string;
}

/** One context graph's summary, as `GET /api/query/view-semantics-delta` returns it. */
export interface ViewSemanticsDeltaReportEntry {
  readonly contextGraphId: string;
  readonly since: string;
  readonly samples: number;
  readonly skipped: number;
  /** Sampled queries not compared: values generated during evaluation, or blank nodes their structure cannot tell apart. */
  readonly uncomparable: number;
  readonly kinds: Readonly<Record<ViewSemanticsDeltaKind, number>>;
  readonly shapes: readonly ViewSemanticsDeltaShapeEntry[];
}

export interface ViewSemanticsDeltaReportResponse {
  readonly contextGraphs: readonly ViewSemanticsDeltaReportEntry[];
}

const KIND_LABELS: ReadonlyArray<readonly [ViewSemanticsDeltaKind, string]> = [
  ['none', 'same answer'],
  ['copies-removed', 'only duplicate copies removed'],
  ['rows-added', 'rows added'],
  ['rows-removed-or-changed', 'rows removed or changed'],
];

const percent = (part: number, whole: number) => (whole === 0 ? '0.0%' : `${((100 * part) / whole).toFixed(1)}%`);
const minute = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
const changedRows = (kinds: Readonly<Record<ViewSemanticsDeltaKind, number>>) => kinds['rows-added'] + kinds['rows-removed-or-changed'];

/**
 * The report as text: per context graph, how many sampled view queries would get the same
 * rows with `semantics: "merged"`, how many lose only duplicate copies, and how many get
 * other rows, with the query shapes behind those.
 */
export function formatViewSemanticsDeltaReport(
  response: ViewSemanticsDeltaReportResponse,
  { maxShapes = 10 }: { readonly maxShapes?: number } = {},
): string {
  if (response.contextGraphs.length === 0) {
    return 'No view queries have been sampled yet. Samples are taken from view queries on context graphs whose read graphs are ready.';
  }
  const lines: string[] = ['How sampled view queries would answer with semantics "merged" instead of "per-asset":'];
  for (const graph of response.contextGraphs) {
    lines.push('', `${graph.contextGraphId}: ${graph.samples} sampled since ${minute(graph.since)}`
      + (graph.skipped ? `, ${graph.skipped} skipped (the read graph changed, or a read failed)` : '')
      + (graph.uncomparable ? `, ${graph.uncomparable} not compared (values generated during evaluation, or blank nodes their structure cannot tell apart)` : ''));
    if (graph.samples === 0) {
      lines.push('  No sampled query has been compared yet.');
      continue;
    }
    for (const [kind, label] of KIND_LABELS) {
      lines.push(`  ${label.padEnd(30)} ${String(graph.kinds[kind]).padStart(7)}  ${percent(graph.kinds[kind], graph.samples).padStart(6)}`);
    }
    const changed = changedRows(graph.kinds);
    lines.push(changed === 0
      ? '  Every sampled query gets the same rows merged, at most without duplicate copies.'
      : `  ${changed} of ${graph.samples} sampled queries (${percent(changed, graph.samples)}) would get other rows.`);
    const shapes = graph.shapes.filter(shape => changedRows(shape.kinds) > 0).slice(0, maxShapes);
    if (shapes.length > 0) lines.push('  Query shapes whose rows would change, most first:');
    for (const shape of shapes) {
      const parts = KIND_LABELS.filter(([kind]) => kind === 'rows-added' || kind === 'rows-removed-or-changed')
        .filter(([kind]) => shape.kinds[kind] > 0).map(([kind, label]) => `${label} ${shape.kinds[kind]}`);
      lines.push(`    ${changedRows(shape.kinds)} of ${shape.samples} samples (${parts.join(', ')}), ${shape.view}:`, `      ${shape.shape}`);
    }
  }
  return lines.join('\n');
}
