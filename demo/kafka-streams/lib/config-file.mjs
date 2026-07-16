import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function parseScalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) ? value.slice(1, -1) : value;
}

export function parseConfigYaml(text) {
  const root = {};
  let section;
  let listKey;

  for (const [idx, rawLine] of text.split('\n').entries()) {
    const line = stripYamlComment(rawLine);
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = line.match(/^ */)[0].length;

    if (trimmed.startsWith('- ')) {
      if (!section || !listKey) continue;
      root[section][listKey].push(parseScalar(trimmed.slice(2).trim()));
      continue;
    }

    const colon = trimmed.indexOf(':');
    if (colon <= 0) throw new Error(`line ${idx + 1}: expected "key: value"`);
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();

    if (indent === 0) {
      root[key] = value === '' ? {} : parseScalar(value);
      section = value === '' ? key : undefined;
      listKey = undefined;
    } else if (section) {
      root[section][key] = value === '' ? [] : parseScalar(value);
      listKey = value === '' ? key : undefined;
    } else {
      throw new Error(`line ${idx + 1}: nested key has no parent key`);
    }
  }

  return root;
}

function stripYamlComment(line) {
  let quote;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

export async function readDkgConfig(dkgHome, { tolerateMalformed = false } = {}) {
  for (const [file, parser, label] of [
    ['config.json', JSON.parse, 'JSON'],
    ['config.yaml', parseConfigYaml, 'YAML'],
  ]) {
    const path = join(dkgHome, file);
    if (!existsSync(path)) continue;
    try {
      return { config: parser(await readFile(path, 'utf-8')) };
    } catch (err) {
      if (!tolerateMalformed) {
        throw new Error(`${path} cannot be read as ${label}: ${err?.message ?? err}`);
      }
    }
  }

  return { config: undefined };
}
