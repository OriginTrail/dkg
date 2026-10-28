#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

function isVar(value) {
  return typeof value === 'string' && value.startsWith('$');
}

function normalizeValue(value) {
  return value;
}

function loadYaml(filePath) {
  return yaml.load(fs.readFileSync(filePath, 'utf8'));
}

function tupleKey(tuple) {
  return JSON.stringify(tuple);
}

function normalizeVarName(value) {
  const str = String(value);
  return str.startsWith('$') ? str : `$${str}`;
}

class Evaluator {
  constructor(policy, facts) {
    this.policy = policy;
    this.relations = new Map();

    for (const factRow of facts) {
      const fact = [...factRow];
      const pred = fact[0];
      const args = fact.slice(1).map(normalizeValue);
      this._getRelation(pred).set(tupleKey(args), args);
    }
  }

  run() {
    this._deriveFixpoint();
    const decisions = this._evaluateDecisions();
    const derived = {};

    for (const rule of this.policy.rules ?? []) {
      derived[rule.name] = this._sortedTuples(this._getRelation(rule.name));
    }

    return { derived, decisions };
  }

  _deriveFixpoint() {
    const rules = this.policy.rules ?? [];
    const maxRounds = 64;

    for (let round = 0; round < maxRounds; round += 1) {
      let changed = false;

      for (const rule of rules) {
        const newTuples = this._evaluateRule(rule);
        const relation = this._getRelation(rule.name);
        const before = relation.size;

        for (const tuple of newTuples) {
          relation.set(tupleKey(tuple), tuple);
        }

        if (relation.size !== before) {
          changed = true;
        }
      }

      if (!changed) {
        return;
      }
    }

    throw new Error('fixpoint did not converge');
  }

  _evaluateRule(rule) {
    const params = (rule.params ?? []).map(normalizeVarName);
    const tuples = new Map();

    for (const binding of this._evaluateConditions(rule.all ?? [], [{}])) {
      const head = params.map((param) => binding[param]);
      tuples.set(tupleKey(head), head);
    }

    return tuples.values();
  }

  _evaluateDecisions() {
    const results = {};

    for (const decision of this.policy.decisions ?? []) {
      const params = (decision.params ?? []).map(normalizeVarName);
      const tuples = new Map();

      for (const binding of this._evaluateConditions(decision.all ?? [], [{}])) {
        const head = params.map((param) => binding[param]);
        tuples.set(tupleKey(head), head);
      }

      results[decision.name] = [...tuples.values()].sort(compareTuples);
    }

    return results;
  }

  _evaluateConditions(conditions, bindings) {
    let current = bindings;

    for (const cond of conditions) {
      const nextBindings = [];
      for (const binding of current) {
        nextBindings.push(...this._evaluateCondition(cond, binding));
      }
      current = nextBindings;
      if (current.length === 0) {
        break;
      }
    }

    return current;
  }

  _evaluateCondition(cond, binding) {
    if (cond.atom) {
      return this._matchAtom(cond.atom.pred, cond.atom.args ?? [], binding);
    }

    if (cond.exists) {
      const matches = this._evaluateConditions(cond.exists.where ?? [], [{ ...binding }]);
      return matches.length > 0 ? [binding] : [];
    }

    if (cond.not_exists) {
      const matches = this._evaluateConditions(cond.not_exists.where ?? [], [{ ...binding }]);
      return matches.length === 0 ? [binding] : [];
    }

    if (cond.count_distinct) {
      const spec = cond.count_distinct;
      const matches = this._evaluateConditions(spec.where ?? [], [{ ...binding }]);
      const vars = (spec.vars ?? []).map(normalizeVarName);
      const projection = new Set(matches.map((match) => tupleKey(vars.map((name) => match[name]))));
      return compareInts(projection.size, spec.op, Number(spec.value)) ? [binding] : [];
    }

    throw new Error(`Unsupported condition: ${JSON.stringify(cond)}`);
  }

  _matchAtom(pred, args, binding) {
    const out = [];
    const tuples = this._sortedTuples(this._getRelation(pred));

    for (const tuple of tuples) {
      if (tuple.length !== args.length) {
        continue;
      }

      const candidate = { ...binding };
      let ok = true;

      for (let i = 0; i < args.length; i += 1) {
        const term = args[i];
        const value = tuple[i];

        if (isVar(term)) {
          if (Object.hasOwn(candidate, term)) {
            if (candidate[term] !== value) {
              ok = false;
              break;
            }
          } else {
            candidate[term] = value;
          }
        } else if (normalizeValue(term) !== value) {
          ok = false;
          break;
        }
      }

      if (ok) {
        out.push(candidate);
      }
    }

    return out;
  }

  _getRelation(pred) {
    if (!this.relations.has(pred)) {
      this.relations.set(pred, new Map());
    }
    return this.relations.get(pred);
  }

  _sortedTuples(relation) {
    return [...relation.values()].map((tuple) => [...tuple]).sort(compareTuples);
  }
}

function compareInts(left, op, right) {
  switch (op) {
    case '>=':
      return left >= right;
    case '>':
      return left > right;
    case '==':
      return left === right;
    case '<=':
      return left <= right;
    case '<':
      return left < right;
    default:
      throw new Error(`Unsupported comparison operator: ${op}`);
  }
}

function compareTuples(left, right) {
  return tupleKey(left).localeCompare(tupleKey(right));
}

function runCase(policyPath, casePath) {
  const policy = loadYaml(policyPath);
  const testCase = loadYaml(casePath);
  const evaluator = new Evaluator(policy, testCase.facts);
  return evaluator.run();
}

function compareExpected(result, expected) {
  const normalizedResult = JSON.parse(JSON.stringify(result));
  const normalizedExpected = JSON.parse(JSON.stringify(expected));
  return {
    ok: JSON.stringify(normalizedResult) === JSON.stringify(normalizedExpected),
    detail: {
      result: normalizedResult,
      expected: normalizedExpected,
    },
  };
}

function resolvePolicyPath(casePath, policyArg) {
  return path.isAbsolute(policyArg) ? policyArg : path.resolve(path.dirname(casePath), '..', '..', 'policies', policyArg);
}

function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const checkIndex = args.indexOf('--check');
  const check = checkIndex !== -1;

  if (check) {
    args.splice(checkIndex, 1);
  }

  if (args.length !== 2) {
    console.error('Usage: node evaluator/reference_evaluator.js <policy> <case> [--check]');
    process.exitCode = 1;
    return;
  }

  const [policyArg, caseArg] = args;
  const casePath = path.resolve(caseArg);
  const policyPath = path.resolve(policyArg);
  const result = runCase(policyPath, casePath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (check) {
    const testCase = loadYaml(casePath);
    const comparison = compareExpected(result, testCase.expected);
    if (!comparison.ok) {
      process.stdout.write('\nEXPECTED MISMATCH\n');
      process.stdout.write(`${JSON.stringify(comparison.detail, null, 2)}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = {
  Evaluator,
  compareExpected,
  loadYaml,
  resolvePolicyPath,
  runCase,
};

if (require.main === module) {
  main();
}
