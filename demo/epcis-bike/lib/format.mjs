// Output helpers for the EPCIS-bike demo orchestration script.
// All formatting is deliberately minimal — the demo's value is data flow, not visuals.

const TTY = process.stdout.isTTY === true;

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
};

function paint(text, color) {
  if (!TTY) return text;
  return `${COLORS[color] ?? ''}${text}${COLORS.reset}`;
}

export function divider(char = '─', width = 72) {
  return char.repeat(width);
}

export function header(text) {
  console.log('');
  console.log(paint(divider('═'), 'cyan'));
  console.log(paint(`  ${text}`, 'bold'));
  console.log(paint(divider('═'), 'cyan'));
}

export function story(title, paragraphs) {
  console.log('');
  console.log(paint(divider('━'), 'blue'));
  console.log(paint(`  ${title}`, 'bold'));
  console.log(paint(divider('━'), 'blue'));
  console.log('');
  for (const para of paragraphs) {
    if (isPreformatted(para)) {
      // Print as-is, preserving leading whitespace and line breaks.
      for (const line of para.split('\n')) {
        console.log(paint(line, 'dim'));
      }
    } else {
      for (const line of wrap(para, 70)) {
        console.log(paint(`  ${line}`, 'dim'));
      }
    }
    console.log('');
  }
}

// Treat a block as preformatted if it contains box-drawing characters,
// flow arrows, or has more than two consecutive leading spaces on any line —
// any of those signal an ASCII diagram or formatted layout that wrap()
// would mangle.
function isPreformatted(text) {
  if (/[│─┐┘└┌┬┤├┴┼▶◀╔╗╚╝═║]/.test(text)) return true;
  for (const line of text.split('\n')) {
    if (/^ {3,}/.test(line) && line.trim().length > 0) return true;
  }
  return false;
}

