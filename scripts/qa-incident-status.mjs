#!/usr/bin/env node
import fs from 'node:fs';
import { loadIncidentRecords, validateIncidentClosure } from './lib/regressions/incident-closure.mjs';
const records = loadIncidentRecords(process.cwd());
const inventory = JSON.parse(fs.readFileSync('test-inventory.json', 'utf8'));
console.log(JSON.stringify(validateIncidentClosure(process.cwd(), records, inventory), null, 2));
