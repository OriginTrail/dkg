import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
let component;
let stopped = false;
const send = value => { if (process.connected && !stopped) process.send(value); };
process.on('message', async message => {
  try {
    if (message.type === 'start') {
      if (component) throw new Error('Already initialized');
      const { instantiate } = await import(pathToFileURL(join(message.directory, 'component.js')).href);
      component = await instantiate(async filename => WebAssembly.compile(await readFile(join(message.directory, filename))), {});
      component.start(message.inputs);
    } else if (message.type === 'settle') component.settle(message.id, message.result);
    else throw new Error('Unknown host request');
    const state = component.inspect();
    if (Buffer.byteLength(state) > 262144) throw new Error('Program response exceeds 256 KiB');
    send({ type: 'state', state, ...(message.type === 'settle' ? { completedId: message.id } : {}) });
  } catch (error) {
    send({ type: 'error', error: String(error).slice(0, 2048) });
    stopped = true;
  }
});
