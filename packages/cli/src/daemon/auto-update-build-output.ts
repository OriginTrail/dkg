// Bounded excerpts of a failed updater build step's output for the daemon log.
//
// `exec` rejects a non-zero exit with "Command failed: <cmd>\n<stderr>", and
// pnpm prints a failing workspace script's output and its error summary on
// stdout. The message alone then names no cause: git-mode nodes logged only
// "Command failed: pnpm build:runtime:packages", with an empty stderr. These
// helpers keep the failure summary on one line and give the last lines of each
// captured stream as separate log lines.

import { stripVTControlCharacters } from 'node:util';

/** Lines kept from the end of each captured stream. */
export const BUILD_OUTPUT_TAIL_LINES = 30;
/** Characters kept from each output line. */
export const BUILD_OUTPUT_LINE_CHARS = 300;
// Only the end of a stream is split into lines; exec buffers up to 1 MiB.
const TAIL_WINDOW_CHARS = 64 * 1024;
// Every C0 control character except tab, and DEL, left once terminal sequences are
// stripped. Line breaks are split first.
// eslint-disable-next-line no-control-regex -- removes control characters from build output before it is logged.
const CONTROL_CHARACTER = /[\x00-\x08\x0a-\x1f\x7f]/g;

/** The first line of a failed step's error, without the stderr that `exec` appends. */
export function buildStepFailureSummary(err: unknown): string {
  const message = String((err as { message?: unknown } | null | undefined)?.message ?? err);
  return message.split(/\r?\n/, 1)[0].trim() || String(err);
}

/** The last non-blank lines of a captured stream, without terminal escapes or control characters. */
export function outputTail(output: unknown, maxLines = BUILD_OUTPUT_TAIL_LINES): string[] {
  if (output === undefined || output === null) return [];
  const lines = stripVTControlCharacters(String(output).slice(-TAIL_WINDOW_CHARS))
    .split(/\r\n|\n|\r/)
    .map((line) => line.replace(CONTROL_CHARACTER, '').trimEnd())
    .filter((line) => line.trim() !== '');
  return lines.slice(-maxLines).map((line) => (
    line.length > BUILD_OUTPUT_LINE_CHARS ? `${line.slice(0, BUILD_OUTPUT_LINE_CHARS)}…` : line
  ));
}

/** Daemon log lines with the end of a failed step's stdout and stderr, as `exec` captured them. */
export function buildStepOutputLines(label: string, err: unknown): string[] {
  const captured = (err ?? {}) as { stdout?: unknown; stderr?: unknown };
  const lines: string[] = [];
  for (const stream of ['stdout', 'stderr'] as const) {
    const tail = outputTail(captured[stream]);
    if (tail.length === 0) continue;
    lines.push(`Auto-update: build step "${label}" ${stream}, last ${tail.length} line(s):`);
    for (const line of tail) lines.push(`Auto-update:   ${line}`);
  }
  return lines;
}
