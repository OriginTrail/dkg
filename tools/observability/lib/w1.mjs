// W1 sync-measurement decision queries — DATA ONLY, the one module that maps
// the W1 instrument contract (I1–I9, declared in
// packages/core/src/telemetry-api.ts) onto runnable PromQL. Two artifacts
// render from THIS catalog:
//
//   w1/w1-queries.md   operator-facing decision report (plan §7.2 / §7.3)
//   w1/w1-rules.yaml   the SAME expressions as a Prometheus rule group, so
//                      `promtool check rules` really PARSES every one of them
//
// The rule fixture is never a hand-maintained second copy: both files render
// from the same `expr` strings and verify-w1-render.mjs asserts the two sets
// are equal. Node identity comes from the shared profile model
// (lib/profile.mjs), so --prom-node-label reprofiles the W1 queries exactly as
// it reprofiles the dashboards — W1 does not fork the node-identity contract.

// ── Prometheus spelling: derived, never assumed ───────────────────────────
// The same instrument reaches a Prometheus-compatible store under two
// spellings depending on the ingest route:
//   native      dots -> underscores only (VictoriaMetrics OTLP ingest default)
//   translated  + unit suffix and + `_total` on monotonic counters (the OTel
//               Prometheus naming convention: VictoriaMetrics
//               -opentelemetry.usePrometheusNaming, the collector's
//               prometheusremotewrite exporter, Prometheus' own OTLP receiver)
// A selector naming only one of them can come back EMPTY on a live node, which
// is indistinguishable from "no traffic" — the failure mode that silently
// invalidates a measurement window. Every selector below therefore tolerates
// both, in the shape the metrics dashboard already uses for
// `dkg_publish_duration(_milliseconds)?_bucket`. Both spellings are DERIVED
// from the declared name/kind/unit; neither is typed out by hand.
const UNIT_SUFFIX = { '1': '', By: 'bytes', ms: 'milliseconds' };

const promParts = (inst) => {
  const base = inst.name.replaceAll('.', '_');
  const unit = UNIT_SUFFIX[inst.unit];
  if (unit === undefined) throw new Error(`w1: no Prometheus unit suffix known for unit '${inst.unit}' (${inst.name}) — add it to UNIT_SUFFIX consciously`);
  // The unit word is appended ONLY when the normalized name does not already
  // carry it as a token — the OTel Prometheus/OpenMetrics compatibility rule,
  // and what `prometheus/otlptranslator` implements. A counter already named
  // `…request_bytes` with unit `By` therefore translates to
  // `…_request_bytes_total`, NOT the doubled `…_request_bytes_bytes_total`,
  // which no ingest route emits. Getting this wrong is not a cosmetic naming
  // slip: the alternation then covers a form that never exists while MISSING
  // the real one, so the byte gates read empty on a standard ingest path and
  // §7.3 reports `inconclusive` forever with nothing pointing at the cause.
  //
  // Token containment rather than endsWith: it is the faithful rule and also
  // covers a future name like `dkg.bytes_received.foo` (today the two readings
  // agree on every instrument here). The comparison is against the mapped unit
  // WORD, so `duration_ms` — tokens […, duration, ms] — does not contain
  // `milliseconds` and correctly still receives the suffix.
  const withUnit = unit && !base.split('_').includes(unit) ? `${base}_${unit}` : base;
  // `_total` is appended to monotonic counters unless the name already ends
  // in it (dkg.sync.attempt.total -> dkg_sync_attempt_total, never
  // dkg_sync_attempt_total_total), which is why some instruments have exactly
  // ONE spelling and need no alternation.
  const decorated = inst.kind === 'counter' && !withUnit.endsWith('_total') ? `${withUnit}_total` : withUnit;
  return { base, decoration: decorated.slice(base.length) };
};

/** Every Prometheus series name this instrument can arrive under, for the
 *  given histogram series suffix ('' for counters/gauges). */
const promSpellings = (inst, series = '') => {
  const { base, decoration } = promParts(inst);
  return decoration ? [`${base}${series}`, `${base}${decoration}${series}`] : [`${base}${series}`];
};

/** A vector selector reading `inst`, tolerant of both spellings: a plain name
 *  when the two coincide (what the repo already writes for
 *  dkg_sync_request_total), a `__name__` alternation when they differ. */
