const fs = require('node:fs');

function loadSurfacePolicy(filePath) {
  return compileSurfacePolicy(fs.readFileSync(filePath, 'utf8'));
}

function compileSurfacePolicy(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const policy = { kind: 'canonical_policy', rules: [], decisions: [] };
  let index = 0;

  while (index < lines.length) {
    const raw = lines[index];
    const line = raw.trim();
    index += 1;
    if (!line) continue;

    const policyMatch = line.match(/^policy\s+(\w+)\s+v([^\s]+)$/);
    if (policyMatch) {
      policy.policy = policyMatch[1];
      policy.version = policyMatch[2];
      continue;
    }

    const headMatch = line.match(/^(rule|decision)\s+(\w+)\(([^)]*)\):$/);
    if (!headMatch) {
      throw new Error(`Unsupported CCL line: ${line}`);
    }

    const kind = headMatch[1];
    const name = headMatch[2];
    const params = splitArgs(headMatch[3]);
    const parsed = parseBlock(lines, index, 2);
    index = parsed.nextIndex;

    const entry = { name, params, all: parsed.conditions };
    if (kind === 'rule') policy.rules.push(entry);
    else policy.decisions.push(entry);
  }

  return policy;
}

function parseBlock(lines, startIndex, indent) {
  const conditions = [];
  let index = startIndex;

  while (index < lines.length) {
    const raw = lines[index];
    if (!raw.trim()) {
      index += 1;
      continue;
    }

    const currentIndent = raw.match(/^ */)[0].length;
    if (currentIndent < indent) break;
    if (currentIndent > indent) {
      throw new Error(`Unexpected indentation: ${raw}`);
    }

    const line = raw.trim();

    if (line.startsWith('count_distinct ')) {
      const match = line.match(/^count_distinct\s+([\w]+(?:\s*,\s*[\w]+)*)\s+where$/);
      if (!match) throw new Error(`Invalid count_distinct syntax: ${line}`);
      const vars = match[1].split(/\s*,\s*/);
      const nested = parseBlock(lines, index + 1, indent + 2);
      const compareLine = lines[nested.nextIndex]?.trim();
      const compareMatch = compareLine?.match(/^(>=|<=|==|>|<)\s+(\d+)$/);
      if (!compareMatch) throw new Error(`Expected comparator after count_distinct: ${compareLine ?? '<eof>'}`);
      conditions.push({
        count_distinct: {
          vars,
          where: nested.conditions,
          op: compareMatch[1],
          value: Number(compareMatch[2]),
        },
      });
      index = nested.nextIndex + 1;
      continue;
    }

    if (line.startsWith('exists ') || line.startsWith('not exists ')) {
      const match = line.match(/^(exists|not exists)\s+(\w+)\s+where$/);
      if (!match) throw new Error(`Invalid existential syntax: ${line}`);
      const nested = parseBlock(lines, index + 1, indent + 2);
      const key = match[1] === 'exists' ? 'exists' : 'not_exists';
      conditions.push({ [key]: { vars: [match[2]], where: nested.conditions } });
      index = nested.nextIndex;
      continue;
    }

    conditions.push({ atom: parseAtom(line) });
    index += 1;
  }

  return { conditions, nextIndex: index };
}

function parseAtom(line) {
  const match = line.match(/^(\w+)\((.*)\)$/);
  if (!match) throw new Error(`Invalid atom syntax: ${line}`);
  return {
    pred: match[1],
    args: splitArgs(match[2]).map(toCanonicalArg),
  };
}

function splitArgs(value) {
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function toCanonicalArg(value) {
  if (/^[A-Z][A-Za-z0-9_]*$/.test(value)) return `$${value}`;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

module.exports = {
  compileSurfacePolicy,
  loadSurfacePolicy,
};
