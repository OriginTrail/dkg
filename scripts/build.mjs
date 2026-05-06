#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const forwardedArgs = process.argv.slice(2);

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }

  if (result.signal) {
    console.error(`${command} ${args.join(' ')} exited via ${result.signal}`);
    process.exit(1);
  }
}

if (forwardedArgs.length > 0) {
  run('turbo', ['build', ...forwardedArgs]);
} else {
  run('turbo', ['build']);
  run('pnpm', [
    'turbo',
    'run',
    'build:ui',
    '--filter=@origintrail-official/dkg-node-ui',
  ]);
}
