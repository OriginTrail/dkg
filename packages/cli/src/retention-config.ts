/**
 * Retention settings of the two async queues (OT-RFC-73 P10b, D-6): the `queueRetention` section of config.json.
 *
 *   "queueRetention": {
 *     "share":     { "mode": "off", "intervalMs": 60000, "batchSize": 100, "succeededMaxAgeMs": 604800000, "benignFailedMaxAgeMs": 604800000, "rescanIntervalMs": 3600000 },
 *     "publisher": { "mode": "off", "intervalMs": 60000, "batchSize": 100, "finalizedMaxAgeMs": 604800000 }
 *   }
 *
 * Every key is optional and the mode of both queues defaults to `off`: an absent section deletes and judges nothing. The share section drives the sweep built in
 * daemon/retention-share-sweep.ts; the publisher section is declared here so its keys are validated from the start, but no publisher sweep exists yet (P11 registers
 * it in daemon/retention-sweeps.ts and adds its own keys to this module, with no further change to config.ts or the daemon lifecycle).
 *
 * Validation is loud. `resolveRetentionConfig` collects every problem and throws one `RetentionConfigError` that names each offending key; there is no silent
 * fallback to a default for a value that was written but is wrong, and an unknown key (a typo such as `queueRetention.share.mod`) is an error too, because ignoring
 * it would leave the node on the default `off` while the operator believes it is not. The bounds that the share core enforces (a batch of at most 1,000 rows,
 * windows of at least 24 hours) are taken from the core's own constants, so the two cannot drift apart.
 */
import { SHARE_RETENTION_DEFAULTS, SHARE_RETENTION_MODES, SHARE_RETENTION_WINDOW_MS, type ShareRetentionMode } from '@origintrail-official/dkg-publisher';

/** `off` does nothing, `report` judges and counts what `delete` would remove and removes nothing, `delete` removes it (only through the plan's delete gate). */
export type RetentionMode = ShareRetentionMode;
export type ActiveRetentionMode = Exclude<RetentionMode, 'off'>;
export const RETENTION_MODES: readonly RetentionMode[] = SHARE_RETENTION_MODES;

/** Bounds and defaults. The window is the D-6 7 days on both queues; its floor, the batch cap and the rescan default are the share core's. */
export const RETENTION_DEFAULTS = Object.freeze({
  mode: 'off' as RetentionMode,
  /** The pause between two ticks of a sweep. The core's clock guard tolerates `clockGuardFactor` (3) of these between two ticks that ran. */
  intervalMs: 60_000,
  minIntervalMs: 1_000,
  maxIntervalMs: 3_600_000,
  /** Rows one tick judges at most (a larger backlog drains over several ticks). */
  batchSize: SHARE_RETENTION_DEFAULTS.batchSize,
  maxBatchSize: SHARE_RETENTION_DEFAULTS.maxBatchSize,
  /** D-6: a deletable job leaves 7 days after it finished. */
  windowMs: SHARE_RETENTION_WINDOW_MS,
  minWindowMs: SHARE_RETENTION_DEFAULTS.minWindowMs,
  /** Share only: how often a finished pass starts again from the oldest row. */
  rescanIntervalMs: SHARE_RETENTION_DEFAULTS.rescanIntervalMs,
  minRescanIntervalMs: 60_000,
  maxRescanIntervalMs: 7 * 24 * 3_600_000,
});

export interface ShareRetentionSettings {
  /** Default `off`. */
  mode?: RetentionMode;
  /** Default 60,000; from 1,000 to 3,600,000. */
  intervalMs?: number;
  /** Default 100; from 1 to 1,000. */
  batchSize?: number;
  /** Default 7 days (D-6); at least 24 hours. */
  succeededMaxAgeMs?: number;
  /** Default 7 days (D-6); at least 24 hours. `null` keeps the two harmless failed classes too: a cancelled job whose every attempt is proven unstarted (at an integer format of 2 or more; legacy formats are always kept) and a retired no-effect rejection. */
  benignFailedMaxAgeMs?: number | null;
  /** Default 3,600,000; from 60,000 to 7 days. */
  rescanIntervalMs?: number;
}

/** Declared now, run by P11: no sweep reads these until it registers one. */
export interface PublisherRetentionSettings {
  /** Default `off`. */
  mode?: RetentionMode;
  /** Default 60,000; from 1,000 to 3,600,000. */
  intervalMs?: number;
  /** Default 100; from 1 to 1,000. */
  batchSize?: number;
  /** Default 7 days (D-6); at least 24 hours. */
  finalizedMaxAgeMs?: number;
}

/** The `queueRetention` section as written in config.json. */
export interface RetentionConfigInput {
  share?: ShareRetentionSettings;
  publisher?: PublisherRetentionSettings;
}

export interface ResolvedShareRetention {
  readonly mode: RetentionMode;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly succeededMaxAgeMs: number;
  readonly benignFailedMaxAgeMs: number | null;
  readonly rescanIntervalMs: number;
}

export interface ResolvedPublisherRetention {
  readonly mode: RetentionMode;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly finalizedMaxAgeMs: number;
}

export interface ResolvedRetentionConfig {
  readonly share: ResolvedShareRetention;
  readonly publisher: ResolvedPublisherRetention;
}

export interface RetentionConfigIssue {
  /** The offending key, as written in config.json (`queueRetention.share.batchSize`). */
  readonly key: string;
  readonly message: string;
}

/** One error for the whole section: every offending key is named. */
export class RetentionConfigError extends Error {
  readonly code = 'RETENTION_CONFIG_INVALID';
  constructor(readonly issues: readonly RetentionConfigIssue[]) {
    super(`invalid queue retention configuration: ${issues.map(issue => `${issue.key} ${issue.message}`).join('; ')}`);
    this.name = 'RetentionConfigError';
  }
}