const selector = (inst, { series = '', matchers }) => {
  const { base, decoration } = promParts(inst);
  const rest = matchers.filter(Boolean).join(', ');
  return decoration
    ? `{__name__=~"${base}(${decoration})?${series}"${rest ? `, ${rest}` : ''}}`
    : `${base}${series}{${rest}}`;
};

// ── the W1 instrument contract (plan §5) ──────────────────────────────────
// Transcribed from the buildMetrics() declarations; `unit` and `kind` are the
// only inputs the spelling derivation needs, so a unit change in core that is
// not mirrored here shows up as an empty query, which verify-w1-render.mjs
// turns into a hard failure rather than a silent zero.
const W1_INSTRUMENTS = [
  { id: 'I1', name: 'dkg.sync.attempt.total', kind: 'counter', unit: '1',
    labels: ['transport', 'plane', 'phase', 'source', 'outcome'],
    what: 'Physically invoked sync sends, one point per invoked send()' },
  { id: 'I2', name: 'dkg.sync.attempt.request_bytes', kind: 'counter', unit: 'By',
    labels: ['transport', 'plane', 'phase', 'source'],
    what: 'Encoded request payload bytes at the router boundary' },
  { id: 'I3', name: 'dkg.sync.attempt.response_bytes', kind: 'counter', unit: 'By',
    labels: ['transport', 'plane', 'phase', 'source', 'outcome'],
    what: 'Encoded response payload bytes at the router boundary' },
  { id: 'I4', name: 'dkg.sync.operation.duration_ms', kind: 'histogram', unit: 'ms',
    labels: ['lane', 'source', 'outcome'],
    what: 'Active occupancy of one completed logical sync operation (sum = strain, count = denominator)' },
  { id: 'I5', name: 'dkg.sync.operation.rejected_total', kind: 'counter', unit: '1',
    labels: ['lane', 'source', 'reason'],
    what: 'Operations rejected before starting — never a 0 ms duration sample' },
  { id: 'I6', name: 'dkg.sync.singleflight.joins_total', kind: 'counter', unit: '1',
    labels: ['scope', 'owner_source', 'joiner_source'],
    what: 'Coalescing joins; a cross-family join makes the window inconclusive' },
  { id: 'I7', name: 'dkg.context_graph.catchup.requests_total', kind: 'counter', unit: '1',
    labels: ['result', 'include_shared_memory'],
    what: 'Catch-up subscribe requests by route result (N:1 with jobs)' },
  { id: 'I8', name: 'dkg.context_graph.catchup.jobs_total', kind: 'counter', unit: '1',
    labels: ['status', 'admission'],
    what: 'Catch-up jobs by terminal status and admission path (exactly once per jobId)' },
  { id: 'I9', name: 'dkg.context_graph.catchup.job_duration_ms', kind: 'histogram', unit: 'ms',
    labels: ['admission'],
    what: 'Walk catch-up job wall-time, monotonic clock' },
];

// Pre-existing instruments used only for the corroborating-pressure row of
// §7.2 — they are NOT part of the W1 inventory, but they go through the same
// spelling derivation so the report cannot ship a one-spelling selector.
const W1_CORROBORATING_INSTRUMENTS = [
  { id: 'P1', name: 'dkg.sync.scheduler.queue_wait_ms', kind: 'histogram', unit: 'ms',
    labels: ['scheduler', 'lane', 'priority_class'], what: 'Scheduler queue wait' },
  { id: 'P2', name: 'dkg.backpressure.oldest_queued_age_ms', kind: 'gauge', unit: 'ms',
    labels: ['scheduler', 'lane'], what: 'Age of the oldest queued scheduler item' },
];

const I = Object.fromEntries([...W1_INSTRUMENTS, ...W1_CORROBORATING_INSTRUMENTS].map((x) => [x.id, x]));

