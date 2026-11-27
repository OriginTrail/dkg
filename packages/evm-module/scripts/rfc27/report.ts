// OT-RFC-27 script support: output with every secret redacted, checks printed
// as PASS or FAIL, and the results file a run writes.

import * as fs from 'fs';
import * as path from 'path';

import { ethers } from 'ethers';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** `value` as JSON: bigints as decimal strings; undefined object fields are left out. */
export function toJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map((v) => toJson(v));
  if (typeof value === 'object') {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = toJson(v);
    return out;
  }
  return String(value);
}

/** Replaces every secret it holds, in every case and with or without 0x, by `<redacted>`. */
export class Redactor {
  private readonly forms = new Set<string>();

  add(secret: string | undefined): void {
    if (!secret || secret.length < 8) return;
    const all = [secret, secret.toLowerCase(), secret.toUpperCase()];
    if (/^0x[0-9a-fA-F]+$/.test(secret)) {
      const bare = secret.slice(2);
      all.push(bare, bare.toLowerCase(), bare.toUpperCase());
    }
    for (const f of all) if (f.length >= 8) this.forms.add(f);
  }

  redact(text: string): string {
    let out = text;
    for (const f of this.forms) out = out.split(f).join('<redacted>');
    return out;
  }
}

export function writeJson(file: string, data: Json, redactor: Redactor): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${redactor.redact(JSON.stringify(data, null, 2))}\n`);
}

export type CheckResult = { label: string; ok: boolean; detail?: string };
/**
 * ran: the phase did its work; deferred: it cannot run yet, and says when it
 * can; waiting: it ran, and waits on another party before it can complete;
 * failed: it stopped on an error; done earlier: it had completed before.
 */
export type RunStatus = 'ran' | 'deferred' | 'waiting' | 'failed' | 'done earlier';

/** What a phase prints and writes: its checks, its transactions, its numbers. */
export class Report {
  readonly checks: CheckResult[] = [];
  readonly txs: Json[] = [];
  readonly forkOnly: string[] = [];
  readonly data: JsonObject = {};
  status: RunStatus = 'ran';
  why?: string;

  constructor(readonly redactor: Redactor) {}

  say(line = ''): void {
    console.log(this.redactor.redact(line));
  }

  note(line: string): void {
    this.say(`  ${line}`);
  }

  /** Records and prints a check; returns whether it passed. */
  check(label: string, ok: boolean, detail?: string): boolean {
    this.checks.push({ label, ok, detail });
    this.say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    return ok;
  }

  defer(why: string): void {
    this.status = 'deferred';
    this.why = why;
    this.say(`\n  DEFERRED  ${why}`);
  }

  wait(why: string): void {
    this.status = 'waiting';
    this.why = why;
    this.say(`\n  WAITING  ${why}`);
  }

  fail(why: string): void {
    this.status = 'failed';
    this.why = why;
    this.say(`\nFAILED: ${why}`);
  }

  set(key: string, value: unknown): void {
    this.data[key] = toJson(value);
  }

  tx(entry: { [key: string]: unknown }): void {
    this.txs.push(toJson(entry));
  }

  /** A fork-only stand-in for what the real network does by itself. */
  standIn(what: string): void {
    this.forkOnly.push(what);
    this.note(`fork-only: ${what}`);
  }

  get failed(): number {
    return this.checks.filter((c) => !c.ok).length;
  }

  /** The phase stopped before completing, without an error. */
  get stopped(): boolean {
    return this.status === 'deferred' || this.status === 'waiting';
  }

  summary(): string {
    const passed = this.checks.length - this.failed;
    const tail = this.status === 'deferred' ? '; the phase is deferred' : this.status === 'waiting' ? '; the phase waits' : '';
    return `${passed}/${this.checks.length} checks passed${tail}`;
  }

  write(file: string, header: { [key: string]: unknown }): void {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(header)) out[k] = toJson(v);
    Object.assign(out, {
      status: this.status,
      why: this.why ?? null,
      passed: this.checks.length - this.failed,
      failed: this.failed,
      checks: toJson(this.checks),
      txs: this.txs,
      forkOnly: this.forkOnly,
      data: this.data,
    });
    writeJson(file, out, this.redactor);
  }
}

export const fmt = (x: bigint): string => ethers.formatEther(x);
export const iso = (ts: bigint): string => new Date(Number(ts) * 1000).toISOString().replace('.000Z', 'Z');
export const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);
export const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

export function span(seconds: bigint): string {
  const a = seconds < 0n ? -seconds : seconds;
  return `${a / 3600n}h ${(a % 3600n) / 60n}m`;
}
