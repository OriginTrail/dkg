import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod, unlink, link } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { dkgDir } from "../config.js";

export const DASHBOARD_CREDENTIALS_FILENAME = "dashboard.credentials.json";
export const DEFAULT_DASHBOARD_USERNAME = "node-admin";

const PASSWORD_BYTES = 24;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: string,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export interface DashboardCredentialRecord {
  version: 1;
  username: string;
  password: {
    algorithm: "scrypt";
    salt: string;
    hash: string;
    keyLength: number;
    N: number;
    r: number;
    p: number;
    maxmem: number;
  };
  createdAt: string;
  updatedAt: string;
}

export type DashboardCredentialVerification =
  | { ok: true; username: string; credentialFingerprint: string }
  | { ok: false; reason: "missing" | "invalid" | "mismatch" };

export interface DashboardCredentialCreation {
  created: true;
  path: string;
  username: string;
  password: string;
}

export interface DashboardCredentialExisting {
  created: false;
  path: string;
  username: string;
}

export interface DashboardCredentialSummary {
  path: string;
  exists: boolean;
  username?: string;
  invalid?: boolean;
}

export function dashboardCredentialsPath(baseDir = dkgDir()): string {
  return join(baseDir, DASHBOARD_CREDENTIALS_FILENAME);
}

export function generateDashboardPassword(): string {
  return randomBytes(PASSWORD_BYTES).toString("base64url");
}

export async function createDashboardCredentialRecord(
  username = DEFAULT_DASHBOARD_USERNAME,
  password = generateDashboardPassword(),
  now = new Date(),
): Promise<DashboardCredentialRecord> {
  const normalizedUsername = normalizeUsername(username);
  const salt = randomBytes(16).toString("base64url");
  const hash = await scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  const timestamp = now.toISOString();
  return {
    version: 1,
    username: normalizedUsername,
    password: {
      algorithm: "scrypt",
      salt,
      hash: hash.toString("base64url"),
      keyLength: SCRYPT_KEY_LENGTH,
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function ensureDashboardCredentials(options: {
  path?: string;
  username?: string;
  password?: string;
} = {}): Promise<DashboardCredentialCreation | DashboardCredentialExisting> {
  const path = options.path ?? dashboardCredentialsPath();
  const existing = await readDashboardCredentialRecord(path);
  if (existing) {
    return { created: false, path, username: existing.username };
  }

  const password = options.password ?? generateDashboardPassword();
  const record = await createDashboardCredentialRecord(options.username, password);
  try {
    await writeDashboardCredentialRecord(record, path, { overwrite: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      const raced = await readDashboardCredentialRecord(path);
      if (raced) return { created: false, path, username: raced.username };
    }
    throw err;
  }
  return {
    created: true,
    path,
    username: record.username,
    password,
  };
}

export async function resetDashboardPassword(options: {
  path?: string;
  username?: string;
  password?: string;
} = {}): Promise<DashboardCredentialCreation> {
  const path = options.path ?? dashboardCredentialsPath();
  const password = options.password ?? generateDashboardPassword();
  const existing = await readDashboardCredentialRecord(path).catch((err) => {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && code !== "ENOENT") throw err;
    return null;
  });
  const record = await createDashboardCredentialRecord(
    options.username ?? existing?.username ?? DEFAULT_DASHBOARD_USERNAME,
    password,
  );
  await writeDashboardCredentialRecord(record, path);
  return {
    created: true,
    path,
    username: record.username,
    password,
  };
}

export async function verifyDashboardCredentials(
  username: string,
  password: string,
  path = dashboardCredentialsPath(),
): Promise<DashboardCredentialVerification> {
  let normalizedUsername: string;
  try {
    normalizedUsername = normalizeUsername(username);
  } catch {
    return { ok: false, reason: "mismatch" };
  }
  let credentialFile: DashboardCredentialFile | null;
  try {
    credentialFile = await readDashboardCredentialFile(path);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (!credentialFile) return { ok: false, reason: "missing" };
  const { record, fingerprint } = credentialFile;
  const stored = Buffer.from(record.password.hash, "base64url");
  let supplied: Buffer;
  try {
    // Keep username mismatches on the same memory-hard path as password mismatches.
    supplied = await scrypt(password, record.password.salt, record.password.keyLength, {
      N: record.password.N,
      r: record.password.r,
      p: record.password.p,
      maxmem: record.password.maxmem,
    });
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (normalizedUsername !== record.username) return { ok: false, reason: "mismatch" };
  if (stored.length !== supplied.length || !timingSafeEqual(stored, supplied)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true, username: record.username, credentialFingerprint: fingerprint };
}

export async function readDashboardCredentialSummary(
  path = dashboardCredentialsPath(),
): Promise<DashboardCredentialSummary> {
  try {
    const record = await readDashboardCredentialRecord(path);
    if (!record) return { path, exists: false };
    return { path, exists: true, username: record.username };
  } catch {
    return { path, exists: true, invalid: true };
  }
}

export async function readDashboardCredentialRecord(
  path = dashboardCredentialsPath(),
): Promise<DashboardCredentialRecord | null> {
  const credentialFile = await readDashboardCredentialFile(path);
  return credentialFile?.record ?? null;
}

export function readDashboardCredentialFingerprintSync(path = dashboardCredentialsPath()): string | null {
  try {
    return fingerprintCredentialBytes(readFileSync(path));
  } catch {
    return null;
  }
}

interface DashboardCredentialFile {
  record: DashboardCredentialRecord;
  fingerprint: string;
}

async function readDashboardCredentialFile(path: string): Promise<DashboardCredentialFile | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!isDashboardCredentialRecord(parsed)) {
    throw new Error(`Invalid dashboard credential file: ${path}`);
  }
  return {
    record: parsed,
    fingerprint: fingerprintCredentialBytes(raw),
  };
}

async function writeDashboardCredentialRecord(
  record: DashboardCredentialRecord,
  path: string,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await chmod(tempPath, 0o600).catch(() => undefined);
    if (options.overwrite === false) {
      await link(tempPath, path);
      await unlink(tempPath).catch(() => undefined);
    } else {
      await rename(tempPath, path);
    }
    await chmod(path, 0o600).catch(() => undefined);
  } catch (err) {
    await unlink(tempPath).catch(() => undefined);
    throw err;
  }
}

function normalizeUsername(username: string | undefined): string {
  const normalized = username?.trim() || DEFAULT_DASHBOARD_USERNAME;
  if (normalized.length > 128) throw new Error("Dashboard username is too long");
  return normalized;
}

function isDashboardCredentialRecord(value: unknown): value is DashboardCredentialRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as DashboardCredentialRecord;
  return record.version === 1 &&
    typeof record.username === "string" &&
    record.username.length > 0 &&
    !!record.password &&
    record.password.algorithm === "scrypt" &&
    typeof record.password.salt === "string" &&
    typeof record.password.hash === "string" &&
    typeof record.password.keyLength === "number" &&
    typeof record.password.N === "number" &&
    typeof record.password.r === "number" &&
    typeof record.password.p === "number" &&
    typeof record.password.maxmem === "number" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string";
}

function fingerprintCredentialBytes(raw: string | Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}
