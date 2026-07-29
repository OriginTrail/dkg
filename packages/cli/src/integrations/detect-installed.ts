// Detects which registry integrations are present on this machine.
//
// Deliberately DERIVED rather than recorded. A ledger would say what we did;
// detection says what is true — it cannot go stale when a user upgrades a
// package by hand, deletes an MCP block, or installs on another machine. It is
// also the only honest option for `mcp`: installMcp writes nothing, it prints a
// config block for the user to paste, so a ledger entry would claim an install
// that may never have happened.
//
// Coverage matches what the installers actually do:
//   cli                     -> `npm ls -g` for install.package
//   service (npm-global)    -> `npm ls -g` for install.npmGlobal.package
//   mcp                     -> the client configs `dkg mcp setup` knows about,
//                              via detectClients() + readRegisteredServerKeys()
//   others                  -> undetectable; 'unknown', never 'not installed'
//
// The same rule applies to detection that FAILS rather than comes back empty:
// if `npm ls -g` cannot run, npm-installable entries report 'unknown', not
// 'not installed'. "We looked and it is absent" and "we could not look" are
// different answers and the output must not conflate them.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  detectClients,
  readRegisteredServerKeys,
  type ClientTarget,
  type ServerKeyProbe,
} from '../mcp-setup.js';
import type { IntegrationEntry } from './schema.js';

const execFileAsync = promisify(execFile);

export type InstalledState = 'installed' | 'not installed' | 'unknown';

export interface InstalledRow {
  slug: string;
  kind: string;
  state: InstalledState;
  /** Human-readable evidence: version found, or which client it is wired into. */
  detail: string;
}

/** Injectable so tests spawn no npm and touch no real config files. */
export interface DetectDeps {
  /** Resolves `null` when the probe could not run — NOT an empty map. */
  listGlobalNpm?: () => Promise<Record<string, string> | null>;
  /** Defaults to the same client targets `dkg mcp setup` registers into. */
  clients?: ClientTarget[];
  /**
   * Defaults to probing each client's registered server keys. Returns a
   * probe result, not a bare list, so "could not read this config" stays
   * distinguishable from "read it, nothing registered".
   */
  readServerKeys?: (target: ClientTarget) => ServerKeyProbe;
}

/**
 * `npm ls -g --json --depth=0` -> { packageName: version }.
 *
 * Resolves `null` when the probe could not run — npm missing from PATH, a
 * permissions error, or output we cannot parse. That is DELIBERATELY distinct
 * from `{}`: an empty map means "npm answered, and nothing is installed
 * globally", which is a real answer. Collapsing the two would make every
 * npm-installable entry read as "not installed" on a machine where we simply
 * failed to look — the exact false negative the three-state model prevents.
 */
async function listGlobalNpmPackages(): Promise<Record<string, string> | null> {
  try {
    // npm exits non-zero on extraneous/peer warnings while still emitting valid
    // JSON, so parse stdout regardless of exit code.
    const { stdout } = await execFileAsync('npm', ['ls', '--global', '--json', '--depth=0'], {
      maxBuffer: 8 * 1024 * 1024,
      shell: process.platform === 'win32',
    }).catch((err: { stdout?: string }) => ({ stdout: err?.stdout ?? '' }));
    return parseGlobalNpmList(stdout);
  } catch {
    return null;
  }
}

/**
 * Split out from the spawn so the failure-vs-empty distinction is testable
 * without mocking a child process. This is where the false negative would come
 * back if someone "simplified" a `null` return to `{}`, so it is covered
 * directly rather than only through an injected fake.
 *
 * `null` = we have no answer. `{}` = npm answered, nothing is installed.
 * A machine with no global packages still emits valid JSON (`{"dependencies":{}}`),
 * so empty stdout genuinely means the probe failed rather than came back empty.
 */
export function parseGlobalNpmList(stdout: string): Record<string, string> | null {
  if (!stdout.trim()) return null;
  try {
    const parsed = JSON.parse(stdout) as { dependencies?: Record<string, { version?: string }> };
    const out: Record<string, string> = {};
    for (const [name, meta] of Object.entries(parsed.dependencies ?? {})) {
      out[name] = meta?.version ?? '';
    }
    return out;
  } catch {
    return null;
  }
}

