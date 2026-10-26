import test from 'node:test';
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


test('only a local incident-linked explanation exempts a reviewed catch', () => {
  const body = 'try { check(1).toBe(2) } catch {}';
  assert.deepEqual(scan('// qa-assertion-catch: GH-3478 -- Catch asserts the domain type; AssertionError is rejected.\n'+body), []);
  assert.equal(scan('// qa-assertion-catch: ignore\n'+body).length, 1);
  assert.equal(scan('// qa-assertion-catch: GH-3478 -- Catch asserts the domain type; AssertionError is rejected.\noperation();\n'+body).length, 1);
});

test('a reviewed outer catch does not exempt independent catches inside callbacks', () => {
  assert.equal(scan('// qa-assertion-catch: GH-3478 -- Catch checks the domain type and rejects AssertionError.\n'
    + 'try { register(() => { try { check(1).toBe(2) } catch {} }) } catch {}').length, 1);
});
