import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFile, mkdir, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { dkgHomeDir, resolveDkgConfigHome, dkgAuthTokenPath, resolveDkgHome, isProcessAlive, readDaemonPid, readDkgApiPort, loadAuthToken, loadAuthTokenSync, loadAgentAuthTokenSync, loadAgentAuthToken, MultipleAgentsError, toEip55Checksum } from '../src/dkg-home.js';

describe('dkgHomeDir', () => {
  const originalEnv = process.env.DKG_HOME;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = originalEnv;
  });

  it('returns $DKG_HOME when set', () => {
    process.env.DKG_HOME = '/custom/path';
    expect(dkgHomeDir()).toBe('/custom/path');
  });

  it('defaults to ~/.dkg', () => {
    delete process.env.DKG_HOME;
    expect(dkgHomeDir()).toBe(join(homedir(), '.dkg'));
  });
});

describe('resolveDkgConfigHome', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = join(tmpdir(), `dkg-config-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it('DKG_HOME wins over monorepo and config-file heuristics', () => {
    expect(resolveDkgConfigHome({
      env: { DKG_HOME: '/custom/dkg-home' },
      homeDir: tempHome,
      isDkgMonorepo: true,
      configExists: false,
    })).toBe('/custom/dkg-home');
  });

  it('treats an injected empty env as DKG_HOME unset', () => {
    const originalDkgHome = process.env.DKG_HOME;
    process.env.DKG_HOME = '/process/dkg-home';
    try {
      expect(resolveDkgConfigHome({
        env: {},
        homeDir: tempHome,
        isDkgMonorepo: true,
        configExists: false,
      })).toBe(join(tempHome, '.dkg-dev'));
    } finally {
      if (originalDkgHome === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = originalDkgHome;
    }
  });

  it('uses ~/.dkg-dev in a monorepo when ~/.dkg/config.json does not exist', () => {
    expect(resolveDkgConfigHome({
      env: {},
      homeDir: tempHome,
      isDkgMonorepo: true,
      configExists: false,
    })).toBe(join(tempHome, '.dkg-dev'));
  });

  it('uses ~/.dkg in a monorepo when ~/.dkg/config.json already exists', () => {
    expect(resolveDkgConfigHome({
      env: {},
      homeDir: tempHome,
      isDkgMonorepo: true,
      configExists: true,
    })).toBe(join(tempHome, '.dkg'));
  });

  it('uses ~/.dkg outside a monorepo', () => {
    expect(resolveDkgConfigHome({
      env: {},
      homeDir: tempHome,
      isDkgMonorepo: false,
      configExists: false,
    })).toBe(join(tempHome, '.dkg'));
  });
});

describe('dkgAuthTokenPath', () => {
  it('formats the auth-token path from the resolved DKG home', () => {
    expect(dkgAuthTokenPath('/tmp/dkg-home')).toBe(join('/tmp/dkg-home', 'auth.token'));
  });

  it('defaults through the config-home resolver', async () => {
    const original = {
      DKG_HOME: process.env.DKG_HOME,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
    };
    const tempHome = join(tmpdir(), `dkg-auth-token-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempHome, { recursive: true });
    delete process.env.DKG_HOME;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    try {
      expect(dkgAuthTokenPath()).toBe(join(tempHome, '.dkg-dev', 'auth.token'));
    } finally {
      if (original.DKG_HOME === undefined) delete process.env.DKG_HOME;
      else process.env.DKG_HOME = original.DKG_HOME;
      if (original.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = original.HOME;
      if (original.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = original.USERPROFILE;
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});

describe('resolveDkgHome', () => {
  // Redirects `homedir()` into a tmp dir by overriding HOME / USERPROFILE so
  // we can populate `.dkg/` and `.dkg-dev/` under our control. The "alive"
  // pid is the test runner's own pid (always alive); the "dead" pid is a
  // very-large integer extremely unlikely to map to a real process.
  const ALIVE = process.pid;
  const DEAD = 999_999_999;

  let tempHome: string;
  let dkg: string;
  let dkgDev: string;
  const original = {
    DKG_HOME: process.env.DKG_HOME,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };

  beforeEach(async () => {
    tempHome = join(tmpdir(), `dkg-resolve-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    dkg = join(tempHome, '.dkg');
    dkgDev = join(tempHome, '.dkg-dev');
    await mkdir(dkg, { recursive: true });
    await mkdir(dkgDev, { recursive: true });

    delete process.env.DKG_HOME;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome; // Windows
  });

  afterEach(async () => {
    if (original.DKG_HOME === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = original.DKG_HOME;
    if (original.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = original.HOME;
    if (original.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = original.USERPROFILE;
    await rm(tempHome, { recursive: true, force: true });
  });

  async function writePid(home: string, pid: number) {
    await writeFile(join(home, 'daemon.pid'), String(pid));
  }
  async function writePort(home: string, port: number, mtimeOverride?: Date) {
    const path = join(home, 'api.port');
    await writeFile(path, String(port));
    if (mtimeOverride) await utimes(path, mtimeOverride, mtimeOverride);
  }

  it('1) DKG_HOME env wins, regardless of pid/port files', async () => {
    process.env.DKG_HOME = '/explicit/override';
    await writePid(dkg, ALIVE);
    await writePid(dkgDev, ALIVE);
    expect(resolveDkgHome({ daemonUrl: 'http://127.0.0.1:9200' })).toBe('/explicit/override');
  });

  it('2) ~/.dkg pid alive and ~/.dkg-dev pid dead → returns ~/.dkg', async () => {
    await writePid(dkg, ALIVE);
    await writePid(dkgDev, DEAD);
    expect(resolveDkgHome()).toBe(dkg);
  });

  it('3) ~/.dkg-dev pid alive and ~/.dkg pid dead → returns ~/.dkg-dev', async () => {
    await writePid(dkg, DEAD);
    await writePid(dkgDev, ALIVE);
    expect(resolveDkgHome()).toBe(dkgDev);
  });

  it("4) both folders on disk with stale state; only one daemon currently alive → resolves to the live one (user's monorepo↔npm switch scenario)", async () => {
    // Simulates: developer ran the npm daemon previously (left ~/.dkg with
    // stale pid + stale api.port), then switched to monorepo; now only the
    // monorepo daemon is running.
    await writePid(dkg, DEAD);              // stale npm-side pid
    await writePort(dkg, 9200);             // stale npm-side port
    await writePid(dkgDev, ALIVE);          // currently-running monorepo daemon
    await writePort(dkgDev, 9200);          // monorepo daemon also bound 9200
    expect(resolveDkgHome({ daemonUrl: 'http://127.0.0.1:9200' })).toBe(dkgDev);
  });

  it('5) both pids alive, daemonUrl port matches ~/.dkg-dev/api.port → returns ~/.dkg-dev', async () => {
    await writePid(dkg, ALIVE);
    await writePid(dkgDev, ALIVE);
    await writePort(dkg, 9200);
    await writePort(dkgDev, 9201);
    expect(resolveDkgHome({ daemonUrl: 'http://127.0.0.1:9201' })).toBe(dkgDev);
  });

  it('6) both pids alive, daemonUrl port matches ~/.dkg/api.port → returns ~/.dkg', async () => {
    await writePid(dkg, ALIVE);
    await writePid(dkgDev, ALIVE);
    await writePort(dkg, 9200);
    await writePort(dkgDev, 9201);
    expect(resolveDkgHome({ daemonUrl: 'http://127.0.0.1:9200' })).toBe(dkg);
  });

  it('7) both pids dead, ~/.dkg-dev/api.port is more recent → returns ~/.dkg-dev (cold-start mtime tiebreak)', async () => {
    await writePid(dkg, DEAD);
    await writePid(dkgDev, DEAD);
    const old = new Date(Date.now() - 60_000); // 1 minute ago
    const fresh = new Date();                  // now
    await writePort(dkg, 9200, old);
    await writePort(dkgDev, 9200, fresh);
    expect(resolveDkgHome({ daemonUrl: 'http://127.0.0.1:9200' })).toBe(dkgDev);
  });

  it('8) both pids dead, ~/.dkg/api.port is more recent → returns ~/.dkg', async () => {
    await writePid(dkg, DEAD);
    await writePid(dkgDev, DEAD);
    const old = new Date(Date.now() - 60_000);
    const fresh = new Date();
    await writePort(dkg, 9200, fresh);
    await writePort(dkgDev, 9200, old);
    expect(resolveDkgHome({ daemonUrl: 'http://127.0.0.1:9200' })).toBe(dkg);
  });

  it('9) nothing exists at all (fresh install) → returns ~/.dkg', async () => {
    // Both dirs are present (created in beforeEach) but contain no pid/port files.
    expect(resolveDkgHome()).toBe(dkg);
  });

  it('9b) neither ~/.dkg nor ~/.dkg-dev exist on disk at all → returns ~/.dkg without crashing', async () => {
    // Cheap defensive coverage (per QA T70 review): a brand-new account
    // where neither directory has been created yet. All sync fs reads
    // must return null cleanly (no ENOENT throw escaping). Resolver
    // falls through every step and returns the default ~/.dkg.
    await rm(dkg, { recursive: true, force: true });
    await rm(dkgDev, { recursive: true, force: true });
    expect(resolveDkgHome({ daemonUrl: 'http://127.0.0.1:9200' })).toBe(dkg);
  });

  it('10) liveness-only signal: no daemonUrl provided, only one pid alive → returns the live dir', async () => {
    await writePid(dkg, DEAD);
    await writePid(dkgDev, ALIVE);
    expect(resolveDkgHome()).toBe(dkgDev);
  });

  it("T72 — cold start, both pids dead, daemonUrl matches ~/.dkg's stale api.port → returns ~/.dkg even when ~/.dkg-dev/api.port is more recent", async () => {
    // Codex T72: previously the cold-start branch ignored daemonUrl and
    // fell back to mtime alone. If the freshest api.port belonged to a
    // DIFFERENT daemon than the one daemonUrl is configured for, the
    // adapter would cache the wrong auth.token for its lifetime.
    // Concrete scenario: user ran monorepo daemon yesterday at 9200,
    // today the gateway is configured for the npm daemon at 9201 (which
    // hasn't started yet).
    await writePid(dkg, DEAD);
    await writePid(dkgDev, DEAD);
    const fresh = new Date();
    const old = new Date(Date.now() - 60_000);
    await writePort(dkgDev, 9200, fresh); // monorepo daemon, more recent
    await writePort(dkg, 9201, old);       // npm daemon, older but matches daemonUrl
    expect(resolveDkgHome({ daemonUrl: 'http://127.0.0.1:9201' })).toBe(dkg);
  });

  it("T72 — cold start, both pids dead, daemonUrl matches ~/.dkg-dev's stale api.port → returns ~/.dkg-dev even when ~/.dkg/api.port is more recent", async () => {
    await writePid(dkg, DEAD);
    await writePid(dkgDev, DEAD);
    const fresh = new Date();
    const old = new Date(Date.now() - 60_000);
    await writePort(dkg, 9201, fresh);    // npm daemon, more recent
    await writePort(dkgDev, 9200, old);   // monorepo daemon, older but matches daemonUrl
    expect(resolveDkgHome({ daemonUrl: 'http://127.0.0.1:9200' })).toBe(dkgDev);
  });

  it("T73 — PID reuse: stale daemon.pid recycled to an unrelated process loses to the port-match check (different ports)", async () => {
    // Codex T73: process.kill(pid, 0) only proves SOME process owns that
    // PID. After daemon crash + OS PID recycling, a stale daemon.pid
    // points to an unrelated alive process (firefox, systemd, anything).
    // With bare liveness alone, that home wrongly wins step 1 and beats
    // the later port-match step.
    //
    // The combined check (alive + port match) closes that gap: the
    // recycled-PID home passes alive but fails the port match (since
    // its api.port is for a different daemon than daemonUrl points at),
    // so it's not authoritative at step 1. Step 2's port-match alone
    // then picks the actually-correct home.
    //
    // Setup: dkgDev's daemon.pid is "alive" (using ALIVE = process.pid
    // as the recycled-PID surrogate; in production this would be an
    // unrelated process at the recycled PID), but its api.port=9200
    // doesn't match daemonUrl=9201. dkg has matching api.port=9201
    // but no live PID — that's the home daemonUrl is configured for.
    await writePid(dkgDev, ALIVE);  // recycled-PID "alive"
    await writePort(dkgDev, 9200);  // stale port from old daemon
    await writePid(dkg, DEAD);
    await writePort(dkg, 9201);     // matches daemonUrl
    expect(resolveDkgHome({ daemonUrl: 'http://127.0.0.1:9201' })).toBe(dkg);
  });

  it("T73 — documented tradeoff: recycled-PID with NO api.port file still wins step 1 over dead+matching home (narrow startup-race relaxation)", async () => {
    // Locks in the documented relaxation: at step 1, a home with a live
    // PID and an ABSENT api.port file is treated as authoritative
    // ("startup race" — daemon wrote pid before binding HTTP). This
    // means a recycled PID in an empty home dir (genuinely orphaned —
    // someone deleted api.port but left daemon.pid) still wins over a
    // home with a stale-but-matching api.port whose daemon is dead.
    //
    // Acceptable because: (a) real daemons always write api.port after
    // binding HTTP, so a "no api.port" recycled-PID home is contrived;
    // (b) tightening this would break the legitimate startup-race case;
    // (c) the full fix would require an async HTTP probe, out of scope.
    //
    // This test pins the behavior so future refactors don't accidentally
    // change it thinking they're closing a real gap.
    await writePid(dkgDev, ALIVE);    // recycled-PID, no port file
    // (no port file in dkgDev — that's the contrived state)
    await writePid(dkg, DEAD);
    await writePort(dkg, 9201);       // dead daemon's port file matches daemonUrl
    expect(resolveDkgHome({ daemonUrl: 'http://127.0.0.1:9201' })).toBe(dkgDev);
  });

  it('T72 — both pids dead, both api.port files have the same port (ambiguous) → falls back to mtime tiebreak', async () => {
    // When both homes have the same api.port written (typical when an
    // operator alternates npm and monorepo daemons that both default to
    // 9200), the port match is ambiguous. Resolver falls through to
    // mtime so the most recently active home wins.
    await writePid(dkg, DEAD);
    await writePid(dkgDev, DEAD);
    const fresh = new Date();
    const old = new Date(Date.now() - 60_000);
    await writePort(dkg, 9200, fresh);
    await writePort(dkgDev, 9200, old);
    expect(resolveDkgHome({ daemonUrl: 'http://127.0.0.1:9200' })).toBe(dkg);
  });
});

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for a non-existent PID', () => {
    expect(isProcessAlive(999999999)).toBe(false);
  });
});

describe('readDaemonPid', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `dkg-test-pid-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads a valid PID from file', async () => {
    await writeFile(join(tempDir, 'daemon.pid'), '12345');
    expect(await readDaemonPid(tempDir)).toBe(12345);
  });

  it('returns null for non-numeric content', async () => {
    await writeFile(join(tempDir, 'daemon.pid'), 'abc');
    expect(await readDaemonPid(tempDir)).toBeNull();
  });

  it('returns null for partial numeric content like "123abc"', async () => {
    await writeFile(join(tempDir, 'daemon.pid'), '123abc');
    expect(await readDaemonPid(tempDir)).toBeNull();
  });

  it('returns null when file does not exist', async () => {
    expect(await readDaemonPid(tempDir)).toBeNull();
  });

  it('returns null for empty file', async () => {
    await writeFile(join(tempDir, 'daemon.pid'), '');
    expect(await readDaemonPid(tempDir)).toBeNull();
  });

  it('returns null for hex notation like "0x1234"', async () => {
    await writeFile(join(tempDir, 'daemon.pid'), '0x1234');
    expect(await readDaemonPid(tempDir)).toBeNull();
  });

  it('returns null for scientific notation like "1e3"', async () => {
    await writeFile(join(tempDir, 'daemon.pid'), '1e3');
    expect(await readDaemonPid(tempDir)).toBeNull();
  });

  it('returns null for "0"', async () => {
    await writeFile(join(tempDir, 'daemon.pid'), '0');
    expect(await readDaemonPid(tempDir)).toBeNull();
  });
});

describe('readDkgApiPort', () => {
  let tempDir: string;
  const originalEnv = process.env.DKG_API_PORT;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `dkg-test-port-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    delete process.env.DKG_API_PORT;
  });

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env.DKG_API_PORT;
    else process.env.DKG_API_PORT = originalEnv;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('prefers $DKG_API_PORT over file', async () => {
    process.env.DKG_API_PORT = '8888';
    await writeFile(join(tempDir, 'api.port'), '9200');
    expect(await readDkgApiPort(tempDir)).toBe(8888);
  });

  it('reads port from file when env is not set', async () => {
    await writeFile(join(tempDir, 'api.port'), '9200');
    expect(await readDkgApiPort(tempDir)).toBe(9200);
  });

  it('returns null for invalid env value', async () => {
    process.env.DKG_API_PORT = 'notanumber';
    expect(await readDkgApiPort(tempDir)).toBeNull();
  });

  it('returns null for out-of-range port', async () => {
    process.env.DKG_API_PORT = '99999';
    expect(await readDkgApiPort(tempDir)).toBeNull();
  });

  it('returns null for port 0', async () => {
    process.env.DKG_API_PORT = '0';
    expect(await readDkgApiPort(tempDir)).toBeNull();
  });

  it('does NOT fall through to file when env is set but invalid', async () => {
    process.env.DKG_API_PORT = 'invalid';
    await writeFile(join(tempDir, 'api.port'), '9200');
    expect(await readDkgApiPort(tempDir)).toBeNull();
  });

  it('does NOT fall through to file when env is whitespace-only', async () => {
    process.env.DKG_API_PORT = '   ';
    await writeFile(join(tempDir, 'api.port'), '9200');
    expect(await readDkgApiPort(tempDir)).toBeNull();
  });

  it('does NOT fall through to file when env is empty string', async () => {
    process.env.DKG_API_PORT = '';
    await writeFile(join(tempDir, 'api.port'), '9200');
    expect(await readDkgApiPort(tempDir)).toBeNull();
  });

  it('rejects hex port like "0x2390"', async () => {
    process.env.DKG_API_PORT = '0x2390';
    expect(await readDkgApiPort(tempDir)).toBeNull();
  });

  it('rejects scientific notation like "1e3"', async () => {
    process.env.DKG_API_PORT = '1e3';
    expect(await readDkgApiPort(tempDir)).toBeNull();
  });

  it('returns null when neither env nor file exist', async () => {
    expect(await readDkgApiPort(tempDir)).toBeNull();
  });
});

describe('loadAuthToken / loadAuthTokenSync', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `dkg-test-token-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads a token from file', async () => {
    await writeFile(join(tempDir, 'auth.token'), 'my-secret-token\n');
    expect(await loadAuthToken(tempDir)).toBe('my-secret-token');
    expect(loadAuthTokenSync(tempDir)).toBe('my-secret-token');
  });

  it('skips comment lines and blank lines', async () => {
    await writeFile(join(tempDir, 'auth.token'), '# comment\n\n  \nactual-token\n');
    expect(await loadAuthToken(tempDir)).toBe('actual-token');
    expect(loadAuthTokenSync(tempDir)).toBe('actual-token');
  });

  it('returns undefined when file does not exist', async () => {
    expect(await loadAuthToken(tempDir)).toBeUndefined();
    expect(loadAuthTokenSync(tempDir)).toBeUndefined();
  });

  it('returns undefined for file with only comments', async () => {
    await writeFile(join(tempDir, 'auth.token'), '# comment only\n');
    expect(await loadAuthToken(tempDir)).toBeUndefined();
    expect(loadAuthTokenSync(tempDir)).toBeUndefined();
  });
});

describe('loadAgentAuthToken / loadAgentAuthTokenSync (T63/T64/T67)', () => {
  let tempDir: string;
  // T63 — Helpers return a discriminated `KeystoreAuthTokenResult`. Test
  // fixtures are LOWERCASE keystore JSON keys (the standard form the daemon
  // writes); explicit-address inputs to the helper are lowercased for
  // case-insensitive matching against keystore keys.
  const ETH_A = '0x26c9b05a30138b35e84e60a5b778d580065ffbb8';
  const ETH_B = '0x949ec97ab4ed1c9fb4c9a70c2dd368065d817b0c';

  beforeEach(async () => {
    tempDir = join(tmpdir(), `dkg-test-keystore-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns the single agent auth token from a single-agent keystore (sync + async)', async () => {
    await writeFile(
      join(tempDir, 'agent-keystore.json'),
      JSON.stringify({ [ETH_A]: { authToken: 'tok-a', privateKey: '0xpk' } }),
    );
    expect(loadAgentAuthTokenSync(tempDir)).toEqual({ kind: 'token', authToken: 'tok-a' });
    expect(await loadAgentAuthToken(tempDir)).toEqual({ kind: 'token', authToken: 'tok-a' });
  });

  it('returns kind=absent when keystore file does not exist', async () => {
    expect(loadAgentAuthTokenSync(tempDir)).toEqual({ kind: 'absent' });
    expect(await loadAgentAuthToken(tempDir)).toEqual({ kind: 'absent' });
  });

  it('returns kind=absent for an empty object keystore (legitimate "no agent yet" — peerId fallback OK)', async () => {
    await writeFile(join(tempDir, 'agent-keystore.json'), '{}');
    expect(loadAgentAuthTokenSync(tempDir)).toEqual({ kind: 'absent' });
  });

  it('returns kind=absent for keystore with only non-eth-shaped keys', async () => {
    await writeFile(
      join(tempDir, 'agent-keystore.json'),
      JSON.stringify({ 'not-an-eth-key': { authToken: 'tok' }, '12D3KooWPeerLike': {} }),
    );
    // Same end-state semantically as missing file — daemon would also see
    // no usable agent and write under peerId.
    expect(loadAgentAuthTokenSync(tempDir)).toEqual({ kind: 'absent' });
  });

  it('returns kind=unusable for malformed JSON (T64 — TRANSIENT, do NOT trigger peerId fallback)', async () => {
    await writeFile(join(tempDir, 'agent-keystore.json'), '{ this is not json');
    expect(loadAgentAuthTokenSync(tempDir)).toEqual({ kind: 'unusable' });
    expect(await loadAgentAuthToken(tempDir)).toEqual({ kind: 'unusable' });
  });

  it('returns kind=unusable when the matched entry is missing the authToken field (T64)', async () => {
    // Malformed entry — eth key present but no authToken. Could be operator
    // mid-write or genuinely broken; either way, NOT "no keystore".
    await writeFile(
      join(tempDir, 'agent-keystore.json'),
      JSON.stringify({ [ETH_A]: { privateKey: '0xpk' } }),
    );
    expect(loadAgentAuthTokenSync(tempDir)).toEqual({ kind: 'unusable' });
  });

  it('returns kind=unusable when authToken field is empty string (T64)', async () => {
    await writeFile(
      join(tempDir, 'agent-keystore.json'),
      JSON.stringify({ [ETH_A]: { authToken: '' } }),
    );
    expect(loadAgentAuthTokenSync(tempDir)).toEqual({ kind: 'unusable' });
  });

  it('throws MultipleAgentsError when keystore has multiple eth keys and no explicit override', async () => {
    await writeFile(
      join(tempDir, 'agent-keystore.json'),
      JSON.stringify({ [ETH_A]: { authToken: 'a' }, [ETH_B]: { authToken: 'b' } }),
    );
    expect(() => loadAgentAuthTokenSync(tempDir)).toThrow(MultipleAgentsError);
    await expect(loadAgentAuthToken(tempDir)).rejects.toBeInstanceOf(MultipleAgentsError);
  });

  it('explicit override disambiguates a multi-agent keystore (case-insensitive match)', async () => {
    await writeFile(
      join(tempDir, 'agent-keystore.json'),
      JSON.stringify({ [ETH_A]: { authToken: 'tok-a' }, [ETH_B]: { authToken: 'tok-b' } }),
    );
    // Lowercase input.
    expect(
      loadAgentAuthTokenSync(tempDir, { explicitAddress: ETH_B }),
    ).toEqual({ kind: 'token', authToken: 'tok-b' });
    // Mixed-case input — same result.
    expect(
      loadAgentAuthTokenSync(tempDir, { explicitAddress: '0x949eC97aB4eD1C9fb4C9A70C2dD368065d817B0c' }),
    ).toEqual({ kind: 'token', authToken: 'tok-b' });
    // All-caps input — same result.
    expect(
      loadAgentAuthTokenSync(tempDir, { explicitAddress: ETH_B.toUpperCase() }),
    ).toEqual({ kind: 'token', authToken: 'tok-b' });
  });

  it('explicit override that does not match any keystore entry throws MultipleAgentsError', async () => {
    await writeFile(
      join(tempDir, 'agent-keystore.json'),
      JSON.stringify({ [ETH_A]: { authToken: 'a' }, [ETH_B]: { authToken: 'b' } }),
    );
    // Valid eth address, but no entry — refuse to silently fall back.
    expect(() => loadAgentAuthTokenSync(tempDir, {
      explicitAddress: '0x1111111111111111111111111111111111111111',
    })).toThrow(MultipleAgentsError);
  });

  it('explicit override is ignored on a single-agent keystore (override only matters when disambiguating)', async () => {
    await writeFile(
      join(tempDir, 'agent-keystore.json'),
      JSON.stringify({ [ETH_A]: { authToken: 'only-tok' } }),
    );
    // The single-agent path always returns the only entry's token, regardless
    // of any explicit override (override is for multi-agent disambiguation only).
    expect(
      loadAgentAuthTokenSync(tempDir, { explicitAddress: ETH_B }),
    ).toEqual({ kind: 'token', authToken: 'only-tok' });
  });

  it('T46 — dedupes same address recorded in both checksum AND lowercase form (single-agent, not multi)', async () => {
    const checksumA = '0x26C9B05A30138b35E84E60A5b778d580065FFBB8';
    const lowercase = ETH_A;
    await writeFile(
      join(tempDir, 'agent-keystore.json'),
      JSON.stringify({ [checksumA]: { authToken: 'a' }, [lowercase]: { authToken: 'b' } }),
    );
    // Dedupe collapses them to one identity. Either entry's `authToken` is
    // acceptable because `Object.entries` ordering is engine-defined; we just
    // need to confirm a token returns and no `MultipleAgentsError`.
    const result = loadAgentAuthTokenSync(tempDir);
    expect(result.kind).toBe('token');
    if (result.kind === 'token') {
      expect(['a', 'b']).toContain(result.authToken);
    }
  });

  it('T67 — returns the usable authToken when one duplicate is malformed and another has the token', async () => {
    // Two case variants of the SAME identity. First entry malformed (no
    // authToken), second entry usable. Pre-fix the helper picked the first
    // raw match and returned undefined; post-fix it scans all matches and
    // returns the first usable token.
    const checksumA = '0x26C9B05A30138b35E84E60A5b778d580065FFBB8';
    const lowercase = ETH_A;
    await writeFile(
      join(tempDir, 'agent-keystore.json'),
      // First entry: malformed (no authToken); second entry: usable.
      JSON.stringify({ [checksumA]: { privateKey: '0xpk' }, [lowercase]: { authToken: 'usable-tok' } }),
    );
    expect(loadAgentAuthTokenSync(tempDir)).toEqual({ kind: 'token', authToken: 'usable-tok' });

    // Reverse order — usable first, malformed second. Should still pick usable.
    await writeFile(
      join(tempDir, 'agent-keystore.json'),
      JSON.stringify({ [checksumA]: { authToken: 'usable-tok' }, [lowercase]: { privateKey: '0xpk' } }),
    );
    expect(loadAgentAuthTokenSync(tempDir)).toEqual({ kind: 'token', authToken: 'usable-tok' });

    // Both malformed → kind=unusable.
    await writeFile(
      join(tempDir, 'agent-keystore.json'),
      JSON.stringify({ [checksumA]: { privateKey: '0xpk' }, [lowercase]: { authToken: '' } }),
    );
    expect(loadAgentAuthTokenSync(tempDir)).toEqual({ kind: 'unusable' });
  });

  it('T62 / T63 — toEip55Checksum produces canonical EIP-55 form for known vectors', () => {
    // Helper retained narrowly for `DKG_AGENT_ADDRESS` env-override
    // normalization on remote-daemon paths. Spec-vector validation stays so
    // a future refactor can't silently break it.
    expect(toEip55Checksum('0x52908400098527886e0f7030069857d2e4169ee7'))
      .toBe('0x52908400098527886E0F7030069857D2E4169EE7');
    expect(toEip55Checksum('0x8617e340b3d01fa5f11f306f4090fd50e238070d'))
      .toBe('0x8617E340B3D01FA5F11F306F4090FD50E238070D');
    expect(toEip55Checksum('0xde709f2102306220921060314715629080e2fb77'))
      .toBe('0xde709f2102306220921060314715629080e2fb77');
    expect(toEip55Checksum('0x27b1fdb04752bbc536007a920d24acb045561c26'))
      .toBe('0x27b1fdb04752bbc536007a920d24acb045561c26');
    expect(toEip55Checksum('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'))
      .toBe('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    expect(toEip55Checksum('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359'))
      .toBe('0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359');
    // Round-trip: checksumming a checksum value yields the same string.
    const checksumA = toEip55Checksum(ETH_A);
    expect(toEip55Checksum(checksumA)).toBe(checksumA);
    // Throws on bad input shape.
    expect(() => toEip55Checksum('not-an-address')).toThrow();
    expect(() => toEip55Checksum('0x123')).toThrow();
  });
});
