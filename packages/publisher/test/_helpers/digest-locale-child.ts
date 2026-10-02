/**
 * Child-process fixture for `workspace-snapshot-digest-locale.e2e.test.ts`.
 *
 * It runs under its own `LANG` / `LC_ALL` (set by the parent), so the default
 * collator is the real one for that locale rather than a simulation, and it
 * drives the real snapshot store on real files. One JSON document goes to
 * stdout. Commands (argv[2]), each reading a JSON payload from argv[3]:
 *
 *   digests  {quads}                     the digests this process computes
 *   write    {dir, quads, form}          write a snapshot named by `form`
 *   validate {dir, ref, digest, count}   validate and read a persisted snapshot
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  workspacePublicQuadsCodeUnitDigest,
  workspacePublicQuadsDigest,
  workspacePublicQuadsDigestMatches,
  workspacePublicQuadsLegacyDigest,
} from '../../src/workspace-public-quads-digest.js';
import { FileWorkspacePublicSnapshotStore } from '../../src/workspace-snapshot-store.js';

async function listFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await listFiles(path));
    else found.push(path);
  }
  return found.sort();
}

const [, , command, rawPayload] = process.argv;
const payload = JSON.parse(rawPayload ?? '{}') as {
  dir?: string;
  quads?: Quad[];
  form?: 'legacy' | 'code-unit' | 'producer';
  ref?: string;
  digest?: string;
  count?: number;
};
const quads = payload.quads ?? [];
const options = { gc: { enabled: false } };

const report: Record<string, unknown> = {
  command,
  locale: new Intl.Collator().resolvedOptions().locale,
  gate: process.env.DKG_SWM_DIGEST_ORDERING ?? null,
};

if (command === 'digests') {
  report.legacy = workspacePublicQuadsLegacyDigest(quads);
  report.codeUnit = workspacePublicQuadsCodeUnitDigest(quads);
  report.producer = workspacePublicQuadsDigest(quads);
} else if (command === 'write') {
  const store = new FileWorkspacePublicSnapshotStore(payload.dir!, undefined, options);
  const digest = payload.form === 'code-unit'
    ? workspacePublicQuadsCodeUnitDigest(quads)
    : payload.form === 'legacy'
      ? workspacePublicQuadsLegacyDigest(quads)
      : workspacePublicQuadsDigest(quads);
  const { ref } = await store.putSnapshot({ digest, quads });
  report.digest = digest;
  report.ref = ref;
  report.files = (await listFiles(payload.dir!)).map((file) => file.slice(payload.dir!.length + 1));
} else if (command === 'validate') {
  const store = new FileWorkspacePublicSnapshotStore(payload.dir!, undefined, options);
  const persisted = await store.getSnapshot(payload.ref!);
  report.valid = await store.validateSnapshot(payload.ref!, payload.digest!, payload.count!);
  report.readable = persisted !== null;
  report.readBack = persisted;
  report.matches = persisted === null ? null : workspacePublicQuadsDigestMatches(persisted, payload.digest!);
  report.files = (await listFiles(payload.dir!)).map((file) => file.slice(payload.dir!.length + 1));
} else {
  throw new Error(`unknown command ${String(command)}`);
}

process.stdout.write(`${JSON.stringify(report)}\n`);
