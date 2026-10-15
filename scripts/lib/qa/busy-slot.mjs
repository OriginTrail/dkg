// The judgements of case 6 of devnet-test-issue-3251-member-sharing.mjs: did
// the large transfer hold member 2's only sync slot while the writes were made
// and received? Kept apart from the devnet I/O so that each one is tested on
// its own.
//
// The evidence is the node's own. Its log names every admission to its global
// sync slots (`Sync backpressure running <label> …`, local time in whole
// seconds; no line marks an end). Its diagnostics (`sync-global` in
// /api/diagnostics/backpressure) report its policy, the work in flight, the
// age of the oldest running admission and the class of each running
// operation, but never a graph.
//
// The transfer is identified by when it started. A reading names the start of
// the oldest running admission: between the moment the request was sent and
// the moment the answer came, less the age it reports. The reading that
// confirms the transfer ties that start to the log, where every admission that
// could have started then must be one of the large graph; every later reading
// must name the same start. One slot serves one admission at a time, so the
// work that takes the slot once the transfer has ended (a pull of another
// graph, say) started later and names another start, however soon after the
// transfer it was admitted.

// A node writes an admission's log line as soon as the admission starts; this
// allows for a busy event loop between the two.
const LOG_LAG_MS = 250;
// A reading confirms the transfer only when its answer came this soon: the
// start it names is then this precise.
const CONFIRMING_LATENCY_MS = 250;
// How far a later reading of the same admission can name its start from the
// confirming one: that reading's own latency, and the drift of the wall clock
// against the node's monotonic clock during the window. A later reading that
// came too slowly to name its start that closely is no evidence either way.
const SAME_START_MS = 250;
// A reading confirms the transfer only once it has run this long, longer than
// a start can be named apart (CONFIRMING_LATENCY_MS + SAME_START_MS): work
// admitted after the transfer ended started later than that, so no reading of
// it can pass for one of the transfer.
const CONFIRMING_AGE_MS = 1000;

/** The class the node reports for an admission's label (the agent's `syncOperationClass`). */
export function admissionClass(label) {
  const operation = String(label).split(':', 1)[0];
  return ['durable', 'changelog', 'shared-memory', 'swm-recovery'].includes(operation) ? operation : 'sync';
}

/**
 * Every admission to the node's global sync slots that its log names, oldest
 * first: { startMs (local clock, the second of its log line), label,
 * operation (its class) }.
 */
export function admissionRecords(logText) {
  const marker = 'Sync backpressure running ';
  const records = [];
  for (const line of String(logText ?? '').split('\n')) {
    const at = line.indexOf(marker);
    if (at === -1) continue;
    const time = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) /.exec(line);
    if (!time) continue;
    const label = line.slice(at + marker.length).split(' ', 1)[0];
    records.push({ startMs: new Date(`${time[1]}T${time[2]}`).getTime(), label, operation: admissionClass(label) });
  }
  return records;
}

/**
 * Whether a reading shows the policy of case 6's member: one sync slot and no
 * queue (`syncGlobalMaxInflight: 1`, `syncGlobalQueueLimit: 0`). The reading
 * reports the node's effective policy, so an environment override
 * (`DKG_SYNC_GLOBAL_MAX_INFLIGHT`, …) that gave it spare slots shows here.
 * Returns null when it does, else the reason.
 */
export function singleSlotProblem(reading) {
  if (!reading || reading.unreadable) return `the sync slots could not be read (${reading?.unreadable ?? 'no reading'})`;
  if (reading.capacityModel !== 'shared') return `the sync slots are not one shared pool (${reading.capacityModel ?? 'no capacity model'})`;
  if (reading.inflightLimit !== 1) return `the node runs ${reading.inflightLimit ?? 'an unknown number of'} sync slot(s), not one`;
  if (reading.queueLimit !== 0) return `the node has a sync queue of ${reading.queueLimit ?? 'unknown size'}, not none`;
  return null;
}

/**
 * When a reading's oldest running admission started: { from, to } on the
 * local clock (ms), or null when nothing runs. The node took the reading
 * between `sentAt` and `at` and floors the age to a whole millisecond.
 */
export function startInterval(reading) {
  if (!reading || reading.unreadable || !(reading.inflight >= 1) || !Number.isFinite(reading.at) || !Number.isFinite(reading.oldestActiveAgeMs)) return null;
  const sentAt = Number.isFinite(reading.sentAt) ? reading.sentAt : reading.at;
  return { from: sentAt - reading.oldestActiveAgeMs - 1, to: reading.at - reading.oldestActiveAgeMs };
}

const overlaps = (a, b) => a.from <= b.to && b.from <= a.to;
// The classes of the oldest running work a reading names, or null when it names none.
const oldestClasses = reading => (Array.isArray(reading?.oldestOperations) && reading.oldestOperations.length ? reading.oldestOperations : null);

