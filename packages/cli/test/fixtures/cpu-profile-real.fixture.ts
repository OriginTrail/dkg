// Records real CPU profiles with the node's recorder, in a process of its own:
// ending an inspector session that enabled the profiler resets V8's precise
// coverage for the whole isolate, which would cost the test runner's worker
// its coverage. Usage: <directory>. Prints one CPU_PROFILE_FIXTURE line.
import { url as inspectorListenerUrl } from 'node:inspector';
import { Session } from 'node:inspector/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CpuProfileRecorder } from '../../src/daemon/cpu-profile.js';

const directory = process.argv[2];
if (!directory) throw new Error('usage: cpu-profile-real.fixture.ts <directory>');

const sessions: Session[] = [];
const recorder = new CpuProfileRecorder({
  openSession: async () => {
    const session = new Session();
    sessions.push(session);
    return session;
  },
});

/** Named so the profile can be checked for function names. */
function cpuProfileFixtureBusyLoop(): number {
  let total = 0;
  for (let i = 0; i < 2_000_000; i++) total += Math.sqrt(i);
  return total;
}

/** A disconnected session refuses every message. */
async function isClosed(session: Session): Promise<boolean> {
  try {
    await session.post('Profiler.enable');
    return false;
  } catch (error) {
    return (error as { code?: string }).code === 'ERR_INSPECTOR_NOT_CONNECTED';
  }
}

const busy = setInterval(cpuProfileFixtureBusyLoop, 5);
const result = await recorder.record({ seconds: 1, clamped: false, directory });
clearInterval(busy);

// A recording that fails at the write must close its session as well.
const blocked = join(directory, 'blocked');
await writeFile(blocked, '');
const failure = await recorder.record({ seconds: 0.2, clamped: false, directory: blocked })
  .then(() => 'written', (error: { code?: string }) => error.code ?? 'unknown');

console.log(`CPU_PROFILE_FIXTURE ${JSON.stringify({
  result,
  failure,
  closed: await Promise.all(sessions.map(isClosed)),
  listener: inspectorListenerUrl() ?? null,
})}`);
