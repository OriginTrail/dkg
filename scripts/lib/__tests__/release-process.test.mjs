import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../release-process.mjs';

test('release runner captures output with the requested directory and environment', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'release-process-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const output = run(process.execPath, ['-e', 'console.log(JSON.stringify([process.cwd(), process.env.RELEASE_TEST_VALUE]))'], { cwd, env: { RELEASE_TEST_VALUE: 'fixture' } });
  assert.deepEqual(JSON.parse(output), [fs.realpathSync(cwd), 'fixture']);
  assert.throws(() => run(process.execPath, ['-e', 'console.log("stdout detail"); console.error("stderr detail"); process.exit(7)']), /exit 7.*stdout detail.*stderr detail/s);
});
test('release runner retains both output streams and failure diagnostics in its log', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'release-process-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const log = path.join(cwd, 'command.log');
  assert.equal(run(process.execPath, ['-e', 'console.log("first output")'], { cwd, log }), undefined);
  assert.throws(() => run(process.execPath, ['-e', 'console.log("second output"); console.error("failure detail"); process.exit(9)'], { cwd, log }), /exit 9.*see retained log/);
  assert.match(fs.readFileSync(log, 'utf8'), /first output.*second output.*failure detail/s);
});
