import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Quad } from '@origintrail-official/dkg-storage';
import { afterEach, describe, expect, it } from 'vitest';
import { DIVERGENT_QUADS } from './_helpers/digest-locale.js';

/**
 * Real processes, real host locales, real files. Each child is started with its
 * own `LANG` / `LC_ALL`, so its default collator is the genuine article: nothing
 * is simulated. The parent only reads what the children report.
 *
 * What a mixed-locale, mixed-version network needs:
 * - the locale-independent digest is identical in every locale;
 * - a node on any locale accepts what an en-US node persisted before the
 *   upgrade, and what an upgraded node writes under the locale-independent name;
 * - a legacy node accepts the locale-independent digest;
 * - nothing already on disk is renamed or orphaned.
 */
const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const CHILD = resolve(import.meta.dirname, '_helpers/digest-locale-child.ts');
const CODE_UNIT_DIGEST = 'sha256:7405b90c62a0e3d89607e65cee0c829fde0c455c5fc80f69fe2d218566d05867';

const EN = 'en_US.UTF-8';
const DA = 'da_DK.UTF-8';

interface ChildReport {
  command: string;
  locale: string;
  gate: string | null;
  legacy?: string;
  codeUnit?: string;
  producer?: string;
  digest?: string;
  ref?: string;
  valid?: boolean;
  readable?: boolean;
  readBack?: Quad[] | null;
  matches?: boolean | null;
  files?: string[];
}

function run(
  command: 'digests' | 'write' | 'validate',
  payload: Record<string, unknown>,
  host: { locale: string; gate?: 'code-unit' },
): ChildReport {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
  for (const name of ['LANG', 'LC_ALL', 'LC_COLLATE', 'LANGUAGE', 'DKG_SWM_DIGEST_ORDERING']) delete env[name];
  env.LANG = host.locale;
  env.LC_ALL = host.locale;
  if (host.gate) env.DKG_SWM_DIGEST_ORDERING = host.gate;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', CHILD, command, JSON.stringify(payload)],
    { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 90_000 },
  );
  if (result.status !== 0) {
    throw new Error(`child ${command} (${host.locale}) failed: ${result.stderr || result.error?.message}`);
  }
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as ChildReport;
}

const tempDirs: string[] = [];
async function newDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dkg-digest-locale-e2e-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const quads = [...DIVERGENT_QUADS];

describe('the SWM public-quads digest across real host locales', () => {
  it('differs between locales for the legacy form, and not for the locale-independent one', () => {
    const en = run('digests', { quads }, { locale: EN });
    const da = run('digests', { quads }, { locale: DA });

    // Guard against a host whose ICU ignores the locale: without it the rest
    // of this file would pass vacuously.
    expect(en.locale).toBe('en-US');
    expect(da.locale).toBe('da-DK');
    expect(da.legacy).not.toBe(en.legacy);

    expect(en.codeUnit).toBe(CODE_UNIT_DIGEST);
    expect(da.codeUnit).toBe(CODE_UNIT_DIGEST);
    // Today's default: each node still writes its own-locale digest.
    expect(en.producer).toBe(en.legacy);
    expect(da.producer).toBe(da.legacy);
  });

  it('is identical everywhere once the operator opts into code-unit digests', () => {
    const en = run('digests', { quads }, { locale: EN, gate: 'code-unit' });
    const da = run('digests', { quads }, { locale: DA, gate: 'code-unit' });
    expect(en.producer).toBe(CODE_UNIT_DIGEST);
    expect(da.producer).toBe(CODE_UNIT_DIGEST);
  });

  it('writes the same snapshot file on every node once code-unit digests are on', async () => {
    const enDir = await newDir();
    const daDir = await newDir();
    const en = run('write', { dir: enDir, quads, form: 'producer' }, { locale: EN, gate: 'code-unit' });
    const da = run('write', { dir: daDir, quads, form: 'producer' }, { locale: DA, gate: 'code-unit' });
    expect(da.digest).toBe(en.digest);
    expect(da.files).toEqual(en.files);
    expect(en.files).toHaveLength(1);
  });

  it('lets an upgraded da-DK node validate and read what an en-US node persisted under its legacy digest', async () => {
    const dir = await newDir();
    const written = run('write', { dir, quads, form: 'legacy' }, { locale: EN });
    expect(written.digest).not.toBe(CODE_UNIT_DIGEST);

    const upgraded = run(
      'validate',
      { dir, ref: written.ref, digest: written.digest, count: quads.length },
      { locale: DA, gate: 'code-unit' },
    );
    expect(upgraded.valid).toBe(true);
    expect(upgraded.readable).toBe(true);
    expect(upgraded.readBack).toEqual(quads);
    // Nothing was renamed, rewritten or orphaned by the upgrade.
    expect(upgraded.files).toEqual(written.files);

    // The same holds for a da-DK node that has not opted in yet.
    const legacyDa = run(
      'validate',
      { dir, ref: written.ref, digest: written.digest, count: quads.length },
      { locale: DA },
    );
    expect(legacyDa.valid).toBe(true);
  });

  it('lets a legacy node on any locale validate and read a snapshot named by the code-unit digest', async () => {
    const dir = await newDir();
    const written = run('write', { dir, quads, form: 'code-unit' }, { locale: DA, gate: 'code-unit' });
    expect(written.digest).toBe(CODE_UNIT_DIGEST);
    for (const locale of [EN, DA]) {
      const legacy = run(
        'validate',
        { dir, ref: written.ref, digest: written.digest, count: quads.length },
        { locale },
      );
      expect(legacy.valid).toBe(true);
      expect(legacy.readBack).toEqual(quads);
    }
  });

  it('keeps a node reading its own legacy snapshots, in its own locale, across the gate flip', async () => {
    const dir = await newDir();
    const written = run('write', { dir, quads, form: 'legacy' }, { locale: DA });
    for (const gate of [undefined, 'code-unit'] as const) {
      const reader = run(
        'validate',
        { dir, ref: written.ref, digest: written.digest, count: quads.length },
        { locale: DA, ...(gate ? { gate } : {}) },
      );
      expect(reader.valid).toBe(true);
      expect(reader.files).toEqual(written.files);
    }
  });

  it('still rejects a snapshot whose digest names other content, in every locale', async () => {
    const dir = await newDir();
    // Same count, one object changed, stored under the ref of its own digest.
    const tampered = [{ ...quads[0]!, object: '"tampered"' }, ...quads.slice(1)];
    const written = run('write', { dir, quads: tampered, form: 'code-unit' }, { locale: EN, gate: 'code-unit' });
    for (const locale of [EN, DA]) {
      const verdict = run(
        'validate',
        { dir, ref: written.ref, digest: CODE_UNIT_DIGEST, count: quads.length },
        { locale, gate: 'code-unit' },
      );
      expect(verdict.valid).toBe(false);
    }
  });
});
