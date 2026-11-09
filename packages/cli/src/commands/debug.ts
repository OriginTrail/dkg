import type { Command } from 'commander';
import { ApiClient } from '../api-client.js';
import { parsePositiveIntegerOption } from '../cli-option-parsers.js';
import {
  CPU_PROFILE_DEFAULT_SECONDS,
  CPU_PROFILE_MAX_SECONDS,
  CPU_PROFILE_MIN_SECONDS,
} from '../cpu-profile-wire.js';

export function registerDebugCommand(program: Command): void {
  const debug = program.command('debug').description('Diagnostics for node operators');
  debug.command('cpu-profile')
    .description('Record a CPU profile of the running node and print where the node wrote it (node-admin token)')
    .option('--seconds <n>',
      `How long to record, ${CPU_PROFILE_MIN_SECONDS}-${CPU_PROFILE_MAX_SECONDS} s`, String(CPU_PROFILE_DEFAULT_SECONDS))
    .action(async (options: { seconds: string }) => {
      try {
        const seconds = parsePositiveIntegerOption(options.seconds, '--seconds');
        const client = await ApiClient.connect();
        console.log(`Recording a CPU profile for ${Math.min(seconds, CPU_PROFILE_MAX_SECONDS)} s...`);
        const result = await client.recordCpuProfile(seconds);
        if (result.clamped) console.log(`The node clamped the duration to ${result.seconds} s.`);
        if (result.stoppedEarly) console.log('The node began to shut down, so the profile ended early.');
        console.log(`Wrote ${result.path} (${result.bytes} bytes) on the node's host.`);
        console.log('Open it in Chrome DevTools (Performance panel) or any .cpuprofile viewer.');
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}
