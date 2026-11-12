import { describe, expect, it } from 'vitest';
import { corsPreflightHeaders } from '../src/daemon/cors-preflight.js';

describe('the daemon\'s answer to a CORS preflight', () => {
  it('lets an allowed origin send the read-graph settings actor with its token, besides the signing headers', () => {
    const headers = corsPreflightHeaders('https://ui.example');
    expect(headers['Access-Control-Allow-Origin']).toBe('https://ui.example');
    expect(headers['Access-Control-Allow-Methods']).toContain('PUT');
    const allowed = headers['Access-Control-Allow-Headers']!.split(',').map((name) => name.trim().toLowerCase());
    expect(allowed).toEqual(expect.arrayContaining(['authorization', 'content-type', 'x-dkg-actor']));
  });

  it('names no origin when every origin is allowed', () => {
    expect(corsPreflightHeaders(null)).not.toHaveProperty('Access-Control-Allow-Origin');
  });
});