// ── source families (plan §5.5) ───────────────────────────────────────────
// SYNC_ADMISSION_SOURCES has exactly eight members (packages/agent/src/sync/
// policy.ts:38-56) and the classification below is exhaustive over them. The
// `invalidating` family is expressed as the NEGATION of the seven classified
// sources, so `unspecified` AND any future member added to the union without
// updating this table both land in it — a new source cannot silently vanish
// from the accounting.
//
// `control-plane` is the eighth member and is `excluded`. Curator meta refresh
// fetches `plane=durable`/`phase=meta` — inside §7.2's decision filter — from
// outside any admission boundary, so before it was named every such fetch
// clamped to `unspecified` and invalidated the window on any node that had
// joined a private CG. Naming it keeps §7.3's zero-`unspecified` gate reachable
// rather than weakening the gate.
//
// NOTE the coupling this creates: a member added to the union but NOT to a
// family here lands in `invalidating` by construction and invalidates every
// window. That is the correct fail-loud direction — it is why the omission is
// impossible to miss — but it does mean the union and this table must move
// together, in the same PR.
const W1_SOURCE_FAMILIES = [
  { id: 'foreground', title: 'user-triggered catch-up', role: 'eligible', sources: ['catchup-foreground'] },
  { id: 'recurring', title: 'recurring peer contact', role: 'eligible', sources: ['on-connect', 'reconcile'] },
  { id: 'excluded', title: 'excluded / reported separately', role: 'excluded', sources: ['catchup-background', 'vm-recovery', 'swm-recovery', 'control-plane'] },
  { id: 'invalidating', title: 'invalidates the window', role: 'invalidating', sources: ['unspecified'] },
];

/** The seven sources the classification names explicitly; the invalidating
 *  family is everything else. */
const W1_CLASSIFIED_SOURCES = W1_SOURCE_FAMILIES
  .filter((f) => f.role !== 'invalidating')
  .flatMap((f) => f.sources);

/** The eligible (foreground + recurring) sources — the materiality numerator. */
const W1_ELIGIBLE_SOURCES = W1_SOURCE_FAMILIES
  .filter((f) => f.role === 'eligible')
  .flatMap((f) => f.sources);

const inFamily = (key, family) => (family.role === 'invalidating'
  ? `${key}!~"${W1_CLASSIFIED_SOURCES.join('|')}"`
  : `${key}=~"${family.sources.join('|')}"`);
const notInFamily = (key, family) => (family.role === 'invalidating'
  ? `${key}=~"${W1_CLASSIFIED_SOURCES.join('|')}"`
  : `${key}!~"${family.sources.join('|')}"`);

const SOURCE_ELIGIBLE = `source=~"${W1_ELIGIBLE_SOURCES.join('|')}"`;
const SOURCE_INVALIDATING = `source!~"${W1_CLASSIFIED_SOURCES.join('|')}"`;

// ── runnable filters (plan §7.2) ──────────────────────────────────────────
// Stated as predicates, not prose. `snapshot` and `catalog` are deliberately
// excluded from the attempt planes; the I4/I5 lane filter keeps the requester
// lanes only (responder and pre-authorization lanes are not sync cost).
const DURABLE_ATTEMPT_FILTER = ['plane="durable"', 'phase=~"data|meta|delta"'];
const REQUESTER_LANE_FILTER = ['lane=~"durable|changelog"'];

// ── observation windows (plan §7) ─────────────────────────────────────────
const W1_WINDOWS = [
  { id: 'stable', title: 'Stable topology', range: '2h', minimum: '≥ 2 h, no induced churn' },
  { id: 'reconnect', title: 'Reconnect-heavy', range: '1h', minimum: '≥ 1 h, induced peer churn' },
];

// ── decision rule (plan §7.3), rendered beside the queries it gates ───────
const W1_EVIDENCE_GATES = [
  ['completed_durable_operations', '≥ 200', 'I4 count — completed durable/changelog operations'],
  ['attributed_durable_payload_bytes', '≥ 50 MB', 'I2 + I3 over the durable filter'],
  ['cross_family_singleflight_joins', '= 0', 'I6 — any cross-family join invalidates the window'],
  ['invalidating_source_samples', '= 0', 'no `unspecified` / unclassified source sample'],
  ['counter_resets', '= 0', 'no counter reset inside the window'],
  ['export_coverage_min_samples', 'window ÷ scrape interval', 'no export gap'],
];
const W1_MATERIALITY = [
  ['eligible_active_share_of_all_source', '≥ 0.30', 'strain floor — eligible active ms as a share of ALL-SOURCE durable active ms'],
  ['<family>_share_of_eligible_durable_bytes', '≥ 0.60', 'winning family, bytes axis'],
  ['<family>_share_of_eligible_durable_active_ms', '≥ 0.60', 'winning family, strain axis'],
  ['<family>_durable_bytes_per_hour', '≥ 25 MB/h', 'absolute floor, bytes axis'],
  ['<family>_durable_active_ms_per_hour', '≥ 90 000 ms/h', 'absolute floor, strain axis (90 s active/hour)'],
];

