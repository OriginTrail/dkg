#!/usr/bin/env node
import fs from 'node:fs';
import { CI_MATRICES } from '../lib/ci-lanes.mjs';
const json = JSON.stringify(CI_MATRICES);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrices=${json}\n`);
else console.log(json);
