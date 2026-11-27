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
 * once its own marks are stored. A journal that exists but cannot be read
 * fails the start-up: it is never taken for an empty one. A mark the journal
 * itself cannot take leaves a note beside it, and a start-up that finds the
 * note keeps no row ready.
 *
 * Agents of one process over the same backend share its runtime, and any of
 * them may be the one a later process starts alone. So a mark goes to the
 * journal of each of the runtime's data directories (`./data-directories.ts`),
 * and a directory that joins later gets the marks noted before it too. Once
 * one start-up stores a mark, the row moves on to a newer generation, and the
 * same mark in another journal finds nothing to do.
 */

import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReadGraphIri } from '@origintrail-official/dkg-core';
import { addReadGraphDataDirectory, readGraphDataDirectories } from './data-directories.js';
import type { ReadGraphBackendRuntime } from './runtime.js';
import type { ReadGraphStateRow } from './state.js';

export const READ_GRAPH_MARK_JOURNAL = 'read-graph-unstored-marks';
/** A note, beside the journal, that a mark could not be written to it: a start-up then keeps no row ready. */
export const READ_GRAPH_MARK_JOURNAL_INCOMPLETE = 'read-graph-unstored-marks-incomplete';

/** The marks noted for each runtime in this process, as journal lines. */
const NOTED = new WeakMap<ReadGraphBackendRuntime, Set<string>>();
/** The data directories whose journal took the marks noted before they joined. */
const JOINED = new WeakMap<ReadGraphBackendRuntime, Set<string>>();
/** The data directories whose journal could not take a mark in this process. */
const UNJOURNALED = new Set<string>();

export function readGraphMarkJournalPath(dataDir: string): string {
  return join(dataDir, READ_GRAPH_MARK_JOURNAL);
}

function incompleteNotePath(dataDir: string): string {
  return join(dataDir, READ_GRAPH_MARK_JOURNAL_INCOMPLETE);
}

/**
 * Keep the marks a runtime's stores could not store in this data directory's
 * journal too: the directory becomes one of the runtime's. The marks noted
 * before it joined go to its journal as it joins.
 */
export function useReadGraphMarkJournal(runtime: ReadGraphBackendRuntime, dataDir: string): void {
  addReadGraphDataDirectory(runtime, dataDir);
  const joined = JOINED.get(runtime) ?? new Set<string>();
  JOINED.set(runtime, joined);
  if (joined.has(dataDir)) return;
  joined.add(dataDir);
  const noted = [...(NOTED.get(runtime) ?? [])];
  if (noted.length > 0) appendJournal(dataDir, noted.join(''));
}

/**
 * Note in each of the runtime's journals that the stored row of `readGraph`,
 * at `generation`, may still say ready although the read graph is dirty.
 * Without a journal it notes nothing until one joins.
 */
export function noteUnstoredReadGraphMark(runtime: ReadGraphBackendRuntime, readGraph: string, generation: number): void {
  if (!Number.isSafeInteger(generation) || /\s/.test(readGraph)) return;
  const line = `${generation} ${readGraph}\n`;
  const noted = NOTED.get(runtime) ?? new Set<string>();
  NOTED.set(runtime, noted.add(line));
  for (const dataDir of readGraphDataDirectories(runtime)) appendJournal(dataDir, line);
}

function appendJournal(dataDir: string, text: string): void {
  try {
    appendFileSync(readGraphMarkJournalPath(dataDir), text);
  } catch {
    // The journal cannot take the mark: a note that it is incomplete makes the next start-up keep no row ready.
    UNJOURNALED.add(dataDir);
    try {
      writeFileSync(incompleteNotePath(dataDir), 'A dirty mark could not be journaled here: start-up keeps no read graph ready.\n');
    } catch {
      // Nothing in this data directory can be written; the others still keep the mark.
    }
  }
}

/**
 * The marks a start-up must not keep a row ready at: the journal's, and every
 * one of `rows` at its generation when a mark could not be written to the
 * journal.
 */
export function readGraphMarksAtStart(dataDir: string, rows: Iterable<ReadGraphStateRow>): Map<string, Set<number>> {
  const marks = readUnstoredReadGraphMarks(dataDir);
  if (!existsSync(incompleteNotePath(dataDir))) return marks;
  for (const row of rows) marks.set(row.readGraph, (marks.get(row.readGraph) ?? new Set()).add(row.generation));
  return marks;
}

/** The journal's marks: for each read graph, the generations at which it must not be kept ready. */
export function readUnstoredReadGraphMarks(dataDir: string): Map<string, Set<number>> {
  const text = unstoredReadGraphMarksText(dataDir) ?? '';
  const marks = new Map<string, Set<number>>();
  for (const line of text.split('\n')) {
    const [generation, readGraph, ...rest] = line.trim().split(' ');
    const value = Number(generation);
    if (readGraph === undefined || rest.length > 0 || !Number.isSafeInteger(value) || parseReadGraphIri(readGraph) === undefined) continue;
    marks.set(readGraph, (marks.get(readGraph) ?? new Set()).add(value));
  }
  return marks;
}

/** The journal as it stands, or `undefined` without one. A journal that exists but cannot be read throws. */
export function unstoredReadGraphMarksText(dataDir: string): string | undefined {
  try {
    return readFileSync(readGraphMarkJournalPath(dataDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Remove the journal, and its note that it is incomplete, once every mark it
 * held is stored. With `ifText`, only while it still reads so: a mark noted
 * meanwhile keeps it. A mark this process could not journal keeps the note.
 */
export function clearUnstoredReadGraphMarks(dataDir: string, ifText?: string): void {
  if (ifText !== undefined && unstoredReadGraphMarksText(dataDir) !== ifText) return;
  rmSync(readGraphMarkJournalPath(dataDir), { force: true });
  if (!UNJOURNALED.has(dataDir)) rmSync(incompleteNotePath(dataDir), { force: true });
}