/**
 * The admissions of the log that a reading's oldest running admission can be:
 * those whose log line could have been written by an admission that started
 * when the reading says, and of a class the reading names (when it names one).
 */
export function candidateAdmissions(reading, records) {
  const start = startInterval(reading);
  if (!start) return [];
  const classes = oldestClasses(reading);
  return records.filter(record => overlaps(start, { from: record.startMs - LOG_LAG_MS, to: record.startMs + 999 })
    && (!classes || classes.includes(record.operation)));
}

/**
 * Whether a reading shows the large transfer in the slot: the policy of case
 * 6, work in flight for a while, an answer that came soon enough to name when
 * that work started, and only admissions of the large graph (`isTransfer`) in
 * the log that could have started then. Returns { transfer } (its identity:
 * when it started, and its class) or { why }.
 */
export function heldTransfer(reading, records, isTransfer) {
  const policy = reading === undefined ? 'no reading yet' : singleSlotProblem(reading);
  if (policy) return { why: policy };
  const start = startInterval(reading);
  if (!start) return { why: 'its slot was free' };
  if (start.to - start.from > CONFIRMING_LATENCY_MS) return { why: 'no reading came soon enough to tell when the running work started' };
  if (reading.oldestActiveAgeMs < CONFIRMING_AGE_MS) return { why: `the running work had run for less than ${CONFIRMING_AGE_MS / 1000} s` };
  const candidates = candidateAdmissions(reading, records);
  if (candidates.length === 0) return { why: 'its log shows no admission that started when the running work did' };
  if (!candidates.some(isTransfer)) return { why: 'its slot was held by other work' };
  if (!candidates.every(isTransfer)) return { why: 'its log cannot tell the transfer from other work admitted at about the same time' };
  return { transfer: { ...start, operations: [...new Set(candidates.map(record => record.operation))] } };
}

/**
 * Whether the transfer held the node's only sync slot through [from, until],
 * the window of the writes and of their receipt checks. `transfer` is its
 * identity from heldTransfer; `samples` are readings of the node's
 * `sync-global` scheduler ({ sentAt, at, inflight, oldestActiveAgeMs,
 * oldestOperations, inflightLimit, queueLimit, capacityModel }, or
 * { at, unreadable }).
 *
 * Only readings inside the window are evidence: a reading taken before it (a
 * free slot before the transfer was admitted, say) neither proves nor
 * disproves anything about it. Each reading in the window must show the
 * single-slot policy, work in flight, and that work being the transfer: of
 * its class, and started when the transfer did. A reading of other work fails
 * the window. A reading that came too slowly to name the start that closely
 * proves nothing either way, like a missing one. The window must hold at least
 * one reading of the transfer and no gap longer than `maxGapMs` between them
 * (from its start, between readings, to its end). A catch-up job that is
 * merely running proves nothing: without an admission there is nothing that
 * holds the slot.
 * Returns { held: true, provenUntil } or { held: false, reason, provenUntil }.
 */
export function busySlotCovered({ transfer, samples, from, until, maxGapMs = 5000 }) {
  if (!transfer) return { held: false, reason: 'no transfer of it was admitted to a sync slot', provenUntil: null };
  const inWindow = samples.filter(sample => sample.at >= from && sample.at <= until).sort((a, b) => a.at - b.at);
  if (inWindow.length === 0) return { held: false, reason: 'no reading of the sync slot in the window', provenUntil: null };
  const same = { from: transfer.from - SAME_START_MS, to: transfer.to + SAME_START_MS };
  let previous = from;
  let provenUntil = null;
  let slow = 0;
  const gap = (ms, last = '') => `no reading of the sync slot for ${last}${Math.round(ms / 1000)} s${slow ? ` (${slow} more came too slowly to tell which work held it)` : ''}`;
  for (const sample of inWindow) {
    if (sample.at - previous > maxGapMs) return { held: false, reason: gap(sample.at - previous), provenUntil };
    if (sample.unreadable) return { held: false, reason: `the sync slot could not be read (${sample.unreadable})`, provenUntil };
    const policy = singleSlotProblem(sample);
    if (policy) return { held: false, reason: policy, provenUntil };
    const start = startInterval(sample);
    if (!start) return { held: false, reason: 'the sync slot was free', provenUntil };
    const classes = oldestClasses(sample);
    const otherClass = classes && transfer.operations?.length && !classes.some(operation => transfer.operations.includes(operation));
    if (otherClass || !overlaps(start, same)) return { held: false, reason: 'the slot was held by other work', provenUntil };
    if (start.from < same.from || start.to > same.to) {
      slow += 1;
      continue;
    }
    previous = sample.at;
    provenUntil = sample.at;
    slow = 0;
  }
  if (until - previous > maxGapMs) return { held: false, reason: gap(until - previous, 'the last '), provenUntil };
  if (provenUntil === null) return { held: false, reason: gap(until - from), provenUntil };
  return { held: true, provenUntil };
}
