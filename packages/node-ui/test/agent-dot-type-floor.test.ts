/** Avatar initials size themselves inline, so the CSS type check can't see them. */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentDot, AgentDotStack } from '../src/ui/components/AgentDot.js';

const sizes = (html: string) => [...html.matchAll(/font-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));

describe('agent avatar text', () => {
  it('stays at or above the 11px floor at every avatar size', () => {
    for (const size of [14, 16, 18, 20, 24]) {
      const dot = renderToStaticMarkup(React.createElement(AgentDot, { uri: 'did:dkg:agent:0x1', label: 'Ana Bevc', size }));
      expect(sizes(dot)[0], `size ${size}`).toBeGreaterThanOrEqual(11);
    }
  });

  it('keeps the overflow count at the floor, and lets it grow past the circle', () => {
    const agents = Array.from({ length: 20 }, (_, i) => ({ uri: `did:dkg:agent:0x${i}` }));
    const html = renderToStaticMarkup(React.createElement(AgentDotStack, { agents, max: 6, size: 16 }));
    expect(Math.min(...sizes(html))).toBeGreaterThanOrEqual(11);
    expect(html).toContain('min-width:16px');
  });
});
