import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

/** Evaluate emitted native expressions, including the actual admission node. */
export function nativeExpression(compiled, value, packet, item = {}) {
  assert.ok(value.startsWith('={{ ') && value.endsWith(' }}'));
  const parsed = [];
  let admitted;
  const evaluate = expression => runInNewContext(expression.slice(3, -2), {
    $json: item,
    $input: { all: () => [{ json: item }] },
    $: name => {
      if (name === 'Receive input') return { first: () => ({ json: { body: { input: packet } } }) };
      assert.equal(name, 'Admit arguments');
      admitted ??= evaluate(compiled.workflow.nodes.find(n => n.name === name).parameters.jsonOutput);
      return { first: () => ({ json: admitted }) };
    },
    JSON: { stringify: JSON.stringify, parse: text => {
      const result = JSON.parse(text); parsed.push(result); return result;
    } },
  }, { timeout: 1000 });
  return { result: JSON.parse(JSON.stringify(evaluate(value))), parsed };
}
