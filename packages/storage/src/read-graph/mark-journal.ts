// SPDX-License-Identifier: Apache-2.0

/**
 * The read graphs whose dirty mark the store did not take, kept in a file in
 * the node's data directory.
 *
 * A dirty mark goes to the state mirror first and then to the stored row. When
 * the store refuses the second, the mirror keeps the read graph out of service
 * in this process, but its stored row still says `ready`. A process that stops
 * before a later mark lands would leave that row for the next start-up to
 * keep: a check's mismatch, or a write whose outcome is unknown, would be
 * forgotten. So such a mark is also written here, with the generation of the
 * row it marks, and start-up marks dirty every row still stored `ready` at
 * that generation. A row that moved on since was marked or rebuilt, and needs
 * nothing.
 *
 * The file is a line per mark, `{generation} {read graph}`. Start-up removes it
 * once its own marks are stored.
 */

import { appendFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseReadGraphIri } from '@origintrail-official/dkg-core';
import type { ReadGraphBackendRuntime } from './runtime.js';

export const READ_GRAPH_MARK_JOURNAL = 'read-graph-unstored-marks';

const JOURNALS = new WeakMap<ReadGraphBackendRuntime, string>();

export function readGraphMarkJournalPath(dataDir: string): string {
  return join(dataDir, READ_GRAPH_MARK_JOURNAL);
}

/** Keep the marks a runtime's stores could not store in this data directory's journal. */
export function useReadGraphMarkJournal(runtime: ReadGraphBackendRuntime, dataDir: string): void {
  JOURNALS.set(runtime, readGraphMarkJournalPath(dataDir));
}

/**
 * Note that the stored row of `readGraph`, at `generation`, may still say
 * ready although the read graph is dirty. Without a journal it notes nothing.
 */
export function noteUnstoredReadGraphMark(runtime: ReadGraphBackendRuntime, readGraph: string, generation: number): void {
  const file = JOURNALS.get(runtime);
  if (file === undefined || !Number.isSafeInteger(generation) || /\s/.test(readGraph)) return;
  try {
    appendFileSync(file, `${generation} ${readGraph}\n`);
  } catch {
    // The data directory cannot be written either: nothing more can keep the mark.
  }
}

/** The journal's marks: for each read graph, the generations at which it must not be kept ready. */
export function readUnstoredReadGraphMarks(dataDir: string): Map<string, Set<number>> {
  let text: string;
  try {
    text = readFileSync(readGraphMarkJournalPath(dataDir), 'utf8');
  } catch {
    return new Map();
  }
  const marks = new Map<string, Set<number>>();
  for (const line of text.split('\n')) {
    const [generation, readGraph, ...rest] = line.trim().split(' ');
    const value = Number(generation);
    if (readGraph === undefined || rest.length > 0 || !Number.isSafeInteger(value) || parseReadGraphIri(readGraph) === undefined) continue;
    marks.set(readGraph, (marks.get(readGraph) ?? new Set()).add(value));
  }
  return marks;
}

/** The journal as it stands, or `undefined` without one. */
export function unstoredReadGraphMarksText(dataDir: string): string | undefined {
  try {
    return readFileSync(readGraphMarkJournalPath(dataDir), 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Remove the journal, once every mark it held is stored. With `ifText`, only
 * while it still reads so: a mark noted meanwhile keeps it.
 */
export function clearUnstoredReadGraphMarks(dataDir: string, ifText?: string): void {
  if (ifText !== undefined && unstoredReadGraphMarksText(dataDir) !== ifText) return;
  rmSync(readGraphMarkJournalPath(dataDir), { force: true });
}
