// @vitest-environment happy-dom
//
// N6 polish (task #23) — AgentChip falls back to the URI tail when no
// resolved agent profile is available. Pre-fix, the full peer id
// (`12D3KooW…b9a3`, ~52 chars) or eth address (`0xaaaa…bbbb`, 42 chars)
// blew the pill layout. The fix truncates the FALLBACK identifier
// only — resolved agents keep their full human-readable `name`.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { AgentChip } from '../src/ui/components/AgentChip.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('AgentChip — fallback id truncation', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function nameOf(): string {
    return container.querySelector('.v10-agent-chip-name')?.textContent ?? '';
  }

  it('renders a "?" avatar instead of crashing for a separator-only name', () => {
    act(() => {
      root.render(React.createElement(AgentChip, {
        agent: { uri: 'did:dkg:agent:_', name: '_', kind: 'ai', color: '#888888' },
      }));
    });
    expect(container.querySelector('.v10-agent-chip-avatar')?.textContent).toContain('?');
    expect(nameOf()).toBe('_');
  });

  it('truncates a long libp2p peer id to head6+ellipsis+tail4', () => {
    const peer = '12D3KooWAbcdefghijklmnopqrstuvwxyz1234567890b9a3';
    act(() => {
      root.render(React.createElement(AgentChip, {
        agent: null,
        fallbackUri: peer,
      }));
    });
    expect(nameOf()).toBe('12D3Ko…b9a3');
  });

  it('truncates a long 0x… eth address to head6+ellipsis+tail4', () => {
    const addr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbb';
    act(() => {
      root.render(React.createElement(AgentChip, {
        agent: null,
        fallbackUri: addr,
      }));
    });
    expect(nameOf()).toBe('0xaaaa…bbbb');
  });

  it('uses the colon-split tail when the fallback URI is namespaced (did:...)', () => {
    // The split-on-colon keeps the existing behaviour, then truncation
    // applies to the tail. `did:dkg:agent:0xaaaaaa…bbbb` → tail is
    // the 42-char eth address, truncated to head6+…+tail4.
    const did = 'did:dkg:agent:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbb';
    act(() => {
      root.render(React.createElement(AgentChip, {
        agent: null,
        fallbackUri: did,
      }));
    });
    expect(nameOf()).toBe('0xaaaa…bbbb');
  });

  it('does NOT truncate when the fallback id is already short', () => {
    act(() => {
      root.render(React.createElement(AgentChip, {
        agent: null,
        fallbackUri: 'urn:agent:bob',
      }));
    });
    // tail-after-colon-split = 'bob', length 3 → no ellipsis.
    expect(nameOf()).toBe('bob');
  });

  it('uses the resolved agent name unchanged (truncation only on the fallback path)', () => {
    act(() => {
      root.render(React.createElement(AgentChip, {
        agent: {
          uri: 'did:dkg:agent:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbb',
          name: 'Alice Researcher',
          kind: 'human',
        } as any,
      }));
    });
    expect(nameOf()).toBe('Alice Researcher');
  });

  it('draws a registered framework icon, and the person or bot icon for any other framework name', () => {
    const glyph = (framework: string | undefined, kind: 'human' | 'ai' = 'ai') => {
      act(() => {
        root.render(React.createElement(AgentChip, {
          agent: { uri: 'did:dkg:agent:x', name: 'X', kind, color: '#888888', framework } as never,
        }));
      });
      return container.querySelector('.v10-agent-chip-glyph svg')?.getAttribute('class') ?? '';
    };
    expect(glyph('hermes')).toContain('lucide-feather');
    // Names from the graph that an object would resolve through its prototype.
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'unknown-framework']) {
      expect(glyph(name), name).toContain('lucide-bot');
      expect(glyph(name, 'human'), name).toContain('lucide-user');
    }
    expect(glyph(undefined)).toContain('lucide-bot');
  });

  it('opens the agent from Enter and Space when it can open one, and not from other keys', () => {
    const opened: string[] = [];
    act(() => {
      root.render(React.createElement(AgentChip, {
        agent: { uri: 'did:dkg:agent:alice', name: 'Alice', kind: 'ai', color: '#888888' },
        onOpenAgent: (uri: string) => opened.push(uri),
      }));
    });
    const chip = container.querySelector<HTMLElement>('.v10-agent-chip')!;
    expect(chip.getAttribute('role')).toBe('button');
    expect(chip.tabIndex).toBe(0);
    const press = (key: string) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => { chip.dispatchEvent(event); });
      return event.defaultPrevented;
    };
    expect(press('Enter')).toBe(true);
    expect(press(' ')).toBe(true);
    expect(press('a')).toBe(false);
    expect(opened).toEqual(['did:dkg:agent:alice', 'did:dkg:agent:alice']);
  });
});
