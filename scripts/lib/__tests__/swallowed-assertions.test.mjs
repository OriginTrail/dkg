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


test('comments cannot exempt swallowed assertions, including independent callback catches', () => {
  assert.equal(scan('// reviewed exception\ntry { check(1).toBe(2) } catch {}').length, 1);
  assert.equal(scan('try { register(() => { try { check(1).toBe(2) } catch {} }) } catch {}').length, 1);
});
