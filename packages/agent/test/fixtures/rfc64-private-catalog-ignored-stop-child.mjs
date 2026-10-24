// SPDX-License-Identifier: Apache-2.0

process.on('SIGTERM', () => {
  // Deliberately ignore the first forced-shutdown signal.
});
process.stdin.resume();
process.stdout.write('RFC64_PRIVATE_EVENT {"event":"ready","role":"ignored-stop"}\n');
setInterval(() => undefined, 60_000);
