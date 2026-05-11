import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DaemonState } from './daemon.js';

export interface SeedState {
  contextGraphId: string;
  contextGraphName: string;
  assertionName: string;
  /** File-backed assertion (separate from the quads-only one). FilePreview tests use this. */
  fileAssertionName: string;
  assertionUri: string;
  fileHash: string;
}

export async function seed(daemon: DaemonState): Promise<SeedState> {
  const headers = {
    Authorization: `Bearer ${daemon.authToken}`,
    'Content-Type': 'application/json',
  };
  const base = `http://127.0.0.1:${daemon.apiPort}`;

  const contextGraphId = 'qa-cg';
  const contextGraphName = 'QA Context Graph';
  const createResp = await fetch(`${base}/api/context-graph/create`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: contextGraphId,
      name: contextGraphName,
      description: 'Seeded for E2E test runs',
    }),
  });
  if (!createResp.ok && createResp.status !== 409) {
    const text = await createResp.text();
    throw new Error(`createContextGraph failed: ${createResp.status} ${text}`);
  }
  await waitForCgVisible(base, daemon.authToken, contextGraphId, 30_000);

  // Write a small set of quads into a named WM assertion. Using the
  // explicit `write` endpoint (rather than `import-file`) keeps the graph
  // URI under did:dkg:context-graph:<cg>/assertion/<addr>/<name>, which is
  // what the UI's WM list-assertions SPARQL filter expects.
  const assertionName = 'qa-seed-doc';
  // Quads are objects (matching storage/src/triple-store.ts#Quad). The
  // daemon assigns the graph URI (it's derived from cg + assertion name +
  // agent address), so we leave `graph` empty here.
  const quads = [
    { subject: 'urn:dkg:qa:fact-1', predicate: 'http://schema.org/name', object: '"QA Seed Fact 1"', graph: '' },
    { subject: 'urn:dkg:qa:fact-1', predicate: 'http://schema.org/description', object: '"Seeded for E2E coverage."', graph: '' },
    { subject: 'urn:dkg:qa:fact-2', predicate: 'http://schema.org/name', object: '"QA Seed Fact 2"', graph: '' },
  ];
  const writeResp = await fetch(`${base}/api/assertion/${assertionName}/write`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ contextGraphId, quads }),
  });
  if (!writeResp.ok) {
    const text = await writeResp.text();
    throw new Error(`assertion write failed: ${writeResp.status} ${text}`);
  }
  await writeResp.json().catch(() => null);

  // Also import a file so the FilePreviewModal has something to render.
  const filePath = join(tmpdir(), `dkg-e2e-${Date.now()}.txt`);
  await writeFile(filePath, 'Hello DKG. QA seed document for E2E coverage.\n');
  const form = new FormData();
  form.append('contextGraphId', contextGraphId);
  const buf = await readFile(filePath);
  form.append('file', new Blob([buf], { type: 'text/plain' }), 'qa-seed.txt');
  const fileAssertionName = `${assertionName}-file`;
  const importResp = await fetch(`${base}/api/assertion/${fileAssertionName}/import-file`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${daemon.authToken}` },
    body: form,
  });
  const importJson = (await importResp.json().catch(() => ({}))) as {
    assertionUri?: string;
    fileHash?: string;
  };
  // Clean up the temp file — the daemon already has the bytes.
  await rm(filePath, { force: true }).catch(() => {});

  return {
    contextGraphId,
    contextGraphName,
    assertionName,
    fileAssertionName,
    assertionUri: importJson.assertionUri ?? '',
    fileHash: importJson.fileHash ?? '',
  };
}

async function waitForCgVisible(base: string, token: string, cgId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // V10: /api/paranet/list was removed in the paranet -> context-graph
      // rename (commit 7347c165). The replacement endpoint returns the same
      // { contextGraphs: [{ id, ... }] } shape, so the poll body is unchanged.
      const resp = await fetch(`${base}/api/context-graph/list`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = (await resp.json()) as { contextGraphs?: Array<{ id: string }> };
        if (data.contextGraphs?.some((cg) => cg.id === cgId)) return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`context graph "${cgId}" never became visible to /api/context-graph/list`);
}
