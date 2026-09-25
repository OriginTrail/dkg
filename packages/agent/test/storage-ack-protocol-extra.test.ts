/**
 * Storage-ACK transport pin: ACK collection MUST ride the libp2p direct
 * protocol `/dkg/10.0.1/storage-ack` — NOT GossipSub.
 *
 * Audit findings covered:
 *   A-9 (HIGH) — pins that the agent package uses
 *        `PROTOCOL_STORAGE_ACK = '/dkg/10.0.1/storage-ack'` for ACK wiring
 *        and NEVER publishes ACKs over GossipSub.
 *
 * This is a static-scan test (no real libp2p dial needed). Spying on the
 * real dial inside a hermetic vitest run adds environment flakiness with
 * no additional guarantee — if the constant, the router registration, or
 * the dial site diverges from `'/dkg/10.0.1/storage-ack'`, this test
 * flips RED. See also ack-eip191-agent-extra.test.ts for the constant
 * pin.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_STORAGE_ACK, PROTOCOL_STORAGE_ACK_V2, PROTOCOL_STORAGE_UPDATE_ACK, PROTOCOL_STORAGE_UPDATE_ACK_V2, STORAGE_ACK_PROTOCOLS } from '@origintrail-official/dkg-core';
import { registerStorageACKEndpoint } from '../src/p2p/storage-ack-endpoint.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_SRC = resolve(__dirname, '..', 'src');

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
    // rc.9 PR-11: bumped to /dkg/10.0.1/* hard cutover (Universal
    // Messenger substrate; receiver dedup + envelope wrap mandatory).
    expect(PROTOCOL_STORAGE_ACK).toBe('/dkg/10.0.1/storage-ack');
    expect(PROTOCOL_STORAGE_ACK_V2).toBe('/dkg/10.0.2/storage-ack');
  });

  it('registers every publish and update ACK protocol from the shared registry', () => {
    // The DKGAgent god class was split into per-subsystem mixin holders, so
    // the boot-time wiring (incl. this registration) now lives in a sibling
    // file (`dkg-agent-lifecycle.ts`) rather than `dkg-agent.ts`. Scan the
    // whole agent `src` tree so the pin tracks the agent package, not one file.
    const lifecycle = readFileSync(join(AGENT_SRC, 'dkg-agent-lifecycle.ts'), 'utf8');
    // Both IDs must enter the one registered endpoint through Messenger,
    // which supplies envelope decoding and receiver-side deduplication.
    const endpoint = readFileSync(join(AGENT_SRC, 'p2p', 'storage-ack-endpoint.ts'), 'utf8');
    expect(STORAGE_ACK_PROTOCOLS).toEqual([
      [PROTOCOL_STORAGE_ACK, 'publish'],
      [PROTOCOL_STORAGE_ACK_V2, 'publish'],
      [PROTOCOL_STORAGE_UPDATE_ACK, 'update'],
      [PROTOCOL_STORAGE_UPDATE_ACK_V2, 'update'],
    ]);
    // Registration is staged locally and installed by its lifecycle owner
    // only while the generation is still current.
    expect(lifecycle).toMatch(/const endpoint\s*=\s*registerStorageACKEndpoint\(/);
    expect(lifecycle).toMatch(/return \{ kind: 'registered', endpoint, lease: registrationLease \}/);
    expect(readFileSync(join(AGENT_SRC, 'p2p', 'storage-ack-registration-runtime.ts'), 'utf8'))
      .toMatch(/this\.state = \{ kind: 'registered', endpoint, lease \}/);
    expect(lifecycle).toMatch(/registerGroup:\s*\(entries\)\s*=>\s*this\.messenger\.registerGroup\(entries\)/);
    expect(endpoint).toMatch(/ports\.registerGroup\(STORAGE_ACK_PROTOCOLS\.map\(/);
  });

  it('routes every registered protocol and revokes all routes on disposal', async () => {
    const routes = new Map<string, (data: Uint8Array, peerId: string) => Promise<Uint8Array>>();
    let disposed = false;
    const endpoint = registerStorageACKEndpoint({
      registerGroup: (entries) => {
        for (const entry of entries) routes.set(entry.protocolId, entry.handler);
        return () => { disposed = true; routes.clear(); };
      },
      publish: async () => new Uint8Array([1]),
      update: async () => new Uint8Array([2]),
      publishLocal: () => {
        const response = Promise.resolve(new Uint8Array([1]));
        return { response, completion: response };
      },
      updateLocal: () => {
        const response = Promise.resolve(new Uint8Array([2]));
        return { response, completion: response };
      },
    });

    expect([...routes.keys()]).toEqual(STORAGE_ACK_PROTOCOLS.map(([protocol]) => protocol));
    for (const [protocol, kind] of STORAGE_ACK_PROTOCOLS) {
      await expect(routes.get(protocol)!(new Uint8Array(), 'peer'))
        .resolves.toEqual(new Uint8Array([kind === 'publish' ? 1 : 2]));
    }
    const stale = routes.get(PROTOCOL_STORAGE_ACK)!;
    endpoint.dispose();
    expect(disposed).toBe(true);
    expect(routes.size).toBe(0);
    expect(() => stale(new Uint8Array(), 'peer')).toThrow(/not registered/);
  });

  it('agent wires core-side StorageACK decline logging', () => {
    const combined = walk(AGENT_SRC)
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');

    expect(combined).toMatch(/onDecline:\s*\(details\)\s*=>/);
    expect(combined).toContain('V10 StorageACK declined: code=');
  });

  it('agent source never publishes ACKs on GossipSub', () => {
    // A false-positive here would be any call like
    // `publish('/dkg/10.0.1/storage-ack', ...)` or
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
    // break ACK handshakes. We allow only the V1 and V2 storage-ack constants.
    const files = walk(AGENT_SRC);
    const offenders: string[] = [];
    const re = /['"`](\/dkg\/[^'"`]*?storage-ack)['"`]/g;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(re)) {
        if (m[1] !== PROTOCOL_STORAGE_ACK && m[1] !== PROTOCOL_STORAGE_ACK_V2) {
          offenders.push(`${f}: ${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
