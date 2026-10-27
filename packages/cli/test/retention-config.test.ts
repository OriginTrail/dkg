/**
 * OT-RFC-73 P10b: the `queueRetention` config section. Both queues default to `off`; the bounds are the share core's; every wrong or unknown value is a startup
 * error that names its key (never a silent default).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { createShareRetention } from '@origintrail-official/dkg-publisher';
import { DkgHomeFiles } from '../src/config.js';
import {
  RETENTION_DEFAULTS, RetentionConfigError, resolveRetentionConfig, resolveRetentionConfigOrExit,
} from '../src/retention-config.js';

const DAY = 24 * 3_600_000;
const issuesOf = (input: unknown): Array<{ key: string; message: string }> => {
  try { resolveRetentionConfig(input); } catch (error) {
    expect(error).toBeInstanceOf(RetentionConfigError);
    return [...(error as RetentionConfigError).issues];
  }
  throw new Error('expected the configuration to be refused');
};

describe('defaults', () => {
  const OFF_BY_DEFAULT = {
    share: { mode: 'off', intervalMs: 60_000, batchSize: 100, succeededMaxAgeMs: 7 * DAY, benignFailedMaxAgeMs: 7 * DAY, rescanIntervalMs: 3_600_000 },
    publisher: { mode: 'off', intervalMs: 60_000, batchSize: 100, finalizedMaxAgeMs: 7 * DAY },
  };

  it.each([['no section', undefined], ['an empty section', {}], ['empty queue sections', { share: {}, publisher: {} }]])('%s: both queues are off with the D-6 7-day windows', (_name, input) => {
    expect(resolveRetentionConfig(input)).toEqual(OFF_BY_DEFAULT);
  });

  it('a queue that sets only its mode keeps every other default; the other queue stays off', () => {
    expect(resolveRetentionConfig({ share: { mode: 'report' } })).toEqual({ ...OFF_BY_DEFAULT, share: { ...OFF_BY_DEFAULT.share, mode: 'report' } });
    expect(resolveRetentionConfig({ publisher: { mode: 'delete' } })).toEqual({ ...OFF_BY_DEFAULT, publisher: { ...OFF_BY_DEFAULT.publisher, mode: 'delete' } });
  });

  it('exposes the documented figures', () => {
    expect(RETENTION_DEFAULTS).toMatchObject({ mode: 'off', windowMs: 7 * DAY, minWindowMs: DAY, batchSize: 100, maxBatchSize: 1000, intervalMs: 60_000 });
  });

  it('passes every written value through', () => {
    const written = {
      share: { mode: 'delete', intervalMs: 5_000, batchSize: 250, succeededMaxAgeMs: 3 * DAY, benignFailedMaxAgeMs: 2 * DAY, rescanIntervalMs: 120_000 },
      publisher: { mode: 'report', intervalMs: 90_000, batchSize: 7, finalizedMaxAgeMs: 9 * DAY },
    };
    expect(resolveRetentionConfig(written)).toEqual(written);
  });

  it('`benignFailedMaxAgeMs: null` keeps the two harmless failed classes too', () => {
    expect(resolveRetentionConfig({ share: { benignFailedMaxAgeMs: null } }).share.benignFailedMaxAgeMs).toBeNull();
  });
});

describe('bounds', () => {
  it.each([
    ['share.batchSize', 1], ['share.batchSize', 1000], ['publisher.batchSize', 1], ['publisher.batchSize', 1000],
    ['share.intervalMs', 1_000], ['share.intervalMs', 3_600_000], ['publisher.intervalMs', 1_000], ['publisher.intervalMs', 3_600_000],
    ['share.succeededMaxAgeMs', DAY], ['share.benignFailedMaxAgeMs', DAY], ['publisher.finalizedMaxAgeMs', DAY],
    ['share.rescanIntervalMs', 60_000], ['share.rescanIntervalMs', 7 * DAY],
  ])('%s = %d is accepted', (path, value) => {
    const [queue, key] = path.split('.') as [string, string];
    expect(() => resolveRetentionConfig({ [queue]: { [key]: value } })).not.toThrow();
  });

  it.each([
    ['share.batchSize', 0], ['share.batchSize', 1001], ['share.batchSize', -5], ['share.batchSize', 10.5], ['share.batchSize', '100'], ['share.batchSize', null],
    ['publisher.batchSize', 0], ['publisher.batchSize', 1001],
    ['share.intervalMs', 999], ['share.intervalMs', 3_600_001], ['share.intervalMs', 0], ['share.intervalMs', 1.5], ['share.intervalMs', '60000'], ['share.intervalMs', Number.POSITIVE_INFINITY],
    ['publisher.intervalMs', 999], ['publisher.intervalMs', 3_600_001],
    ['share.succeededMaxAgeMs', DAY - 1], ['share.succeededMaxAgeMs', 0], ['share.succeededMaxAgeMs', '7d'], ['share.succeededMaxAgeMs', null], ['share.succeededMaxAgeMs', 1.5 * DAY + 0.5],
    ['share.benignFailedMaxAgeMs', DAY - 1], ['share.benignFailedMaxAgeMs', 'never'], ['share.benignFailedMaxAgeMs', false],
    ['publisher.finalizedMaxAgeMs', DAY - 1], ['publisher.finalizedMaxAgeMs', 'x'],
    ['share.rescanIntervalMs', 59_999], ['share.rescanIntervalMs', 7 * DAY + 1],
    ['share.mode', 'REPORT'], ['share.mode', 'on'], ['share.mode', true], ['share.mode', 1], ['share.mode', null], ['publisher.mode', 'enabled'],
  ])('%s = %j is refused, naming the key', (path, value) => {
    const [queue, key] = path.split('.') as [string, string];
    const issues = issuesOf({ [queue]: { [key]: value } });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.key).toBe(`queueRetention.${path}`);
  });

  it('the batch size and the windows follow the share core exactly (one source of truth)', () => {
    const store = new OxigraphStore();
    const core = (over: Record<string, unknown>) => () => createShareRetention({ store, mode: 'off', intervalMs: 60_000, ...over });
    // accepted by both at the limits, refused by both just outside them
    expect(core({ batchSize: 1000 })).not.toThrow();
    expect(core({ batchSize: 1001 })).toThrow(/batchSize/);
    expect(() => resolveRetentionConfig({ share: { batchSize: 1000 } })).not.toThrow();
    expect(() => resolveRetentionConfig({ share: { batchSize: 1001 } })).toThrow(/batchSize/);
    expect(core({ succeededMaxAgeMs: DAY })).not.toThrow();
    expect(core({ succeededMaxAgeMs: DAY - 1 })).toThrow(/succeededMaxAgeMs/);
    expect(core({ benignFailedMaxAgeMs: DAY - 1 })).toThrow(/benignFailedMaxAgeMs/);
    expect(() => resolveRetentionConfig({ share: { succeededMaxAgeMs: DAY } })).not.toThrow();
    expect(() => resolveRetentionConfig({ share: { succeededMaxAgeMs: DAY - 1 } })).toThrow(/succeededMaxAgeMs/);
    expect(() => resolveRetentionConfig({ share: { benignFailedMaxAgeMs: DAY - 1 } })).toThrow(/benignFailedMaxAgeMs/);
    // and everything the resolver accepts, the core accepts
    const resolved = resolveRetentionConfig({ share: { mode: 'report', batchSize: 1000, succeededMaxAgeMs: DAY, benignFailedMaxAgeMs: DAY, intervalMs: 1_000, rescanIntervalMs: 60_000 } }).share;
    expect(core({ batchSize: resolved.batchSize, succeededMaxAgeMs: resolved.succeededMaxAgeMs, benignFailedMaxAgeMs: resolved.benignFailedMaxAgeMs, intervalMs: resolved.intervalMs, rescanIntervalMs: resolved.rescanIntervalMs })).not.toThrow();
    const keepBenign = resolveRetentionConfig({ share: { benignFailedMaxAgeMs: null } }).share;
    expect(core({ benignFailedMaxAgeMs: keepBenign.benignFailedMaxAgeMs })).not.toThrow();
  });
});

describe('unknown keys and wrong shapes', () => {
  it.each([
    ['a typo in the share section', { share: { mod: 'report' } }, 'queueRetention.share.mod'],
    ['a typo in the publisher section', { publisher: { finalizedMaxAge: 1 } }, 'queueRetention.publisher.finalizedMaxAge'],
    ['a publisher key in the share section', { share: { finalizedMaxAgeMs: 7 * DAY } }, 'queueRetention.share.finalizedMaxAgeMs'],
    ['a share key in the publisher section', { publisher: { succeededMaxAgeMs: 7 * DAY } }, 'queueRetention.publisher.succeededMaxAgeMs'],
    ['an unknown queue', { lift: { mode: 'report' } }, 'queueRetention.lift'],
  ])('%s is refused, naming the key', (_name, input, key) => {
    const issues = issuesOf(input);
    expect(issues.map(issue => issue.key)).toEqual([key]);
    expect(issues[0]!.message).toMatch(/not a recognised setting/);
  });

  it.each([
    ['the section', 'on', 'queueRetention'], ['the section', null, 'queueRetention'], ['the section', [], 'queueRetention'], ['the section', 7, 'queueRetention'],
    ['the share section', { share: 'report' }, 'queueRetention.share'], ['the share section', { share: null }, 'queueRetention.share'],
    ['the publisher section', { publisher: [] }, 'queueRetention.publisher'], ['the publisher section', { publisher: true }, 'queueRetention.publisher'],
  ])('%s that is not an object (%j) is refused, naming the key', (_name, input, key) => {
    expect(issuesOf(input).map(issue => issue.key)).toEqual([key]);
  });

  it('reports every offending key at once, in one error', () => {
    const input = { share: { mode: 'sometimes', batchSize: 5000, bogus: 1 }, publisher: { finalizedMaxAgeMs: 10 } };
    const issues = issuesOf(input);
    expect(issues.map(issue => issue.key).sort()).toEqual([
      'queueRetention.publisher.finalizedMaxAgeMs', 'queueRetention.share.batchSize', 'queueRetention.share.bogus', 'queueRetention.share.mode',
    ]);
    let message = '';
    try { resolveRetentionConfig(input); } catch (error) { message = (error as Error).message; }
    for (const issue of issues) expect(message).toContain(issue.key);
    expect(message).toContain('5000');
  });

  it('shows a written value briefly and survives one that cannot be printed', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(issuesOf({ share: { mode: 'x'.repeat(500) } })[0]!.message.length).toBeLessThan(160);
    expect(issuesOf({ share: { mode: circular } })[0]!.message).toMatch(/object/);
  });
});

describe('startup', () => {
  let exit: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never); });
  afterEach(() => { exit.mockRestore(); });

  it('a valid section returns the resolved settings and logs nothing', () => {
    const log = vi.fn();
    expect(resolveRetentionConfigOrExit({ share: { mode: 'report' } }, log).share.mode).toBe('report');
    expect(resolveRetentionConfigOrExit(undefined, log).share.mode).toBe('off');
    expect(log).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('a bad value logs every offending key and stops the start (exit code 1)', () => {
    const lines: string[] = [];
    expect(() => resolveRetentionConfigOrExit({ share: { mode: 'sometimes', batchSize: 5000 } }, line => lines.push(line))).toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    const text = lines.join('\n');
    expect(text).toContain('2 validation error(s)');
    expect(text).toContain('queueRetention.share.mode');
    expect(text).toContain('queueRetention.share.batchSize');
  });

  describe('from config.json', () => {
    let home: string | undefined;
    afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); home = undefined; });

    it('the section is read from the file like any other key and resolved; a bad one is refused', async () => {
      home = await mkdtemp(join(tmpdir(), 'dkg-retention-config-'));
      const files = new DkgHomeFiles(home);
      await writeFile(files.configPath, JSON.stringify({ queueRetention: { share: { mode: 'report', batchSize: 50 } } }));
      const loaded = await files.loadConfig();
      expect(resolveRetentionConfig(loaded.queueRetention).share).toMatchObject({ mode: 'report', batchSize: 50, intervalMs: 60_000 });
      await writeFile(files.configPath, JSON.stringify({ queueRetention: { share: { mode: 'report', batchSize: 5000 } } }));
      const bad = await files.loadConfig();
      expect(() => resolveRetentionConfig(bad.queueRetention)).toThrow(/queueRetention\.share\.batchSize/);
      await writeFile(files.configPath, JSON.stringify({}));
      expect(resolveRetentionConfig((await files.loadConfig()).queueRetention).share.mode).toBe('off');
    });
  });
});
