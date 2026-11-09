import { afterEach, describe, expect, it, vi } from 'vitest';
import { DkgClient } from '../src/client.js';
import { fetchManifest } from '../src/manifest/fetch.js';
import { ManifestP, manifestUri } from '../src/manifest/schema.js';
import { makeConfig } from './harness.js';

const graph = 'team-a';
const manifest = manifestUri(graph);
const fieldPredicates = {
  cursorRule: ManifestP.cursorRule,
  cursorHooksTemplate: ManifestP.cursorHooksTemplate,
  claudeHooksTemplate: ManifestP.claudeHooksTemplate,
  configTemplate: ManifestP.configTemplate,
  agentsMd: ManifestP.agentsMd,
  cursorMcpJson: 'http://dkg.io/ontology/onboarding/cursorMcpTemplate',
};
const row = (p: string, o: string) => ({ p, o });

function fixture(entities: Record<string, unknown>) {
  const requests: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe('http://localhost:9200/api/query');
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const uri = /^SELECT \?p \?o WHERE \{ <([^>]+)> \?p \?o \}$/.exec(body.sparql)?.[1];
    if (!uri || !(uri in entities)) throw new Error(`Unexpected query: ${body.sparql}`);
    const data = entities[uri];
    if (data instanceof Error) throw data;
    return new Response(JSON.stringify({ result: { bindings: data } }));
  });
  return { client: new DkgClient({ config: makeConfig(), fetcher }), requests, fetcher };
}

afterEach(() => vi.restoreAllMocks());

describe('manifest fetch scope and validation', () => {
  it('dereferences every template inside the requested meta graph and normalizes RDF bindings', async () => {
    const text = 'A quoted "rule"\nwith a tab\tand Unicode Ž';
    const entities: Record<string, unknown> = {
      [manifest]: [
        {}, row('', 'ignored'),
        row(`<${ManifestP.network}>`, '"testnet"@en'),
        row(ManifestP.supportedTools, '"cursor"'),
        row(ManifestP.supportedTools, "'claude-code'"),
        row(ManifestP.supportedTools, 'unsupported-editor'),
        row(ManifestP.requiresMcpDkgVersion, '^10.0.0'),
        row('http://purl.org/dc/terms/title', 'Team A'),
        row('http://purl.org/dc/terms/created', '2026-01-01T00:00:00Z'),
        row(ManifestP.publishedBy, '<urn:agent:curator>'),
        row(ManifestP.ontology, '<urn:ontology:team-a>'),
        ...Object.entries(fieldPredicates).map(([key, predicate]) => row(predicate, `<urn:template:${key}>`)),
      ],
    };
    for (const key of Object.keys(fieldPredicates)) {
      entities[`urn:template:${key}`] = [
        { p: { type: 'uri', value: 'http://schema.org/text' }, o: { type: 'literal', value: `${JSON.stringify(text)}^^<http://www.w3.org/2001/XMLSchema#string>` } },
        row('http://schema.org/encodingFormat', 'text/markdown'),
        row('urn:unrelated', 'ignored'),
      ];
    }
    const { client, requests } = fixture(entities);
    const result = await fetchManifest({ client, contextGraphId: graph });
    expect(result).toMatchObject({ uri: manifest, contextGraphId: graph, title: 'Team A',
      supportedTools: ['cursor', 'claude-code'], network: 'testnet', requiresMcpDkgVersion: '^10.0.0',
      publishedBy: 'urn:agent:curator', publishedAt: '2026-01-01T00:00:00Z', ontologyUri: 'urn:ontology:team-a' });
    for (const key of Object.keys(fieldPredicates)) {
      expect(result).toHaveProperty(key, { uri: `urn:template:${key}`, encodingFormat: 'text/markdown', text });
    }
    expect(requests).toHaveLength(7);
    for (const request of requests) {
      expect(request).toEqual({ sparql: expect.any(String), contextGraphId: graph, subGraphName: 'meta', includeSharedMemory: true });
      expect(request.sparql).not.toMatch(/GRAPH\s/i);
    }
  });

  it('keeps available templates when another template fetch fails or has no text', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client } = fixture({
      [manifest]: [row(ManifestP.network, 'devnet'), row(ManifestP.agentsMd, 'urn:good'),
        row(ManifestP.cursorRule, 'urn:missing'), row(ManifestP.configTemplate, 'urn:empty')],
      'urn:good': [row('http://schema.org/text', 'working instructions')],
      'urn:missing': new Error('connection lost'), 'urn:empty': [],
    });
    const result = await fetchManifest({ client, contextGraphId: graph });
    expect(result.agentsMd).toEqual({ uri: 'urn:good', text: 'working instructions', encodingFormat: 'text/plain' });
    expect(result.cursorRule).toBeUndefined();
    expect(result.configTemplate).toBeUndefined();
    expect(result.supportedTools).toEqual(['cursor']);
    expect(warning).toHaveBeenCalledExactlyOnceWith('[manifest] failed to fetch template cursorRule at urn:missing: connection lost');
  });

  it.each([[], undefined, [{}]])('rejects an absent manifest (%#)', async bindings => {
    const { client, fetcher } = fixture({ [manifest]: bindings });
    await expect(fetchManifest({ client, contextGraphId: graph })).rejects.toThrow("No manifest published for context graph 'team-a'");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { path: 'network', bindings: [row(ManifestP.network, 'unknown')] },
    { path: 'supportedTools', bindings: [row(ManifestP.network, 'testnet'), row(ManifestP.supportedTools, 'unknown')] },
    { path: 'publishedAt', bindings: [row(ManifestP.network, 'testnet'), row('http://purl.org/dc/terms/created', 'yesterday')] },
  ])('rejects corrupt $path metadata', async ({ path, bindings }) => {
    const { client } = fixture({ [manifest]: bindings });
    await expect(fetchManifest({ client, contextGraphId: graph })).rejects.toMatchObject({
      name: 'ZodError', issues: expect.arrayContaining([expect.objectContaining({ path: [path] })]),
    });
  });

  it('propagates failure of the manifest query instead of treating it as a missing optional template', async () => {
    const error = new Error('daemon unavailable');
    const { client } = fixture({ [manifest]: error });
    await expect(fetchManifest({ client, contextGraphId: graph })).rejects.toBe(error);
  });
});

it('ignores null binding rows and treats typed non-binding responses as missing manifest data', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ result: { type: 'boolean', value: false } }))
    .mockResolvedValueOnce(
      Response.json({
        result: {
          type: 'bindings',
          bindings: [
            null,
            row(ManifestP.network, 'testnet'),
            row(ManifestP.agentsMd, 'urn:template'),
          ],
        },
      }),
    )
    .mockResolvedValueOnce(Response.json({ result: { type: 'quads', quads: [] } }));
  const client = new DkgClient({ config: makeConfig(), fetcher });
  await expect(fetchManifest({ client, contextGraphId: graph })).rejects.toThrow(
    'No manifest published',
  );
  const result = await fetchManifest({ client, contextGraphId: graph });
  expect(result.network).toBe('testnet');
  expect(result.agentsMd).toBeUndefined();
});
