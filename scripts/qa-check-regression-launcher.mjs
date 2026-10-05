#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { checkInstalledPnpm, checkOwnedProcessTermination } from './lib/regressions/launcher-checks.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pnpm = await checkInstalledPnpm(root);
const processes = await checkOwnedProcessTermination(root);
console.log(JSON.stringify({ node: process.version, platform: process.platform, ...pnpm, ...processes }));
