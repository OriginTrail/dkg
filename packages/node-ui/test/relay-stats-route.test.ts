// relay-stats-route.test.ts
//
// Integration tests for `GET /api/relay/stats` introduced in PR2 of
// the libp2p reachability hardening series. Three contracts under
// test:
//
//   1. 404 contract — edge nodes (no relay-stats provider injected, or
//      provider returns null) get 404 with a structured error body.
//      Dashboards rely on this to hide the relay panel cleanly.
//
//   2. 200 contract — Core Nodes get the full body shape: capacity,
//      reservationCount, activeCircuits, utilization (rounded %),
//      stringified bigints for bytesIn/bytesOut, and the
//      reservations[] array with derived ttlMs.
//
//   3. JSON safety — bigint byte counters MUST be serialised as
//      strings (otherwise JSON.stringify throws) and ttlMs MUST be
//      computed relative to the live `Date.now()` so dashboards see
//      a fresh value per request.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleNodeUIRequest } from '../src/api.js';
import { DashboardDB } from '../src/db.js';
import type { RelayStats } from '@origintrail-official/dkg-core';

let server: Server;
let baseUrl: string;
let db: DashboardDB;
let dataDir: string;

// We swap the relayStatsProvider per-test by mutating this slot, so
// the same long-lived server instance can route both edge and core
// scenarios. Default = no provider (edge-node 404 path).
let currentProvider: (() => RelayStats | null) | undefined = undefined;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'dkg-relay-route-test-'));
  db = new DashboardDB({ dataDir });

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    handleNodeUIRequest(
      req,
      res,
      url,
      db,
      '.',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      currentProvider,
    )
      .then((handled) => {
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.end('Not Found');
        }
      })
      .catch((err) => {
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /api/relay/stats — edge node (404 contract)', () => {
  it('returns 404 + structured error when no relayStatsProvider is wired (edge default)', async () => {
    currentProvider = undefined;
    const res = await fetch(`${baseUrl}/api/relay/stats`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({
      error: 'relay-stats-not-available',
    });
    expect(typeof body.message).toBe('string');
  });

  it('returns 404 when the provider returns null (relay not started yet)', async () => {
    currentProvider = () => null;
    const res = await fetch(`${baseUrl}/api/relay/stats`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('relay-stats-not-available');
  });
});

describe('GET /api/relay/stats — Core Node (200 contract)', () => {
  it('returns the full body shape with stringified bigints and computed utilization', async () => {
    const expiry = Date.now() + 60_000; // 1 min from now
    currentProvider = (): RelayStats => ({
      capacity: 1024,
      reservationCount: 256,
      activeCircuits: 100,
      bytesIn: 1_234_567_890n,
      bytesOut: 9_876_543_210n,
      reservations: [
        {
          peerId: '12D3KooWedge1',
          expiryTs: expiry,
          addr: '/ip4/1.2.3.4/tcp/4001/p2p/12D3KooWrelay',
          limitDurationMs: 30 * 60 * 1000,
          limitDataBytes: 1 << 24,
        },
      ],
    });

    const res = await fetch(`${baseUrl}/api/relay/stats`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.capacity).toBe(1024);
    expect(body.reservationCount).toBe(256);
    expect(body.activeCircuits).toBe(100);
    // utilization = 256/1024 * 100 = 25.00 (rounded to 2 decimals)
    expect(body.utilization).toBe(25);

    // Bigints must serialise as strings (otherwise JSON.stringify throws).
    expect(body.bytesIn).toBe('1234567890');
    expect(body.bytesOut).toBe('9876543210');
    expect(BigInt(body.bytesIn)).toBe(1_234_567_890n);

    expect(Array.isArray(body.reservations)).toBe(true);
    expect(body.reservations).toHaveLength(1);
    const r = body.reservations[0];
    expect(r.peerId).toBe('12D3KooWedge1');
    expect(r.expiryTs).toBe(expiry);
    // ttlMs is the route-derived "expiry - now" — must be > 0 and ≤ 60s.
    expect(r.ttlMs).toBeGreaterThan(0);
    expect(r.ttlMs).toBeLessThanOrEqual(60_000);
    expect(r.addr).toContain('/p2p/12D3KooWrelay');
    expect(r.limitDurationMs).toBe(30 * 60 * 1000);
    expect(r.limitDataBytes).toBe(1 << 24);
  });

  it('utilization is null when capacity is 0 (defensive — no divide-by-zero)', async () => {
    currentProvider = (): RelayStats => ({
      capacity: 0,
      reservationCount: 0,
      activeCircuits: 0,
      bytesIn: 0n,
      bytesOut: 0n,
      reservations: [],
    });
    const res = await fetch(`${baseUrl}/api/relay/stats`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.utilization).toBeNull();
    expect(body.reservations).toEqual([]);
    expect(body.bytesIn).toBe('0');
    expect(body.bytesOut).toBe('0');
  });

  it('passes through null fields on individual reservations (libp2p may omit limit/addr)', async () => {
    currentProvider = (): RelayStats => ({
      capacity: 100,
      reservationCount: 1,
      activeCircuits: 0,
      bytesIn: 0n,
      bytesOut: 0n,
      reservations: [
        {
          peerId: '12D3KooWnull',
          expiryTs: null,
          addr: null,
          limitDurationMs: null,
          limitDataBytes: null,
        },
      ],
    });
    const res = await fetch(`${baseUrl}/api/relay/stats`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const r = body.reservations[0];
    expect(r.peerId).toBe('12D3KooWnull');
    expect(r.expiryTs).toBeNull();
    expect(r.ttlMs).toBeNull();
    expect(r.addr).toBeNull();
    expect(r.limitDurationMs).toBeNull();
    expect(r.limitDataBytes).toBeNull();
  });
});
