/** Run actual generated Merge nodes on a pinned engine in a new disposable SQLite state. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fieldJoinWorkflow, verifyFieldJoinExecution } from './test-support/field-join-native.mjs';

assert.ok(process.argv[2], 'Supply the installed n8n package directory (2.43.8).');
const pkg = resolve(process.argv[2]);
const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;
assert.equal(version, '2.43.8', 'Use the supported engine revision.');
const state = mkdtempSync(join(tmpdir(), 'studio-field-join-'));
// These Set/Split Out/Merge fixtures need no Code runner; port 0 isolates the broker.
const env = { PATH: process.env.PATH, N8N_USER_FOLDER: state, DB_TYPE: 'sqlite',
  N8N_DIAGNOSTICS_ENABLED: 'false', N8N_VERSION_NOTIFICATIONS_ENABLED: 'false', N8N_TEMPLATES_ENABLED: 'false',
  N8N_COMMUNITY_PACKAGES_ENABLED: 'false', N8N_LOG_LEVEL: 'info', N8N_RUNNERS_MODE: 'external', N8N_RUNNERS_BROKER_PORT: '0',
  N8N_RUNNERS_BROKER_LISTEN_ADDRESS: '127.0.0.1', N8N_RUNNERS_AUTH_TOKEN: randomBytes(32).toString('hex'),
  N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'true' };
const run = args => promisify(execFile)(process.execPath, [join(pkg, 'bin/n8n'), ...args], { env, cwd: state, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
try {
  const workflow = fieldJoinWorkflow(), file = join(state, 'workflow.json');
  writeFileSync(file, JSON.stringify(workflow));
  const imported = await run(['import:workflow', '--input=' + file]);
  assert.match(imported.stdout, /Successfully imported 1 workflow/, 'The isolated fixture must import successfully: ' + imported.stdout + imported.stderr);
  const { stdout } = await run(['execute', '--id=' + workflow.id, '--rawOutput']);
  const start = stdout.search(/^\{/m);
  assert.ok(start >= 0, 'The native CLI must return execution data.');
  const execution = JSON.parse(stdout.slice(start, stdout.lastIndexOf('}') + 1));
  const cases = verifyFieldJoinExecution(execution);
  const report = { fixtureOnly: true, n8nVersion: version, nodeVersion: process.version,
    generatedWorkflowSha256: createHash('sha256').update(JSON.stringify(workflow)).digest('hex'), cases };
  if (process.argv[3]) writeFileSync(resolve(process.argv[3]), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { rmSync(state, { recursive: true, force: true }); }
