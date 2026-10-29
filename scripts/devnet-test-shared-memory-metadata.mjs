#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { runSharedMemoryMetadataRegression } from './lib/shared-memory-metadata-regression.mjs';
const base = process.env.DKG_DEVNET_API_URL, authFile = process.env.DKG_DEVNET_AUTH_FILE;
if (!base || !authFile) throw new Error('Set DKG_DEVNET_API_URL and DKG_DEVNET_AUTH_FILE for an existing local devnet.');
const token = (await readFile(authFile, 'utf8')).split('\n').map(line => line.trim()).find(line => line && !line.startsWith('#'));
if (!token) throw new Error('The devnet auth file contains no token.');
console.log(JSON.stringify(await runSharedMemoryMetadataRegression({ base, token }), null, 2));