// ── query catalog ─────────────────────────────────────────────────────────
const buildWindowQueries = ({ nodeProfile, range }) => {
  const SEL = nodeProfile.selector;
  const W = `[${range}]`;
  const DUR = DURABLE_ATTEMPT_FILTER;
  const LANE = REQUESTER_LANE_FILTER;

  // Per-instrument selector shorthands. `src` is a source matcher string, or
  // null for the ALL-SOURCE form — the denominator the two-axis materiality
  // rule needs. Omitting it makes the strain floor uncomputable, so the
  // no-family-filter variants below are load-bearing, not decoration.
  const i1 = (src) => selector(I.I1, { matchers: [...DUR, src, SEL] });
  const i2 = (src) => selector(I.I2, { matchers: [...DUR, src, SEL] });
  const i3 = (src) => selector(I.I3, { matchers: [...DUR, src, SEL] });
  const i4sum = (src) => selector(I.I4, { series: '_sum', matchers: [...LANE, src, SEL] });
  const i4count = (src) => selector(I.I4, { series: '_count', matchers: [...LANE, src, SEL] });
  const i5 = (src) => selector(I.I5, { matchers: [...LANE, src, SEL] });

  // `a + b` is EMPTY in PromQL whenever either operand is empty. Every term
  // below is an UNLABELLED aggregate (`sum(...)` with no `by`), so `or
  // vector(0)` substitutes a genuine zero without inventing label sets.
  const zeroFilled = (term) => `(${term} or vector(0))`;

  // Both byte legs are zero-filled INDEPENDENTLY. An absent I3 series is not
  // "cannot compute" — it is a meaningful zero: §6.2 records I3 only when the
  // send RESOLVED, so a window in which every send timed out has real I2 bytes
  // and no I3 series at all. Adding them un-filled returned empty, which made
  // the byte gates read `inconclusive` exactly when sync was failing — the one
  // window an operator most needs the number for, and the one where the answer
  // is perfectly well known (it is the I2 sum).
  //
  // This cannot mask a dead pipeline: "nothing exported at all" is caught by
  // the separate `completed_durable_operations` and `export_coverage_min_samples`
  // gates, which is what makes zero-filling safe here rather than merely
  // convenient.
  const bytesRate = (src) => `(${zeroFilled(`sum(rate(${i2(src)}${W}))`)} + ${zeroFilled(`sum(rate(${i3(src)}${W}))`)})`;
  const bytesPerHour = (src) => `3600 * ${bytesRate(src)}`;
  const bytesInWindow = (src) => `${zeroFilled(`sum(increase(${i2(src)}${W}))`)} + ${zeroFilled(`sum(increase(${i3(src)}${W}))`)}`;
  const attemptsPerHour = (src) => `3600 * sum(rate(${i1(src)}${W}))`;
  const activeMsRate = (src) => `sum(rate(${i4sum(src)}${W}))`;
  const activeMsPerHour = (src) => `3600 * ${activeMsRate(src)}`;
  const opsInWindow = (src) => `sum(increase(${i4count(src)}${W}))`;

  // (`zeroFilled` is defined above, next to the byte legs that motivated it.)

  const gates = [
    { id: 'completed_durable_operations', title: 'Completed durable/changelog sync operations (I4 count)',
      purpose: 'Evidence gate ≥ 200. I4\'s count DEFINES "completed logical sync operation" and is the denominator every share below divides by.',
      expr: opsInWindow(null) },
    { id: 'attributed_durable_payload_bytes', title: 'Attributed durable payload bytes (I2 + I3)',
      purpose: 'Evidence gate ≥ 50 MB. Encoded application-protocol payload at the router boundary — never called wire bandwidth.',
      expr: bytesInWindow(null) },
    { id: 'cross_family_singleflight_joins', title: 'Cross-family single-flight joins (I6)',
      purpose: 'Evidence gate = 0. PromQL cannot compare two labels, so the predicate is enumerated per family: owner in F and joiner not in F. Each sample\'s owner is in exactly one family, so the terms partition and cannot double-count. Each term is zero-filled so an absent family cannot blank out a real join in another.',
      expr: W1_SOURCE_FAMILIES
        .map((f) => zeroFilled(`sum(increase(${selector(I.I6, { matchers: [inFamily('owner_source', f), notInFamily('joiner_source', f), SEL] })}${W}))`))
        .join(' + ') },
    // MUTATION-MATRIX REQUIREMENT — partial overlap, NOT subsumption. The
    // cross-family term above also fires on an unlisted source, but only when a
    // join occurs; this gate fires whether or not one does. So the scenario
    // that exercises this gate must carry an unlisted-source sample with **no
    // join**, or the join term masks a mutant that deletes this gate. Neither
    // may be removed on the grounds that "the other one covers it" — a
    // join-free unlisted source would then go unreported entirely.
    { id: 'invalidating_source_samples', title: 'Samples carrying an unclassified source',
      purpose: 'Evidence gate = 0. Negation of the seven classified sources, so `unspecified` and any future unlisted member both surface here instead of vanishing. Terms are zero-filled: a healthy node has no series on any of the three, and an unfilled sum would go blank and hide a sample on one of them.',
      expr: [zeroFilled(`sum(increase(${i1(SOURCE_INVALIDATING)}${W}))`),
        zeroFilled(`sum(increase(${i4count(SOURCE_INVALIDATING)}${W}))`),
        zeroFilled(`sum(increase(${i5(SOURCE_INVALIDATING)}${W}))`)].join(' + ') },
    { id: 'counter_resets', title: 'Counter resets inside the window',
      purpose: 'Evidence gate = 0. A process restart resets every counter this window reads; `increase()` would paper over it.',
      expr: `max(resets(${i1(null)}${W}))` },
    { id: 'export_coverage_min_samples', title: 'Export coverage — fewest samples on any read series',
      purpose: 'Evidence gate: compare against window ÷ scrape interval. A materially smaller value is an export gap and invalidates the window.',
      expr: `min(count_over_time(${i1(null)}${W}))` },
  ];

  // ALL-SOURCE denominators: no family filter at all. The strain floor (§7.3)
  // divides eligible active ms by these, so a report without them cannot
  // decide anything — a family can own 60 % of a tiny eligible denominator
  // while background and recovery dominate real occupancy.
  const denominators = [
    { id: 'all_source_durable_active_ms_per_hour', title: 'ALL-SOURCE durable active ms/hour (I4 sum, no family filter)',
      purpose: 'Strain denominator. Source-attributed active wall-clock occupancy — occupancy, not CPU.',
      expr: activeMsPerHour(null) },
    { id: 'all_source_durable_bytes_per_hour', title: 'ALL-SOURCE durable bytes/hour (I2 + I3, no family filter)',
      purpose: 'Volume denominator.', expr: bytesPerHour(null) },
    { id: 'all_source_durable_attempts_per_hour', title: 'ALL-SOURCE durable attempts/hour (I1, no family filter)',
      purpose: 'Send-attempt denominator.', expr: attemptsPerHour(null) },
    { id: 'eligible_durable_active_ms_per_hour', title: 'Eligible (foreground + recurring) durable active ms/hour',
      purpose: 'Strain numerator for the 30 % floor.', expr: activeMsPerHour(SOURCE_ELIGIBLE) },
    { id: 'eligible_durable_bytes_per_hour', title: 'Eligible (foreground + recurring) durable bytes/hour',
      purpose: 'Volume numerator for the per-family shares.', expr: bytesPerHour(SOURCE_ELIGIBLE) },
    { id: 'eligible_durable_operations', title: 'Eligible completed durable operations (I4 count)',
      purpose: 'Eligible share of the operation denominator.', expr: opsInWindow(SOURCE_ELIGIBLE) },
    { id: 'eligible_active_share_of_all_source', title: 'Strain floor — eligible active ms ÷ ALL-SOURCE active ms',
      purpose: 'Materiality gate ≥ 0.30. An empty result means a zero denominator, which is `inconclusive`, never a win — so this is a plain division with no clamp.',
      expr: `${activeMsRate(SOURCE_ELIGIBLE)} / ${activeMsRate(null)}` },
  ];

  const perFamily = W1_SOURCE_FAMILIES
    .filter((f) => f.role !== 'invalidating')
    .flatMap((f) => {
      const src = inFamily('source', f);
      const rows = [
        { id: `${f.id}_durable_bytes_per_hour`, title: `${f.title} — durable bytes/hour (I2 + I3)`,
          purpose: `Sources: ${f.sources.join(', ')}. Absolute floor for a winning family is ≥ 25 MB/h.`,
          expr: bytesPerHour(src) },
        { id: `${f.id}_durable_attempts_per_hour`, title: `${f.title} — durable attempts/hour (I1)`,
          purpose: `Sources: ${f.sources.join(', ')}.`, expr: attemptsPerHour(src) },
        { id: `${f.id}_durable_active_ms_per_hour`, title: `${f.title} — durable active ms/hour (I4 sum)`,
          purpose: `Sources: ${f.sources.join(', ')}. Absolute floor for a winning family is ≥ 90 000 ms/h.`,
          expr: activeMsPerHour(src) },
      ];
      if (f.role !== 'eligible') return rows;
      return [...rows,
        { id: `${f.id}_share_of_eligible_durable_bytes`, title: `${f.title} — share of eligible durable bytes`,
          purpose: 'Materiality gate ≥ 0.60 (volume axis).', expr: `${bytesRate(src)} / ${bytesRate(SOURCE_ELIGIBLE)}` },
        { id: `${f.id}_share_of_eligible_durable_active_ms`, title: `${f.title} — share of eligible durable active ms`,
          purpose: 'Materiality gate ≥ 0.60 (strain axis). If the two axes rank different families the window is `inconclusive`.',
          expr: `${activeMsRate(src)} / ${activeMsRate(SOURCE_ELIGIBLE)}` },
      ];
    });

  const pressure = [
    { id: 'rejected_operations_by_reason', title: 'Operations rejected before starting (I5)',
      purpose: 'Never-started work is never a 0 ms I4 sample — it lands here, by bounded reason.',
      expr: `sum by (reason) (increase(${i5(null)}${W}))` },
    { id: 'singleflight_joins_by_scope', title: 'Single-flight joins by scope (I6)',
      purpose: 'Context for the cross-family gate: within-family joins are recorded and tolerated.',
      expr: `sum by (scope) (increase(${selector(I.I6, { matchers: [SEL] })}${W}))` },
    { id: 'sync_scheduler_queue_wait_p95_ms', title: 'Corroborating pressure — sync scheduler queue wait p95',
      purpose: 'Grouped by lane rather than filtered: the scheduler lane union is wider than the I4/I5 requester lanes, and a filter here could silently drop a lane.',
      expr: `histogram_quantile(0.95, sum by (le, lane) (rate(${selector(I.P1, { series: '_bucket', matchers: ['scheduler="sync-global"', SEL] })}${W})))` },
    { id: 'sync_scheduler_oldest_queued_age_ms', title: 'Corroborating pressure — oldest queued item age',
      purpose: 'Instantaneous snapshot gauge; corroborates the window, it does not gate it.',
      expr: `max by (lane) (${selector(I.P2, { matchers: ['scheduler="sync-global"', SEL] })})` },
  ];

  const catchup = [
    { id: 'catchup_requests_by_result', title: 'Catch-up subscribe requests by route result (I7)',
      purpose: 'Requests are N:1 with jobs — dedupe and replay return without minting a job.',
      expr: `sum by (result) (increase(${selector(I.I7, { matchers: [SEL] })}${W}))` },
    { id: 'catchup_jobs_by_status_and_admission', title: 'Catch-up jobs by terminal status and admission path (I8)',
      purpose: 'Exactly one point per unique jobId; `admission` separates walk from synthetic.',
      expr: `sum by (status, admission) (increase(${selector(I.I8, { matchers: [SEL] })}${W}))` },
    { id: 'catchup_walk_job_duration_p95_ms', title: 'Walk catch-up job duration p95 (I9)',
      purpose: 'Walk jobs only. The bucket set reaches ~30 min because measured jobs ran 305 s and 382 s.',
      expr: `histogram_quantile(0.95, sum by (le, admission) (rate(${selector(I.I9, { series: '_bucket', matchers: [SEL] })}${W})))` },
  ];

  return [
    { section: 'Evidence gates (§7.3) — any unmet ⇒ inconclusive', queries: gates },
    { section: 'Denominators and the strain floor (§7.3)', queries: denominators },
    { section: 'Per-family cost (§7.2)', queries: perFamily },
    { section: 'Corroborating pressure (§7.2)', queries: pressure },
    { section: 'Catch-up request/job accounting (I7–I9)', queries: catchup },
  ];
};

