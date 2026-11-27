import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  characterizeFixtureV1,
  parseCharacterizationFixtureV1,
  parseLoadEnvelopeEvidenceV1,
} from './model.js';

interface CliOptions {
  readonly fixture: string;
  readonly json: boolean;
  readonly requireLoadEnvelope: boolean;
  readonly loadEnvelopeEvidence: string | null;
}

const here = dirname(fileURLToPath(import.meta.url));

export async function runCharacterizationCli(
  argv: readonly string[],
  write: (value: string) => void = (value) => process.stdout.write(value),
): Promise<number> {
  const options = parseArgs(argv);
  const fixturePath = resolveFixture(options.fixture);
  const fixture = parseCharacterizationFixtureV1(
    JSON.parse(await readFile(fixturePath, 'utf8')) as unknown,
  );
  const loadEnvelopeEvidence = options.loadEnvelopeEvidence === null
    ? null
    : parseLoadEnvelopeEvidenceV1(
      JSON.parse(await readFile(resolveInput(options.loadEnvelopeEvidence), 'utf8')) as unknown,
    );
  const result = characterizeFixtureV1(fixture, loadEnvelopeEvidence);

  if (options.json) {
    write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    write([
      `Fixture: ${result.fixtureId}`,
      `Profiles: ${result.activeProfiles} active (${result.candidateProfiles} candidate, ${result.ambiguousProfiles} ambiguous), ${result.staleProfiles} stale, ${result.unknownFreshnessProfiles} unknown`,
      `Profile bytes p50/p95/p99: ${result.profileStats.nquadsBytes.p50}/${result.profileStats.nquadsBytes.p95}/${result.profileStats.nquadsBytes.p99}`,
      `Tree: ${result.tree.minimumLeaves}-${result.tree.maximumLeaves} leaves, height <= ${result.tree.maximumHeight}`,
      `Load envelope: ${result.loadEnvelope.eligible ? 'eligible' : `blocked (${result.loadEnvelope.failures.join(', ')})`}`,
      `Invalid owned subjects: ${result.invalidOwnedSubjects.length}`,
      '',
    ].join('\n'));
  }

  if (result.invalidOwnedSubjects.length > 0) return 1;
  if (options.requireLoadEnvelope && !result.loadEnvelope.eligible) return 1;
  return 0;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let fixture = 'r27';
  let json = false;
  let requireLoadEnvelope = false;
  let loadEnvelopeEvidence: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--fixture') {
      const value = argv[++index];
      if (!value) throw new TypeError('--fixture requires a value');
      fixture = value;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--require-load-envelope') {
      requireLoadEnvelope = true;
    } else if (arg === '--load-envelope-evidence') {
      const value = argv[++index];
      if (!value) throw new TypeError('--load-envelope-evidence requires a value');
      loadEnvelopeEvidence = value;
    } else {
      throw new TypeError(`unknown argument: ${arg}`);
    }
  }
  return { fixture, json, requireLoadEnvelope, loadEnvelopeEvidence };
}

function resolveInput(value: string): string {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function resolveFixture(value: string): string {
  if (value === 'r27') return resolve(here, 'fixtures/r27-v1.json');
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCharacterizationCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `issue-2052 characterization failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 2;
    });
}
