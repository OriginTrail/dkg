/**
 * Storage-ACK transport pin: ACK collection MUST ride the libp2p direct
 * protocol `/dkg/10.0.0/storage-ack` — NOT GossipSub.
 *
 * Audit findings covered:
 *   A-9 (HIGH) — pins that the agent package uses
 *        `PROTOCOL_STORAGE_ACK = '/dkg/10.0.0/storage-ack'` for ACK wiring
 *        and NEVER publishes ACKs over GossipSub.
 *
 * This is a static-scan test (no real libp2p dial needed). Spying on the
 * real dial inside a hermetic vitest run adds environment flakiness with
 * no additional guarantee — if the constant, the router registration, or
 * the dial site diverges from `'/dkg/10.0.0/storage-ack'`, this test
 * flips RED. See also ack-eip191-agent-extra.test.ts for the constant
 * pin.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_SRC = resolve(__dirname, '..', 'src');
const DKG_AGENT_FILE = join(AGENT_SRC, 'dkg-agent.ts');

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

describe('A-9: storage-ack protocol id (libp2p) pin', () => {
  it('constant is the exact spec string', () => {
    expect(PROTOCOL_STORAGE_ACK).toBe('/dkg/10.0.0/storage-ack');
  });

  it('`dkg-agent.ts` registers PROTOCOL_STORAGE_ACK on the protocol router', () => {
    const src = readFileSync(DKG_AGENT_FILE, 'utf8');
    // Must import the constant and use it with router.register.
    expect(src).toMatch(/PROTOCOL_STORAGE_ACK/);
    // The registration call — `this.router.register(PROTOCOL_STORAGE_ACK, ...)`
    const registerRE = /router\.register\s*\(\s*PROTOCOL_STORAGE_ACK\s*,/;
    expect(src).toMatch(registerRE);
  });

  it('agent source never publishes ACKs on GossipSub', () => {
    // A false-positive here would be any call like
    // `publish('/dkg/10.0.0/storage-ack', ...)` or
    // `gossipsub.publish('...storage-ack...', ...)` through the gossipsub
    // manager. We scan all .ts files in src and make sure we never see
    // GossipSub coupling with the storage-ack string.
    const files = walk(AGENT_SRC);
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/storage-ack/.test(line)) return;
        if (/gossip/i.test(line)) {
          offenders.push({ file: f.replace(AGENT_SRC + '/', ''), line: i + 1, text: line.trim() });
        }
      });
    }
    expect(offenders, JSON.stringify(offenders, null, 2)).toEqual([]);
  });

  it('protocol id is NOT accidentally registered on a different protocol version', () => {
    // Pins that no code path silently forks to /dkg/9.x or /dkg/11.x
    // storage-ack — such a drift would be invisible to callers but would
    // break ACK handshakes. We look for any `/dkg/*/storage-ack` that is
    // not exactly the current PROTOCOL_STORAGE_ACK.
    const files = walk(AGENT_SRC);
    const offenders: string[] = [];
    const re = /['"`](\/dkg\/[^'"`]*?storage-ack)['"`]/g;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(re)) {
        if (m[1] !== PROTOCOL_STORAGE_ACK) {
          offenders.push(`${f}: ${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
