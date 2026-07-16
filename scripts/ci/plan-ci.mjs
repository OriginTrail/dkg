#!/usr/bin/env node

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import {
  githubOutputsForPlan,
  parseNameStatusZ,
  planCi,
  renderPlanSummary,
} from '../lib/ci-delta.mjs';

const { values } = parseArgs({
  options: {
    event: { type: 'string' },
    'changes-z': { type: 'string' },
    'labels-json': { type: 'string', default: '[]' },
    'sample-key': { type: 'string', default: '' },
    'github-output': { type: 'string' },
    summary: { type: 'string' },
  },
  strict: true,
});

if (!values.event) throw new Error('--event is required');

const changeEntries = values['changes-z']
  ? parseNameStatusZ(fs.readFileSync(values['changes-z']))
  : [];
const labels = JSON.parse(values['labels-json']) ?? [];
if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string')) {
  throw new TypeError('--labels-json must contain a JSON string array');
}

const plan = planCi({
  eventName: values.event,
  changeEntries,
  labels,
  sampleKey: values['sample-key'],
});

if (values['github-output']) {
  const output = Object.entries(githubOutputsForPlan(plan))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  fs.appendFileSync(values['github-output'], `${output}\n`);
}

if (values.summary) {
  fs.appendFileSync(values.summary, renderPlanSummary(plan));
}

process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