// ── rendering ─────────────────────────────────────────────────────────────
const GENERATED_MD = `<!-- GENERATED FILE — do not edit. Source: tools/observability/lib/w1.mjs
     Regenerate with: node tools/observability/generate-observability.mjs
     Verified by: node tools/observability/verify-w1-render.mjs tools/observability
     Parsed by:   promtool check rules tools/observability/w1/w1-rules.yaml -->`;

const mdCell = (t) => String(t).replaceAll('|', '\\|');

const instrumentTable = (instruments) => [
  '| # | Instrument (OTLP) | Type | Unit | Prometheus spellings | Labels |',
  '|---|---|---|---|---|---|',
  ...instruments.map((inst) => {
    // Histogram series suffixes are listed once instead of spelled into every
    // row: the two SPELLINGS are the contract, the suffix set is orthogonal.
    const cell = promSpellings(inst).map((s) => `\`${s}\``).join('<br>')
      + (inst.kind === 'histogram' ? '<br>+ `_bucket` / `_sum` / `_count`' : '');
    return `| ${inst.id} | \`${inst.name}\` | ${inst.kind} | \`${inst.unit}\` | ${cell} | ${mdCell(inst.labels.map((l) => `\`${l}\``).join(', '))} |`;
  }),
].join('\n');

const familyTable = () => [
  '| Family | Classification | Sources | Runnable predicate |',
  '|---|---|---|---|',
  ...W1_SOURCE_FAMILIES.map((f) =>
    `| \`${f.id}\` | ${f.title} | ${f.sources.map((s) => `\`${s}\``).join(', ')} | ${mdCell(`\`${inFamily('source', f)}\``)} |`),
].join('\n');

const gateTable = (rows) => [
  '| Query | Threshold | Meaning |',
  '|---|---|---|',
  ...rows.map(([id, threshold, meaning]) => `| \`${id}\` | \`${threshold}\` | ${mdCell(meaning)} |`),
].join('\n');

