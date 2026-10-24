#!/usr/bin/env node

import { parseArgs } from 'node:util';
import {
  validateEvmResults,
  validatePrimaryResults,
} from '../lib/ci-results.mjs';

const { values } = parseArgs({
  options: {
    workflow: { type: 'string' },
  },
  strict: true,
});

if (!['primary', 'evm'].includes(values.workflow)) {
  throw new Error('--workflow must be primary or evm');
}

const plan = JSON.parse(process.env.PLAN_JSON ?? 'null');
const needs = JSON.parse(process.env.NEEDS_JSON ?? 'null');
if (!plan || !needs) throw new Error('PLAN_JSON and NEEDS_JSON are required');

const errors = values.workflow === 'primary'
  ? validatePrimaryResults({ eventName: process.env.EVENT_NAME, plan, needs })
  : validateEvmResults({ eventName: process.env.EVENT_NAME, plan, needs });

if (errors.length) {
  for (const error of errors) process.stderr.write(`::error::${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`CI ${values.workflow} gate passed.\n`);
}