function wrap(text, width) {
  // Preserve explicit line breaks (e.g. bullet lists in narrative).
  const lines = [];
  for (const segment of text.split('\n')) {
    if (segment.trim() === '') {
      lines.push('');
      continue;
    }
    const words = segment.split(/\s+/);
    let line = '';
    for (const w of words) {
      if (line.length + w.length + 1 > width && line.length > 0) {
        lines.push(line);
        line = w;
      } else {
        line = line ? `${line} ${w}` : w;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

import { createInterface } from 'node:readline';

export async function pauseFor(prompt) {
  if (!process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => {
    rl.question(paint(`  ▶ ${prompt} `, 'cyan'), () => {
      rl.close();
      resolve();
    });
  });
}

export function step(stepId, title) {
  console.log('');
  console.log(paint(`▸ ${stepId}`, 'magenta'), paint(title, 'bold'));
}

export function preamble(text) {
  if (!text) return;
  for (const line of wrap(text, 70)) {
    console.log(paint(`  ${line}`, 'dim'));
  }
}

export function command(cmdString) {
  console.log(paint('$', 'dim'), paint(cmdString, 'cyan'));
}

export function output(text, maxLines = 30) {
  if (!text) return;
  const lines = String(text).split('\n');
  const shown = lines.slice(0, maxLines);
  for (const line of shown) {
    console.log(paint('│ ', 'dim') + line);
  }
  if (lines.length > maxLines) {
    console.log(paint('│ ', 'dim') + paint(`… (${lines.length - maxLines} more lines)`, 'dim'));
  }
}

// Render a short, human-friendly summary of common JSON response shapes.
// Falls back to raw JSON only when the shape is unrecognized.
export function summarizeJson(parsed, kind) {
  if (parsed === undefined || parsed === null) return;
  switch (kind) {
    case 'capture':
      return summarizeCapture(parsed);
    case 'status':
      return summarizeStatus(parsed);
    case 'epcis-query':
      return summarizeEpcisQuery(parsed);
    case 'http': // raw daemon API response (sub-graph create)
      return summarizeHttp(parsed);
    default:
      return summarizeFallback(parsed);
  }
}

function kv(label, value, color = 'green') {
  if (value === undefined || value === null) return;
  console.log(paint('│ ', 'dim') + paint(label, 'bold') + ' ' + paint(String(value), color));
}

function summarizeCapture(p) {
  if (p?.captureID) kv('captureID', p.captureID, 'green');
  if (p?.message) kv('message', p.message, 'dim');
}

function summarizeStatus(p) {
  if (p?.captureID) kv('captureID', String(p.captureID).slice(0, 12) + '…', 'dim');
  if (p?.state) {
    // Publisher's success terminal is `finalized` (V10). `completed` is
    // an older alias kept for backwards compatibility with status outputs
    // from earlier rcs. Both should render green.
    const isSuccess = p.state === 'finalized' || p.state === 'completed';
    const stateColor = isSuccess ? 'green' : p.state === 'failed' ? 'red' : 'yellow';
    kv('state', p.state, stateColor);
  }
  if (p?.finalizedAt) kv('finalizedAt', p.finalizedAt, 'dim');
  if (p?.ual) kv('UAL', p.ual, 'cyan');
  if (p?.error) {
    console.log(paint('│ ', 'dim') + paint('error', 'bold') + ' ' + paint(p.error, 'red'));
  }
}

function summarizeEpcisQuery(p) {
  const events = p?.epcisBody?.queryResults?.resultsBody?.eventList;
  if (!Array.isArray(events)) {
    return summarizeFallback(p);
  }
  console.log(paint('│ ', 'dim') + paint(`${events.length} event(s)`, 'bold'));
  if (events.length === 0) return;
  // Show one sample event compactly.
  const e = events[0];
  console.log(paint('│ ', 'dim') + paint('Sample event:', 'dim'));
  if (e.eventTime) kv('  eventTime', e.eventTime, 'dim');
  if (e.bizStep) kv('  bizStep', String(e.bizStep).split('/').pop(), 'dim');
  if (e.disposition) kv('  disposition', String(e.disposition).split('/').pop(), 'dim');
  if (e.action) kv('  action', e.action, 'dim');
  if (Array.isArray(e.epcList) && e.epcList.length > 0) {
    kv('  epcList', e.epcList.slice(0, 2).join(', ') + (e.epcList.length > 2 ? ` (+${e.epcList.length - 2})` : ''), 'dim');
  }
  if (e?.readPoint?.id) kv('  readPoint', e.readPoint.id, 'dim');
  if (events.length > 1) {
    console.log(paint('│ ', 'dim') + paint(`(+${events.length - 1} more event(s) not shown)`, 'dim'));
  }
}

function summarizeHttp(p) {
  if (p?.subGraphName) kv('subGraphName', p.subGraphName, 'green');
  if (p?.contextGraphId) kv('contextGraphId', p.contextGraphId, 'dim');
  if (p?.error) kv('error', p.error, 'red');
  if (p?.message) kv('message', p.message, 'dim');
}

function summarizeFallback(p) {
  // Truncate huge JSON to keep terminal readable.
  const json = JSON.stringify(p, null, 2);
  const lines = json.split('\n');
  const limit = 20;
  for (const line of lines.slice(0, limit)) {
    console.log(paint('│ ', 'dim') + line);
  }
  if (lines.length > limit) {
    console.log(paint('│ ', 'dim') + paint(`… (${lines.length - limit} more lines)`, 'dim'));
  }
}

export function note(text) {
  console.log(paint(`  ${text}`, 'dim'));
}

export function success(text) {
  console.log(paint(`✓ ${text}`, 'green'));
}

export function warn(text) {
  console.log(paint(`⚠ ${text}`, 'yellow'));
}

export function fail(text) {
  console.log(paint(`✗ ${text}`, 'red'));
}

// TTY-aware single-token colorisers. Use these when interpolating a
// colored token inside a longer line (e.g. inside a `fmt.note(…)`)
// rather than hand-rolling `\x1b[32m…\x1b[0m`. In a non-TTY (CI logs,
// pipes, JSON mode) these strip the escape sequences via `paint`,
// keeping the output readable in log aggregators that don't render
// ANSI. Hand-rolled escapes inside note() are NOT stripped — the
// surrounding text is painted, not its contents.
export function green(text) {
  return paint(text, 'green');
}

export function red(text) {
  return paint(text, 'red');
}

export function json(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

export function table(rows, headers) {
  if (!rows.length) return;
  const cols = headers ?? Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)),
  );
  const fmtRow = (vals) =>
    vals.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ');
  console.log(paint(fmtRow(cols), 'bold'));
  console.log(paint(widths.map((w) => '─'.repeat(w)).join('  '), 'dim'));
  for (const row of rows) {
    console.log(fmtRow(cols.map((c) => row[c])));
  }
}
