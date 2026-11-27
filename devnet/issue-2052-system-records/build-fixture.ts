import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCharacterizationFixtureV1,
  type CharacterizationSourceV1,
} from './model.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function runBuildFixtureCli(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  const source = JSON.parse(await readFile(options.source, 'utf8')) as CharacterizationSourceV1;
  const encoded = `${JSON.stringify(buildCharacterizationFixtureV1(source), null, 2)}\n`;
  if (options.check) {
    const existing = await readFile(options.output, 'utf8');
    if (existing !== encoded) {
      process.stderr.write(`fixture drift: ${options.output}\n`);
      return 1;
    }
    process.stdout.write(`fixture reproducible: ${options.output}\n`);
    return 0;
  }
  await writeFile(options.output, encoded, 'utf8');
  process.stdout.write(`wrote fixture: ${options.output}\n`);
  return 0;
}

function parseArgs(argv: readonly string[]): {
  readonly source: string;
  readonly output: string;
  readonly check: boolean;
} {
  let source = resolve(here, 'inputs/r27-redacted-source-v1.json');
  let output = resolve(here, 'fixtures/r27-v1.json');
  let check = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') {
      check = true;
      continue;
    }
    const value = argv[++index];
    if (!value) throw new TypeError(`${arg} requires a value`);
    if (arg === '--source') source = resolve(value);
    else if (arg === '--output') output = resolve(value);
    else throw new TypeError(`unknown argument: ${arg}`);
  }
  return { source, output, check };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBuildFixtureCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `fixture build failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 2;
    });
}
