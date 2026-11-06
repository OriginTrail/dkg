import { describe, expect, it } from 'vitest';
import { agentInitials } from '../src/ui/components/AgentDot.js';
import { agentHexForUri } from '../src/ui/hooks/useAgents.js';
import { agentNodeColors, AGENT_GRAPH_TYPES, buildLayerGraphOptions } from '../src/ui/views/project/helpers.js';
import { graphPalette } from '../src/ui/graph-palette.js';
import { VIZ_AGENT_TYPE } from '../src/ui/hooks/useVerifiableMemoryAnchors.js';
import { overviewRoleState } from '../src/ui/views/project/components/overview-role.js';

// Agents have one shape everywhere: the chip's initials circle. Graph nodes,
// legends, rosters and notifications share the colour and the initials.

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DID = 'did:dkg:agent:0xa4c123b1612dd272d1371c17149d439536b3216f';

describe('agent initials', () => {
  it('matches the chip rule and reads addresses by their hex', () => {
    expect(agentInitials('Claude Code')).toBe('CC');
    expect(agentInitials('hermes')).toBe('HE');
    expect(agentInitials('0xa4c1…216f')).toBe('A4');
    expect(agentInitials(DID)).toBe('A4');
    expect(agentInitials('  ')).toBe('?');
  });

  it('falls back instead of throwing for separator-only names and empty DID suffixes', () => {
    for (const name of ['_', '-', '__--__', ' _ ', '"_"', 'did:dkg:agent:', 'did:dkg:agent:_']) {
      expect(agentInitials(name)).toBe('?');
    }
    expect(agentInitials('_hermes_')).toBe('HE');
  });

  it('strips long runs of quotes in linear time', () => {
    const quotes = '"'.repeat(50_000);
    const started = performance.now();
    expect(agentInitials(`${quotes}Claude Code${quotes}`)).toBe('CC');
    expect(agentInitials(`${quotes}x`)).toBe('X');
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('agent node colours', () => {
  it('keeps graph-supplied agent IRIs that are not valid percent-encoding, and still colours the rest', () => {
    const bad = ['urn:dkg:viz:agent:%FF', 'urn:dkg:viz:agent:%E0%A4%A', 'urn:dkg:viz:agent:100%'];
    const good = `urn:dkg:viz:agent:${encodeURIComponent(DID)}`;
    const triples = [...bad, good].map(subject => ({ subject, predicate: RDF_TYPE, object: '<http://dkg.io/ontology/agent/AIAgent>' }));
    let colors: Record<string, string> = {};
    expect(() => { colors = agentNodeColors(triples); }).not.toThrow();
    expect(colors['urn:dkg:viz:agent:%FF']).toBe(agentHexForUri('%FF'));
    expect(colors[good]).toBe(agentHexForUri(DID));
    for (const uri of bad) expect(colors[uri]).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('colours VM signer nodes by the DID in their URN, like the SWM legend', () => {
    const urn = `urn:dkg:viz:agent:${encodeURIComponent(DID)}`;
    const colors = agentNodeColors([{ subject: urn, predicate: RDF_TYPE, object: VIZ_AGENT_TYPE }]);
    expect(colors[urn]).toBe(agentHexForUri(DID));
  });

  it('colours agent profile entities by their own URI, like their chip', () => {
    const uri = 'urn:agent:claude-code';
    const colors = agentNodeColors([
      { subject: `<${uri}>`, predicate: RDF_TYPE, object: '<http://dkg.io/ontology/agent/AIAgent>' },
      { subject: 'urn:x', predicate: RDF_TYPE, object: 'https://schema.org/Thing' },
    ]);
    expect(colors).toEqual({ [uri]: agentHexForUri(uri) });
  });

  it('draws agent types as avatars and hides VM edge labels until zoomed in', () => {
    const vm = buildLayerGraphOptions('vm', graphPalette('dark'));
    for (const t of AGENT_GRAPH_TYPES) expect(vm.style.classAppearance[t]).toEqual({ shape: 'avatar' });
    expect(vm.style.edgeLabelMinZoom).toBeGreaterThan(1);
    expect(buildLayerGraphOptions('swm', graphPalette('dark')).style.edgeLabelMinZoom).toBe(0.3);
  });
});

describe('role ladder', () => {
  const me = { agentDid: DID };
  it('gives each role its own step', () => {
    expect(overviewRoleState({ curator: DID }, me, 'ok', [], 'ok').rank).toBe('curator');
    expect(overviewRoleState({ callerInvolved: true }, me, 'ok', [], 'ok').rank).toBe('joined');
    expect(overviewRoleState({ callerInvolved: false, accessPolicy: 'public', subscribed: true }, me, 'ok', [], 'ok').rank).toBe('subscriber');
    expect(overviewRoleState({ callerInvolved: false, accessPolicy: 'public' }, me, 'ok', [], 'ok').rank).toBe('viewer');
    expect(overviewRoleState({ callerInvolved: false, accessPolicy: 'private' }, me, 'ok', [], 'ok').rank).toBe('not-joined');
    expect(overviewRoleState({}, me, 'ok', [], 'ok').rank).toBe('unknown');
  });
});
