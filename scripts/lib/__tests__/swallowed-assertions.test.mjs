import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { swallowedAssertions } from '../swallowed-assertions.mjs';
const scan = body => swallowedAssertions(`import {expect as check} from 'vitest';\n${body}`, 'test.ts');
test('flags assertions swallowed by empty, logging, returning and nested catches', () => {
  for (const handler of ['', 'console.log(error)', 'return false', 'if (error) console.log(error)']) {
    assert.equal(scan(`try { check(1).toBe(2); } catch(error) { ${handler} }`).length, 1);
  }
});
test('accepts separated observations, rejecting catches, and callback assertions', () => {
  for (const source of [
    'try { operation() } catch {} check(result).toBe(true)',
    'try { check(1).toBe(2) } catch (error) { throw error }',
    'try { register(() => check(1).toBe(2)) } catch {}',
    'try { operation() } catch (error) { check(error.message).toBe("expected") }',
  ]) assert.deepEqual(scan(source), []);
});
test('recognizes node assertions but ignores similarly named unrelated APIs', () => {
  assert.equal(swallowedAssertions("import assert from 'node:assert/strict'; try { assert.equal(a,b) } catch {}", 'test.mjs').length, 1);
  assert.deepEqual(swallowedAssertions("import {expect} from './user-api'; try { expect(a) } catch {}", 'test.ts'), []);
});


test('comments cannot exempt swallowed assertions, including independent callback catches', () => {
  assert.equal(scan('// reviewed exception\ntry { check(1).toBe(2) } catch {}').length, 1);
  assert.equal(scan('try { register(() => { try { check(1).toBe(2) } catch {} }) } catch {}').length, 1);
});

test('assertion audit uses shared filename, test-directory and scoped archive selection', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assertion-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const included = ['package/normal.test.mjs', 'package/test/behavior.mjs', 'package/archive/active.spec.mjs'];
  const excluded = ['package/test/archive/old.test.mjs', 'generated/live.test.mjs', 'package/src/runtime.mjs', 'package/vitest.config.mjs'];
  for (const file of [...included, ...excluded]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "import assert from 'node:assert/strict'; try { assert.equal(1, 2); } catch {}\n");
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '--', ...included, ...excluded], { cwd: root });
  const run = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../../ci/check-swallowed-assertions.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.deepEqual(run.stderr.trim().split('\n').map(line => line.split(':')[0]).sort(), included.sort());
});
