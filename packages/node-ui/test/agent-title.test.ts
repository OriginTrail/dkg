// @vitest-environment happy-dom
//
// An agent's page is titled with AgentTitle: the shared page title beside the
// avatar, with no pill and no link back to the page you're on.
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { AgentTitle } from '../src/ui/components/AgentChip.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('AgentTitle', () => {
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

  const render = (agent: Parameters<typeof AgentTitle>[0]['agent'], fallbackUri = 'did:dkg:agent:research') => {
    act(() => { root.render(React.createElement(AgentTitle, { agent, fallbackUri })); });
  };

  it('uses the shared page title, with no pill or link', () => {
    render({ uri: 'did:dkg:agent:research', name: 'Research Agent', kind: 'ai', color: '#888888', framework: 'claude-code', operatorName: 'Sample operator' });
    const heading = container.querySelector('h1');
    expect(heading?.className).toBe('ds-page-title');
    expect(heading?.textContent).toBe('Research Agent');
    expect(container.querySelector('.v10-agent-chip')).toBeNull();
    expect(container.querySelector('[role="button"]')).toBeNull();
  });

  it('keeps the avatar, framework and operator', () => {
    render({ uri: 'did:dkg:agent:research', name: 'Research Agent', kind: 'ai', color: '#888888', framework: 'claude-code', operatorName: 'Sample operator' });
    expect(container.querySelector('.v10-agent-chip-avatar')?.textContent).toContain('RA');
    expect(container.querySelector('.v10-agent-chip-sub')?.textContent).toBe('claude-code·driven by Sample operator');
  });

  it('shortens the id of an agent with no name, and shows no empty line', () => {
    render(null, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbb');
    expect(container.querySelector('h1')?.textContent).toBe('0xaaaa…bbbb');
    expect(container.querySelector('.v10-agent-chip-sub')).toBeNull();
  });
});
