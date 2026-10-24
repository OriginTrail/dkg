// Which admission to a node's global sync slots a reading of its diagnostics
// shows, reconstructed: case 6 of devnet-test-issue-3251-member-sharing.mjs
// needs to know that the work in member 2's slot is still the large transfer.
//
// The node names no admission. /api/diagnostics/backpressure reports, for the
// `sync-global` scheduler, its policy, the work in flight, the age of the
// oldest running admission and, per lane, the class and trigger of the running
// operations with the age of the oldest of each; never a graph, peer or ticket
// (the route keeps them out by design). /api/status carries only states. So an
// admission is identified here by when it started, which a reading names
// through its age, and is tied to a graph through the node log, which names
// every admission with its label. If the node ever names the admission it
// reports, this module is replaced by a comparison of that name.
//
// The reconstruction rests on these assumptions; where one does not hold, a
// reading can be taken for the wrong admission:
//
//  1. One sync slot (checked by busy-slot.mjs before any of this): admissions
//     follow one another, so work admitted after an admission ended started
//     after it. (A reserved slot can run an admission beside it; the oldest
//     running one is then still the first.)
//  2. The age is measured on the node's monotonic clock and floored to the
//     millisecond; the node and the suite run on one host, and the wall clock
//     the suite reads drifts from the node's monotonic clock by less than
//     SAME_START_MS, less a reading's latency, over a window.
//  3. The node logs `Sync backpressure running <label> ...` for every
//     admission to these slots, at most LOG_LAG_MS after the admission
//     started, in local time with whole seconds, and the label names the
//     graph. A line can reach the log late; a caller that confirmed an
//     admission checks the confirming reading again against the whole log
//     once the window has ended.
//  4. The class the diagnostics give an operation is the first segment of its
//     label (the agent's `syncOperationClass`).
//
// Two admissions that started in the same log second (within LOG_LAG_MS of
// it) cannot be told apart from the log: when they are of different graphs,
// nothing is identified.

// A node writes an admission's log line as soon as the admission starts; this
// allows for a busy event loop between the two.
const LOG_LAG_MS = 250;
// A reading identifies an admission only when its answer came this soon: the
// start it names is then this precise.
const IDENTIFYING_LATENCY_MS = 250;
// How far a later reading of the same admission can name its start from the
// identifying one: that reading's own latency, and the drift of the wall clock
// against the node's monotonic clock during the window. A later reading that
// came too slowly to name its start that closely tells nothing either way.
const SAME_START_MS = 250;
// A reading identifies an admission only once it has run this long, longer
// than a start can be named apart (IDENTIFYING_LATENCY_MS + SAME_START_MS):
// work admitted after it ended started later than that, so no reading of such
// work can pass for one of it.
const IDENTIFYING_AGE_MS = 1000;

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
 * The oldest running admission a reading shows, as far as the reading and the
 * log can name it: { identity: { from, to, operations, records } } (when it
 * started, its class, and the log's admissions it can be) or { why }. It takes
 * an answer that came soon enough, work that has run long enough, and at least
 * one admission of the log that could have started then.
 */
export function identifyAdmission(reading, records) {
  const start = startInterval(reading);
  if (!start) return { why: 'its slot was free' };
  if (start.to - start.from > IDENTIFYING_LATENCY_MS) return { why: 'no reading came soon enough to tell when the running work started' };
  if (reading.oldestActiveAgeMs < IDENTIFYING_AGE_MS) return { why: `the running work had run for less than ${IDENTIFYING_AGE_MS / 1000} s` };
  const candidates = candidateAdmissions(reading, records);
  if (candidates.length === 0) return { why: 'its log shows no admission that started when the running work did' };
  return { identity: { ...start, operations: [...new Set(candidates.map(record => record.operation))], records: candidates } };
}

/**
 * Whether a later reading shows the identified admission as its oldest
 * running one: 'same' (of its class, and started when it did), 'other' (other
 * work, or nothing), or 'unclear' (the answer came too slowly to tell).
 */
export function sameAdmission(reading, identity) {
  const start = startInterval(reading);
  if (!start) return 'other';
  const classes = oldestClasses(reading);
  if (classes && identity.operations?.length && !classes.some(operation => identity.operations.includes(operation))) return 'other';
  const same = { from: identity.from - SAME_START_MS, to: identity.to + SAME_START_MS };
  if (!overlaps(start, same)) return 'other';
  return start.from < same.from || start.to > same.to ? 'unclear' : 'same';
}