/** The npm package an entry installs globally, if any. */
function globalNpmPackageFor(
  install: IntegrationEntry['install'],
): { package: string; version: string } | null {
  if (install.kind === 'cli') {
    return { package: install.package, version: install.version };
  }
  // A service installed via npm-global lands in exactly the same place as a
  // cli install, so it is detectable the same way.
  if (install.kind === 'service' && install.runtime === 'npm-global' && install.npmGlobal) {
    return { package: install.npmGlobal.package, version: install.npmGlobal.version };
  }
  return null;
}

/**
 * Which of `entries` are present locally. Never claims 'not installed' for a
 * kind the CLI cannot detect — that is reported as 'unknown'.
 */
export async function detectInstalled(
  entries: IntegrationEntry[],
  deps: DetectDeps = {},
): Promise<InstalledRow[]> {
  const needsNpm = entries.some((e) => globalNpmPackageFor(e.install) !== null);
  const needsMcp = entries.some((e) => e.install.kind === 'mcp');

  const globals = needsNpm ? await (deps.listGlobalNpm ?? listGlobalNpmPackages)() : {};

  // slug -> the client(s) whose config registers a server under that name
  const wiredMcp = new Map<string, string[]>();
  // Configs we could not inspect. A slug absent from every readable config is
  // only genuinely absent if there were no unreadable ones — otherwise the
  // registration could be sitting in a file we failed to parse.
  const unreadableClients: string[] = [];
  if (needsMcp) {
    const clients = deps.clients ?? detectClients();
    const readKeys = deps.readServerKeys ?? readRegisteredServerKeys;
    for (const target of clients) {
      const probe = readKeys(target);
      if (!probe.ok) {
        unreadableClients.push(target.name);
        continue;
      }
      for (const key of probe.keys) {
        const list = wiredMcp.get(key) ?? [];
        if (!list.includes(target.name)) list.push(target.name);
        wiredMcp.set(key, list);
      }
    }
  }

  return entries.map((e): InstalledRow => {
    const npmPkg = globalNpmPackageFor(e.install);
    if (npmPkg) {
      // The probe failed, so we know nothing about this entry either way.
      // Reporting 'not installed' here would be a claim we cannot support.
      if (globals === null) {
        return {
          slug: e.slug,
          kind: e.install.kind,
          state: 'unknown',
          detail: 'could not inspect global npm packages',
        };
      }
      const found = globals[npmPkg.package];
      if (found === undefined) {
        return { slug: e.slug, kind: e.install.kind, state: 'not installed', detail: '' };
      }
      const drift = found && npmPkg.version && found !== npmPkg.version
        ? ` (registry pins ${npmPkg.version})`
        : '';
      return {
        slug: e.slug,
        kind: e.install.kind,
        state: 'installed',
        detail: `${npmPkg.package}@${found || '?'}${drift}`,
      };
    }

    if (e.install.kind === 'mcp') {
      // installMcp keys the server block on the entry slug, so that is what we
      // look for. Note this detects a config the USER pasted — the CLI never
      // writes it — hence "wired into", not "installed by".
      const clients = wiredMcp.get(e.slug);
      if (!clients?.length) {
        // Found in no readable config — but if some config was unreadable the
        // block could be sitting in it, so we cannot claim absence.
        if (unreadableClients.length > 0) {
          return {
            slug: e.slug,
            kind: 'mcp',
            state: 'unknown',
            detail: `could not inspect ${unreadableClients.join(', ')} config`,
          };
        }
        return { slug: e.slug, kind: 'mcp', state: 'not installed', detail: '' };
      }
      return {
        slug: e.slug,
        kind: 'mcp',
        state: 'installed',
        detail: `wired into ${clients.join(', ')}`,
      };
    }

    return {
      slug: e.slug,
      kind: e.install.kind,
      state: 'unknown',
      detail: 'the CLI does not perform this install kind',
    };
  });
}