const renderReport = ({ nodeProfile, windows }) => `${GENERATED_MD}

# W1 — sync measurement decision queries

Attributes sync cost to its trigger on two axes — **network volume** (encoded
payload bytes and actual send attempts) and **node strain** (source-attributed
active wall-clock occupancy inside the admitted work boundary). If the two axes
rank lanes differently the result is \`inconclusive\`.

W1 measures cost and an upper bound on opportunity. It cannot measure
addressable savings.

## How to run these

Every selector carries the node filter \`${nodeProfile.selector}\`, built from
the shared Prometheus node-identity profile (\`--prom-node-label\`, default
\`${nodeProfile.label}\`). Paste a query into a Grafana panel or Explore with a
\`$node\` variable, or substitute the interpolation with a concrete matcher such
as \`${nodeProfile.label}="my-node"\`.

The identical expressions are emitted as a Prometheus rule group in
\`w1-rules.yaml\` beside this file, and CI parses that fixture with a pinned
\`promtool check rules\` — so every query here is proven to be valid PromQL, not
merely regex-plausible.

## Instruments

${instrumentTable(W1_INSTRUMENTS)}

Corroborating instruments (pre-existing, not part of the W1 inventory):

${instrumentTable(W1_CORROBORATING_INSTRUMENTS)}

**Two spellings, always.** A DKG node's metrics reach a Prometheus-compatible
store either natively (dots → underscores only) or through the OTel Prometheus
naming convention (unit suffix, \`_total\` on monotonic counters). A selector
naming one spelling comes back empty on the other route — indistinguishable
from "no traffic". Selectors below therefore match both, the same way the
metrics dashboard already writes \`dkg_publish_duration(_milliseconds)?_bucket\`.

## Source families (§5.5)

\`SYNC_ADMISSION_SOURCES\` has exactly eight members and this table is
exhaustive over them. The \`invalidating\` family is the **negation** of the
seven classified sources, so \`unspecified\` and any future member added without
updating this table both surface in the gate instead of vanishing.

${familyTable()}

\`control-plane\` is reported separately rather than counted as eligible cost:
curator meta refresh issues \`plane=durable\`/\`phase=meta\` fetches from outside
any admission boundary, so it is real durable traffic that no trigger the
decision rule reasons about is responsible for.

Eligible (materiality numerator): \`${SOURCE_ELIGIBLE}\`

## Filters (§7.2)

- **I1–I3 (attempts and bytes):** \`${DURABLE_ATTEMPT_FILTER.join('\`, \`')}\` — excludes \`snapshot\` and \`catalog\`
- **I4/I5 (operations):** \`${REQUESTER_LANE_FILTER.join('\`, \`')}\` — requester lanes only, not the full scheduler lane union

## Decision rule (fixed before collection, §7.3)

Evidence gates — any unmet ⇒ \`inconclusive\`:

${gateTable(W1_EVIDENCE_GATES)}

Materiality — **both axes**, with a strain floor:

${gateTable(W1_MATERIALITY)}

| Outcome | Meaning |
|---|---|
| all satisfied by one family | that lane is the first **shadow** candidate |
| axes rank different families | \`inconclusive\` |
| eligible share < 0.30 of all-source active ms | \`inconclusive / re-scope\` |
| any gate unmet | \`inconclusive → W3 stays parked\` |

A zero denominator is \`inconclusive\`, never a win — the share queries are plain
divisions with no clamp, so an empty or infinite result reads as exactly that.

${windows.map((w) => `## Window: ${w.title} (\`${w.id}\`, range \`${w.range}\`)

