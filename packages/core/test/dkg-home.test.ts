import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { dkgHomeDir, isProcessAlive, readDaemonPid, readDkgApiPort, loadAuthToken, loadAuthTokenSync } from '../src/dkg-home.js';

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
