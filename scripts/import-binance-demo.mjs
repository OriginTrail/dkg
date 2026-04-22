#!/usr/bin/env node
// Imports a demo-sized slice of the Guardian binance .nt corpus into a fresh
// project on a local devnet node, so the Project Overview / graph view has
// nice-looking data to show on video.
//
// Usage:
//   DEVNET_TOKEN=... API=http://127.0.0.1:9201 \
//     node scripts/import-binance-demo.mjs [TRIPLE_LIMIT]
//
// Env:
//   API            Daemon base URL (default: http://127.0.0.1:9201)
//   DEVNET_TOKEN   Bearer auth token (falls back to .devnet/node1/auth.token)
//   PROJECT_ID     Context graph id (default: binance-demo)
//   PROJECT_NAME   Human name (default: "Binance Market Analysis")
//   ASSERTION      Assertion name inside the CG (default: binance-statements)
//   BATCH          Triples per write POST (default: 500)
//   NT_FILE        Source N-triples file (default: guardian-graph-viz/.../binance_final.nt)
//
// Positional:
//   TRIPLE_LIMIT   Max triples to import (default: 3000)

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');

const API = process.env.API ?? 'http://127.0.0.1:9201';
const PROJECT_ID = process.env.PROJECT_ID ?? 'binance-demo';
const PROJECT_NAME = process.env.PROJECT_NAME ?? 'Binance Market Analysis';
const ASSERTION = process.env.ASSERTION ?? 'binance-statements';
const BATCH = Number(process.env.BATCH ?? 500);
const LIMIT = Number(process.argv[2] ?? 3000);
const NT_FILE =
  process.env.NT_FILE ??
  path.resolve(
    REPO_ROOT,
    '..',
    'guardian-graph-viz/demo/data/2026-03-12-112825-binance_final.nt',
  );

function resolveToken() {
  if (process.env.DEVNET_TOKEN) return process.env.DEVNET_TOKEN.trim();
  if (process.env.DKG_AUTH) return process.env.DKG_AUTH.trim();
  const tokenFile = path.resolve(REPO_ROOT, '.devnet/node1/auth.token');
  if (!fs.existsSync(tokenFile)) {
    throw new Error(
      `No auth token: set DEVNET_TOKEN or provide ${tokenFile}`,
    );
  }
  const raw = fs.readFileSync(tokenFile, 'utf8');
  const line = raw.split('\n').find((l) => l.trim() && !l.startsWith('#'));
  if (!line) throw new Error(`Auth token file is empty: ${tokenFile}`);
  return line.trim();
}

const TOKEN = resolveToken();

async function api(method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${route} -> ${res.status}: ${JSON.stringify(parsed)}`,
    );
  }
  return parsed;
}

// Matches a single N-Triples line, mirroring the storage layer's own
// parseNQuadsText regex so the objects we emit round-trip through the
// daemon's formatTerm() without ambiguity.
//   subject/predicate captured without their surrounding '<' '>'.
//   object kept in N-Triples form: '<uri>' for IRIs, '"..."[...]' for literals.
const NT_LINE = /^<([^>]+)>\s+<([^>]+)>\s+(<[^>]+>|_:\S+|"(?:[^"\\]|\\.)*"(?:@\S+|\^\^<[^>]+>)?)\s*\.\s*$/;

function parseLine(line) {
  const m = line.match(NT_LINE);
  if (!m) return null;
  const [, subject, predicate, objectRaw] = m;
  // Unwrap bracketed IRIs for subject/predicate — daemon's formatTerm will
  // re-bracket. Keep object verbatim so literals stay literal and IRIs stay
  // bracketed (formatTerm treats starts-with-'<' as already-bracketed).
  return { subject, predicate, object: objectRaw };
}

async function readTriples(file, limit) {
  const out = [];
  let skipped = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (out.length >= limit) break;
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parsed = parseLine(t);
    if (!parsed) {
      skipped++;
      continue;
    }
    out.push(parsed);
  }
  rl.close();
  if (skipped > 0) console.log(`[demo] Skipped ${skipped} malformed line(s).`);
  return out;
}

async function resolveCgId(slug) {
  // Mirror lib/dkg-daemon.mjs's wallet-scoping so this legacy script
  // writes into the same canonical `<wallet>/<slug>` context graph the
  // node-ui creates. Pass through unchanged if the slug already contains
  // a wallet prefix or is a did: URI.
  if (slug.includes('/') || slug.startsWith('did:')) return slug;
  const info = await api('GET', '/api/agent/identity');
  if (!info?.agentAddress) {
    throw new Error('Daemon did not return an agentAddress for this token.');
  }
  return `${info.agentAddress}/${slug}`;
}

async function main() {
  console.log(`[demo] API          = ${API}`);
  console.log(`[demo] Source file  = ${NT_FILE}`);
  console.log(`[demo] Triple limit = ${LIMIT}`);
  console.log(`[demo] Project slug = ${PROJECT_ID}`);
  console.log(`[demo] Assertion    = ${ASSERTION}`);

  if (!fs.existsSync(NT_FILE)) {
    throw new Error(`Source file missing: ${NT_FILE}`);
  }

  const cgId = await resolveCgId(PROJECT_ID);
  console.log(`[demo] Canonical CG = ${cgId}`);

  console.log('[demo] Reading & parsing triples …');
  const triples = await readTriples(NT_FILE, LIMIT);
  console.log(`[demo] Parsed ${triples.length} triples from source file.`);

  console.log('[demo] Creating project …');
  try {
    const created = await api('POST', '/api/paranet/create', {
      id: cgId,
      name: PROJECT_NAME,
      description:
        'Demo slice of Guardian sentiment-attribution graph (Binance). ' +
        'Auto-imported for UI demos.',
    });
    console.log(`[demo] Project created: ${created.uri ?? cgId}`);
  } catch (err) {
    if (String(err.message).includes('already exists')) {
      console.log(`[demo] Project "${cgId}" already exists — reusing.`);
    } else {
      throw err;
    }
  }

  console.log(`[demo] Writing triples in batches of ${BATCH} …`);
  let written = 0;
  for (let i = 0; i < triples.length; i += BATCH) {
    const batch = triples.slice(i, i + BATCH);
    await api(
      'POST',
      `/api/assertion/${encodeURIComponent(ASSERTION)}/write`,
      { contextGraphId: cgId, quads: batch },
    );
    written += batch.length;
    process.stdout.write(
      `\r[demo]   wrote ${written} / ${triples.length} triples`,
    );
  }
  process.stdout.write('\n');

  console.log('[demo] Done.');
  console.log(`[demo] Open the UI at: ${API}/ui`);
  console.log(`[demo] Select project: ${PROJECT_NAME}`);
}

main().catch((err) => {
  console.error('[demo] FAILED:', err.message);
  process.exit(1);
});