Collection minimum: ${w.minimum}. Rule group \`w1-${w.id}-window\` in
\`w1-rules.yaml\` carries these same expressions.

${w.sections.map((s) => `### ${s.section}

${s.queries.map((q) => `**\`${q.id}\`** — ${q.title}

${q.purpose}

\`\`\`promql
${q.expr}
\`\`\`
`).join('\n')}`).join('\n')}`).join('\n')}`;

// YAML emission: one double-quoted scalar per expression. PromQL carries `"`
// (label matchers) and never a newline, so a single-line quoted scalar with
// `\` and `"` escaped is both valid YAML and trivially recoverable by the
// verifier — no block-scalar indentation to get wrong on either side.
const yamlQuote = (s) => `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

const renderRules = ({ windows }) => [
  '# GENERATED FILE — do not edit. Source: tools/observability/lib/w1.mjs',
  '# Regenerate with: node tools/observability/generate-observability.mjs',
  '#',
  '# A Prometheus rule group carrying the EXACT expressions of w1-queries.md,',
  '# so `promtool check rules` parses every W1 decision query. This is a',
  '# parser fixture, not a deployment artifact: nothing provisions it, and',
  '# verify-w1-render.mjs asserts it is expression-identical to the report so',
  '# it can never drift into a hand-maintained second copy.',
  'groups:',
  ...windows.flatMap((w) => [
    `  - name: w1-${w.id}-window`,
    '    rules:',
    ...w.sections.flatMap((s) => s.queries.flatMap((q) => [
      `      # ${q.title}`,
      `      - record: w1:${w.id}:${q.id}`,
      `        expr: ${yamlQuote(q.expr)}`,
    ])),
  ]),
  '',
].join('\n');

/** The rendered W1 artifact set, keyed by path relative to the output dir. */
export const buildW1Artifacts = ({ nodeProfile }) => {
  const windows = W1_WINDOWS.map((w) => ({ ...w, sections: buildWindowQueries({ nodeProfile, range: w.range }) }));
  return {
    'w1/w1-queries.md': renderReport({ nodeProfile, windows }),
    'w1/w1-rules.yaml': renderRules({ windows }),
  };
};
