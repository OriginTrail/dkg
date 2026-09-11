// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';

import {
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_HTTP_BODY_BYTES,
  failure,
} from './common.mjs';
import { validateCommandV1 } from './config.mjs';

export async function runBoundedCommandV1(command, timeoutMs = 60_000) {
  validateCommandV1(command);
  const [file, ...args] = command.argv;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderrBytes = 0;
    let settled = false;
    let terminationError = null;
    let killTimer;
    const terminate = (error) => {
      if (terminationError !== null) return;
      terminationError = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    };
    const timer = setTimeout(() => terminate(failure('command-timeout', 'command')), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_COMMAND_OUTPUT_BYTES) {
        terminate(failure('command-output-too-large', 'command'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_COMMAND_OUTPUT_BYTES) {
        terminate(failure('command-output-too-large', 'command'));
      }
    });
    child.once('error', () => finish(failure('command-start-failed', 'command')));
    child.once('exit', (code, signal) => {
      finish(terminationError, Object.freeze({ code, signal, stdout }));
    });
  });
}

/** Create a requester whose timeout covers headers and bounded body consumption. */
export function createRequesterV1({ fetchFn, readFileFn, secrets, timing }) {
  async function authorization(node, override = 'node') {
    if (override === 'none' || node.auth.kind === 'none') return {};
    let secret = secrets.get(node.id);
    if (secret === undefined) {
      let secretText;
      try {
        secretText = await readFileFn(node.auth.secretFile, 'utf8');
      } catch (error) {
        throw failure('auth-secret-read-failed', 'authentication', error);
      }
      secret = secretText.trim();
      if (secret.length < 1 || secret.length > 4096 || /[\r\n]/u.test(secret)) {
        throw failure('auth-secret-malformed', 'authentication');
      }
      secrets.set(node.id, secret);
    }
    return { Authorization: `Bearer ${secret}` };
  }

  async function raw(node, method, path, body, authOverride = 'node') {
    const url = safeNodeUrl(node.baseUrl, path);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timing.requestTimeoutMs);
    try {
      const response = await fetchFn(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...await authorization(node, authOverride),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await readBodyBoundedV1(response, controller.signal);
      return Object.freeze({ status: response.status, text });
    } catch (error) {
      if (error?.code === 'node-response-too-large') throw error;
      throw failure('node-request-failed', 'http', error);
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    raw,
    async json(node, method, path, body) {
      const response = await raw(node, method, path, body);
      if (response.status < 200 || response.status >= 300) {
        throw failure('node-http-status-failed', 'http');
      }
      return parseResponseJsonV1(response, 'node-json-malformed');
    },
    async reachable(node) {
      try {
        await raw(node, 'HEAD', '/api/status');
        return true;
      } catch {
        return false;
      }
    },
  });
}

export function parseResponseJsonV1(response, code) {
  try {
    return JSON.parse(response.text);
  } catch {
    throw failure(code, 'http');
  }
}

async function readBodyBoundedV1(response, signal) {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let abortListener;
  const aborted = new Promise((resolve, reject) => {
    abortListener = () => {
      reader.cancel().catch(() => undefined);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HTTP_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw failure('node-response-too-large', 'http');
      }
      chunks.push(Buffer.from(value));
    }
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    signal.removeEventListener('abort', abortListener);
    reader.releaseLock();
  }
}

function safeNodeUrl(baseUrl, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw failure('unsafe-node-path', 'http');
  }
  const base = new URL(baseUrl);
  const resolved = new URL(path, base);
  if (resolved.origin !== base.origin || resolved.username || resolved.password || resolved.hash) {
    throw failure('unsafe-node-path', 'http');
  }
  return resolved;
}