const SECTION = 'queueRetention';
const SHARE_KEYS = ['mode', 'intervalMs', 'batchSize', 'succeededMaxAgeMs', 'benignFailedMaxAgeMs', 'rescanIntervalMs'] as const;
const PUBLISHER_KEYS = ['mode', 'intervalMs', 'batchSize', 'finalizedMaxAgeMs'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The offending value as written, short enough for one log line. */
function shown(value: unknown): string {
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { /* an unprintable value is described by its type below */ }
  const out = text ?? typeof value;
  return out.length > 40 ? `${out.slice(0, 37)}...` : out;
}

class Collector {
  readonly issues: RetentionConfigIssue[] = [];
  add(key: string, message: string): void { this.issues.push({ key, message }); }

  /** A plain object section whose keys are all recognised; undefined (with issues recorded) otherwise. */
  section(value: unknown, key: string, recognised: readonly string[]): Record<string, unknown> | undefined {
    if (value === undefined) return {};
    if (!isRecord(value)) { this.add(key, `must be an object (got ${shown(value)})`); return undefined; }
    for (const name of Object.keys(value)) {
      if (!recognised.includes(name)) this.add(`${key}.${name}`, `is not a recognised setting (recognised: ${recognised.join(', ')})`);
    }
    return value;
  }

  mode(raw: Record<string, unknown>, key: string): RetentionMode {
    const value = raw['mode'];
    if (value === undefined) return RETENTION_DEFAULTS.mode;
    if (typeof value === 'string' && (RETENTION_MODES as readonly string[]).includes(value)) return value as RetentionMode;
    this.add(`${key}.mode`, `must be one of ${RETENTION_MODES.map(mode => `"${mode}"`).join(', ')} (got ${shown(value)})`);
    return RETENTION_DEFAULTS.mode;
  }

  /** An integer within [min, max]; the default when the key is absent. */
  integer(raw: Record<string, unknown>, key: string, name: string, fallback: number, min: number, max: number): number {
    const value = raw[name];
    if (value === undefined) return fallback;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max) return value;
    this.add(`${key}.${name}`, `must be an integer from ${min} to ${max} (got ${shown(value)})`);
    return fallback;
  }

  /** An age window: an integer of at least the 24-hour floor. */
  window(raw: Record<string, unknown>, key: string, name: string): number {
    const value = raw[name];
    const floor = RETENTION_DEFAULTS.minWindowMs;
    if (value === undefined) return RETENTION_DEFAULTS.windowMs;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= floor) return value;
    this.add(`${key}.${name}`, `must be an integer of at least ${floor} (24 hours; got ${shown(value)})`);
    return RETENTION_DEFAULTS.windowMs;
  }
}

/**
 * Resolve and validate the `queueRetention` section (`undefined` = every default, which is `off` for both queues). Throws one `RetentionConfigError` naming every
 * offending key; never falls back to a default for a value that was written.
 */
export function resolveRetentionConfig(input: unknown): ResolvedRetentionConfig {
  const c = new Collector();
  const d = RETENTION_DEFAULTS;
  const top = c.section(input, SECTION, ['share', 'publisher']) ?? {};
  const shareKey = `${SECTION}.share`;
  const publisherKey = `${SECTION}.publisher`;
  const share = c.section(top['share'], shareKey, SHARE_KEYS) ?? {};
  const publisher = c.section(top['publisher'], publisherKey, PUBLISHER_KEYS) ?? {};

  const benignFailedMaxAgeMs = share['benignFailedMaxAgeMs'] === null ? null : c.window(share, shareKey, 'benignFailedMaxAgeMs');

  const resolved: ResolvedRetentionConfig = {
    share: {
      mode: c.mode(share, shareKey),
      intervalMs: c.integer(share, shareKey, 'intervalMs', d.intervalMs, d.minIntervalMs, d.maxIntervalMs),
      batchSize: c.integer(share, shareKey, 'batchSize', d.batchSize, 1, d.maxBatchSize),
      succeededMaxAgeMs: c.window(share, shareKey, 'succeededMaxAgeMs'),
      benignFailedMaxAgeMs,
      rescanIntervalMs: c.integer(share, shareKey, 'rescanIntervalMs', d.rescanIntervalMs, d.minRescanIntervalMs, d.maxRescanIntervalMs),
    },
    publisher: {
      mode: c.mode(publisher, publisherKey),
      intervalMs: c.integer(publisher, publisherKey, 'intervalMs', d.intervalMs, d.minIntervalMs, d.maxIntervalMs),
      batchSize: c.integer(publisher, publisherKey, 'batchSize', d.batchSize, 1, d.maxBatchSize),
      finalizedMaxAgeMs: c.window(publisher, publisherKey, 'finalizedMaxAgeMs'),
    },
  };
  if (c.issues.length > 0) throw new RetentionConfigError(c.issues);
  return resolved;
}

/**
 * The boot-time form (like `exitOnStoreConfigErrors`): log every offending key and stop the start, so a bad value is a startup error naming the key rather than a
 * silent `off`. Returns the resolved settings when they are valid.
 */
export function resolveRetentionConfigOrExit(input: unknown, log: (message: string) => void): ResolvedRetentionConfig {
  try {
    return resolveRetentionConfig(input);
  } catch (error) {
    if (!(error instanceof RetentionConfigError)) throw error;
    log(`[RETENTION-CONFIG] ${error.issues.length} validation error(s) - refusing to start.`);
    for (const issue of error.issues) log(`  ${issue.key}: ${issue.message}`);
    return process.exit(1);
  }
}
