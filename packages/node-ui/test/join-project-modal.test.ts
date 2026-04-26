import { describe, it, expect } from 'vitest';
import { parseInviteCode, validateInvite } from '../src/ui/components/Modals/JoinProjectModal.js';

describe('JoinProjectModal invite parsing', () => {
  it('parses multiline invite codes with wrapped multiaddr', () => {
    const raw = [
      '0xabc/project',
      '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M/p2p-',
      'circuit/p2p/12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
    ].join('\n');

    const parsed = parseInviteCode(raw);
    expect(parsed.cgId).toBe('0xabc/project');
    expect(parsed.multiaddr).toBe('/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M/p2p-circuit/p2p/12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6');
  });

  it('parses single-line invite codes with inline multiaddr', () => {
    const raw = '0xabc/project /ip4/127.0.0.1/tcp/9090/p2p/12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const parsed = parseInviteCode(raw);
    expect(parsed.cgId).toBe('0xabc/project');
    expect(parsed.multiaddr).toBe('/ip4/127.0.0.1/tcp/9090/p2p/12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('validates missing peer id in multiaddr', () => {
    expect(validateInvite('0xabc/project', '/ip4/127.0.0.1/tcp/9090')).toBe('Curator multiaddr is missing peer ID');
  });
});
