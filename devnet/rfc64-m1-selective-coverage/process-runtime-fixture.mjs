import { createInterface } from 'node:readline';

const commandSchema = 'dkg-rfc64-m1-selective-coverage-runtime-command-v1';
const resultSchema = 'dkg-rfc64-m1-selective-coverage-runtime-result-v1';
const protocol = 'dkg-rfc64-m1-selective-coverage-runtime-v1';
const prefix = 'DKG_RFC64_M1_RESULT ';
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on('line', (line) => {
  const input = JSON.parse(line);
  if (input.schema !== commandSchema || input.protocol !== protocol) process.exit(12);
  let value = null;
  if (input.command === 'start') {
    if (Object.keys(input.payload).sort().join(',') !== 'role') process.exit(13);
    const role = input.payload.role;
    value = {
      protocol,
      role,
      pid: process.pid,
      peerId: `${role}-peer`,
      networkId: process.env.FIXTURE_NETWORK_ID,
      testedHeadCommit: process.env.FIXTURE_SOURCE_COMMIT,
      runtimeManifestDigest: process.env.FIXTURE_RUNTIME_MANIFEST,
      processStartedAt: 100,
      processInstanceId: `${role}-instance`,
      dataDirectoryIdentity: `${role}-data`,
      evidenceWaveId: `${role}-wave`,
    };
  }
  process.stdout.write(`${prefix}${JSON.stringify({
    schema: resultSchema,
    protocol,
    sessionNonce: input.sessionNonce,
    sequence: input.sequence,
    ok: true,
    value,
  })}\n`);
  if (input.command === 'shutdown') process.exit(0);
});
