import { describe, it, expect } from 'vitest';
import { procNetLocalPortHex } from '../src/daemon/oxigraph-listen-port.js';

describe('procNetLocalPortHex', () => {
  it('formats the local port in big-endian hex for /proc/net/tcp matching', () => {
    // The /proc/net/tcp port is NOT byte-swapped (only the IPv4 address is).
    expect(procNetLocalPortHex(7878)).toBe('1EC6');
    expect(procNetLocalPortHex(8080)).toBe('1F90');
  });
});
