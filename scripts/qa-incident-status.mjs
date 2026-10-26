#!/usr/bin/env node
import fs from 'node:fs';
import { validateIncidentClosure } from './lib/regressions/incident-closure.mjs';
const records = JSON.parse(fs.readFileSync('test-policy/incidents/release-10.0.26.json', 'utf8'));
const inventory = JSON.parse(fs.readFileSync('test-inventory.json', 'utf8'));
console.log(JSON.stringify(validateIncidentClosure(process.cwd(), records, inventory), null, 2));
