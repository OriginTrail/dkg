// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';

import {
  BoundedResponseBodyLimitError,
  readResponseBodyBytesBounded,
} from '@origintrail-official/dkg-http-utils';

import { validateCommandV1 } from './command-policy.mjs';
import { RemoteCanaryError, failure } from './errors.mjs';

export const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const MAX_HTTP_BODY_BYTES = 1_048_576;

export async function runBoundedCommandV1(command, timeoutMs = 60_000, options = {}) {
  validateCommandV1(command);
  const [file, ...args] = command.argv;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationError = null;
    let killTimer;
    const terminate = (error) => {
      if (terminationError !== null) return;
      terminationError = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), options.terminationGraceMs ?? 5_000);
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
      if (terminationError !== null) {
        options.observeRetainedOutputBytes?.({ stdoutBytes, stderrBytes });
        return;
      }
      const chunkBytes = Buffer.byteLength(chunk);
      if (chunkBytes > MAX_COMMAND_OUTPUT_BYTES - stdoutBytes) {
        terminate(failure('command-output-too-large', 'command'));
      } else {
        stdout += chunk;
        stdoutBytes += chunkBytes;
      }
      options.observeRetainedOutputBytes?.({ stdoutBytes, stderrBytes });
    });
    child.stderr.on('data', (chunk) => {
      if (terminationError !== null) {
        options.observeRetainedOutputBytes?.({ stdoutBytes, stderrBytes });
        return;
      }
      if (chunk.length > MAX_COMMAND_OUTPUT_BYTES - stderrBytes) {
        terminate(failure('command-output-too-large', 'command'));
      } else {
        stderrBytes += chunk.length;
      }
      options.observeRetainedOutputBytes?.({ stdoutBytes, stderrBytes });
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
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw failure('node-redirect-rejected', 'http');
      }
      const text = await readBodyBoundedV1(response, controller.signal);
      return Object.freeze({ status: response.status, text });
    } catch (error) {
      if (error instanceof RemoteCanaryError) throw error;
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
      } catch (error) {
        if (error instanceof RemoteCanaryError && error.code === 'node-request-failed') return false;
        throw error;
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
  const boundedResponse = response.body === null
    ? response
    : new Response(response.body.pipeThrough(new TransformStream(), { signal }), {
        headers: response.headers,
      });
  try {
    const bytes = await readResponseBodyBytesBounded(boundedResponse, MAX_HTTP_BODY_BYTES);
    return Buffer.from(bytes).toString('utf8');
  } catch (error) {
    if (error instanceof BoundedResponseBodyLimitError) {
      throw failure('node-response-too-large', 'http');
    }
    throw error;
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
