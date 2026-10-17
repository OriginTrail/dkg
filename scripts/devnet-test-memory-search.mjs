#!/usr/bin/env node
// On an already-running local devnet:
// DKG_DEVNET_API_URL=http://127.0.0.1:9201 DKG_DEVNET_AUTH_FILE=.devnet/node1/auth.token \
//   node scripts/devnet-test-memory-search.mjs
// Creates a uniquely named graph and two agents; no mocked query/chain/store.
import { readFile } from 'node:fs/promises';
import { runMemorySearchRegression } from './lib/memory-search-regression.mjs';
const base = process.env.DKG_DEVNET_API_URL;
const authFile = process.env.DKG_DEVNET_AUTH_FILE;
if (!base || !authFile) throw new Error('Set DKG_DEVNET_API_URL and DKG_DEVNET_AUTH_FILE for an existing local devnet.');
const token = (await readFile(authFile, 'utf8')).trim();
console.log(JSON.stringify(await runMemorySearchRegression({ base, token }), null, 2));
