// Preloaded into the daemon processes of the member-sharing suite's temporary
// Edges (NODE_OPTIONS --require, temporary-edges.mjs). A detached daemon's
// supervisor runs its worker with every stream ignored and keeps no record of
// how the worker ended, so a worker that dies is started again with nothing said
// anywhere. This keeps that in the node's folder, and only observes:
//
//   worker-exits.jsonl: how each worker ended as its supervisor saw it (exit
//   code or signal) and, from the worker itself, an exit it saw coming, with the
//   stack that called it, and an exception nothing caught.
//   worker-stderr.log: the worker's stderr, the only place a V8 or native fatal
//   error goes.
//
// A signal in the first with nothing from the worker itself is a death the
// worker could not see: a crash, or a signal from outside.
'use strict';

const childProcess = require('node:child_process');
const { appendFileSync, closeSync, openSync } = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const { join } = require('node:path');

const home = process.env.DKG_HOME;
// A preload runs in every thread too, but a thread's argv does not carry this: only the process itself has a role.
const role = ['daemon-supervisor', 'daemon-worker'].find(name => process.argv.includes(name));

function trace(fields) {
  try {
    appendFileSync(join(home, 'worker-exits.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), role, pid: process.pid, ...fields })}\n`);
  } catch { /* a trace that cannot be written must not change what it watches */ }
}

if (home && role === 'daemon-supervisor') {
  const { spawn } = childProcess;
  childProcess.spawn = function tracedSpawn(command, args, options) {
    if (!args?.includes('daemon-worker')) return spawn.call(this, command, args, options);
    let stderr;
    try {
      stderr = openSync(join(home, 'worker-stderr.log'), 'a');
    } catch {
      return spawn.call(this, command, args, options);
    }
    try {
      const child = spawn.call(this, command, args, { ...options, stdio: ['ignore', 'ignore', stderr] });
      child.once('exit', (code, signal) => trace({ event: 'worker-exit', worker: child.pid, code, signal }));
      return child;
    } finally {
      closeSync(stderr);
    }
  };
  syncBuiltinESMExports();
  process.on('exit', code => trace({ event: 'supervisor-exit', code }));
} else if (home && role === 'daemon-worker') {
  process.on('exit', code => trace({ event: 'exit', code, stack: new Error('exit').stack }));
  process.on('uncaughtExceptionMonitor', (error, origin) => trace({ event: 'uncaught', origin, stack: error?.stack ?? String(error) }));
}
