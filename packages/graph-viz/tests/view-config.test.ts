import { describe, it, expect, beforeEach } from 'vitest';
import { GraphModel } from '../src/core/graph-model.js';
import { applyViewConfig } from '../src/core/view-config.js';
import type { ViewConfig, HighlightConfig } from '../src/core/view-config.js';

/**
 * Helper: add a post node with a sentinel property to the model.
 * Property is attached via a known namespace so getAnyNS can find it.
 */
function addPostWithProperty(
  model: GraphModel,
  postUri: string,
  property: string,
  value: string | number,
) {
  // Create the node via a type triple
  model.addTriple({
    subject: postUri,
    predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
    object: 'https://schema.org/SocialMediaPosting',
  });
  // Attach the property via a known namespace
  model.addTriple({
    subject: postUri,
    predicate: `https://guardiankg.org/vocab/${property}`,
    object: String(value),
  });
}

/**
 * Helper: add a linked sentiment node and edge from a post.
 */
function addLinkedSentiment(
  model: GraphModel,
  postUri: string,
  sentimentUri: string,
  sentimentScore: number,
  threatCategory: string = 'none',
) {
  // Link post → sentiment via hasSentiment
  model.addTriple({
    subject: postUri,
    predicate: 'https://guardiankg.org/vocab/hasSentiment',
    object: sentimentUri,
  });
  // Sentiment score
  model.addTriple({
    subject: sentimentUri,
    predicate: 'https://guardiankg.org/vocab/sentimentScore',
    object: String(sentimentScore),
  });
  // Threat category
  model.addTriple({
    subject: sentimentUri,
    predicate: 'https://guardiankg.org/vocab/threatCategory',
    object: threatCategory,
  });
}

describe('applyViewConfig', () => {
  let model: GraphModel;

  beforeEach(() => {
    model = new GraphModel();
  });

  // ------- Focal Entity -------

  describe('focal entity', () => {
    it('sets sizeMultiplier on the focal node', () => {
      model.addTriple({
        subject: 'https://guardiankg.org/resource/person/alice',
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'https://schema.org/Person',
      });

      const config: ViewConfig = {
        name: 'test',
        focal: {
          uri: 'https://guardiankg.org/resource/person/alice',
          sizeMultiplier: 3.0,
        },
      };

      applyViewConfig(config, model);
      const node = model.nodes.get('https://guardiankg.org/resource/person/alice')!;
      expect(node.sizeMultiplier).toBe(3.0);
    });

    it('defaults focal sizeMultiplier to 1.5', () => {
      model.addTriple({
        subject: 'https://guardiankg.org/resource/person/alice',
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'https://schema.org/Person',
      });

      const config: ViewConfig = {
        name: 'test',
        focal: {
          uri: 'https://guardiankg.org/resource/person/alice',
        },
      };

      applyViewConfig(config, model);
      const node = model.nodes.get('https://guardiankg.org/resource/person/alice')!;
      expect(node.sizeMultiplier).toBe(1.5);
    });

    it('sets imageUrl on the focal node', () => {
      model.addTriple({
        subject: 'https://guardiankg.org/resource/person/alice',
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'https://schema.org/Person',
      });

      const config: ViewConfig = {
        name: 'test',
        focal: {
          uri: 'https://guardiankg.org/resource/person/alice',
          image: '/data/alice-avatar.png',
        },
      };

      applyViewConfig(config, model);
      const node = model.nodes.get('https://guardiankg.org/resource/person/alice')!;
      expect(node.imageUrl).toBe('/data/alice-avatar.png');
    });
  });

  // ------- Highlight (normal mode) -------

  describe('highlight (normal mode)', () => {
    it('marks nodes above threshold as high-risk', () => {
      addPostWithProperty(model, 'https://example.org/post1', 'postRiskScore', 5000);
      addPostWithProperty(model, 'https://example.org/post2', 'postRiskScore', 100);
      addPostWithProperty(model, 'https://example.org/post3', 'postRiskScore', 0.5);

      const config: ViewConfig = {
        name: 'test',
        highlight: {
          property: 'postRiskScore',
          threshold: 50,
          color: '#d44',
          topN: 10,
        },
      };

      applyViewConfig(config, model);

      const post1 = model.nodes.get('https://example.org/post1')!;
      const post2 = model.nodes.get('https://example.org/post2')!;
      const post3 = model.nodes.get('https://example.org/post3')!;

      expect(post1.isHighRisk).toBe(true);
      expect(post2.isHighRisk).toBe(true);
      expect(post3.isHighRisk).toBeUndefined();
    });

    it('gives highest-scoring node the largest sizeMultiplier (normal mode)', () => {
      addPostWithProperty(model, 'https://example.org/a', 'postRiskScore', 1000);
      addPostWithProperty(model, 'https://example.org/b', 'postRiskScore', 100);

      const config: ViewConfig = {
        name: 'test',
        highlight: {
          property: 'postRiskScore',
          threshold: 50,
          color: '#d44',
          topN: 10,
          sizeMin: 1.0,
          sizeMax: 3.0,
        },
      };

      applyViewConfig(config, model);

      const a = model.nodes.get('https://example.org/a')!;
      const b = model.nodes.get('https://example.org/b')!;

      expect(a.sizeMultiplier).toBeGreaterThan(b.sizeMultiplier!);
    });

    it('respects topN limit', () => {
      // Create 5 high-risk posts
      for (let i = 0; i < 5; i++) {
        addPostWithProperty(model, `https://example.org/post${i}`, 'postRiskScore', 100 + i * 50);
      }

      const config: ViewConfig = {
        name: 'test',
        highlight: {
          property: 'postRiskScore',
          threshold: 50,
          color: '#d44',
          topN: 3,
        },
      };

      applyViewConfig(config, model);

      const highRiskNodes = [...model.nodes.values()].filter(n => n.isHighRisk);
      expect(highRiskNodes.length).toBe(3);
    });
  });

  // ------- Highlight (inverted mode) -------

  describe('highlight (inverted mode)', () => {
    it('marks nodes below threshold as high-risk when invert=true', () => {
      // Low sentiment = risky
      addPostWithProperty(model, 'https://example.org/risky', 'sentimentScore', 0.1);
      addPostWithProperty(model, 'https://example.org/moderate', 'sentimentScore', 0.4);
      addPostWithProperty(model, 'https://example.org/safe', 'sentimentScore', 0.9);

      const config: ViewConfig = {
        name: 'test',
        highlight: {
          property: 'sentimentScore',
          threshold: 0.5,
          invert: true,
          color: '#d44',
          topN: 10,
        },
      };

      applyViewConfig(config, model);

      const risky = model.nodes.get('https://example.org/risky')!;
      const moderate = model.nodes.get('https://example.org/moderate')!;
      const safe = model.nodes.get('https://example.org/safe')!;

      expect(risky.isHighRisk).toBe(true);
      expect(moderate.isHighRisk).toBe(true);
      expect(safe.isHighRisk).toBeUndefined();
    });

    it('gives lowest-scoring node the largest sizeMultiplier (inverted mode)', () => {
      addPostWithProperty(model, 'https://example.org/very-risky', 'sentimentScore', 0.05);
      addPostWithProperty(model, 'https://example.org/somewhat-risky', 'sentimentScore', 0.3);
      addPostWithProperty(model, 'https://example.org/borderline', 'sentimentScore', 0.49);

      const config: ViewConfig = {
        name: 'test',
        highlight: {
          property: 'sentimentScore',
          threshold: 0.5,
          invert: true,
          color: '#d44',
          topN: 10,
          sizeMin: 1.0,
          sizeMax: 3.0,
        },
      };

      applyViewConfig(config, model);

      const veryRisky = model.nodes.get('https://example.org/very-risky')!;
      const borderline = model.nodes.get('https://example.org/borderline')!;

      // Very risky (lowest score) should get the BIGGEST size when inverted
      expect(veryRisky.sizeMultiplier).toBeGreaterThan(borderline.sizeMultiplier!);
    });

    it('does NOT mark nodes above threshold when inverted', () => {
      addPostWithProperty(model, 'https://example.org/safe1', 'sentimentScore', 0.8);
      addPostWithProperty(model, 'https://example.org/safe2', 'sentimentScore', 1.0);

      const config: ViewConfig = {
        name: 'test',
        highlight: {
          property: 'sentimentScore',
          threshold: 0.5,
          invert: true,
          color: '#d44',
          topN: 10,
        },
      };

      applyViewConfig(config, model);

      const safe1 = model.nodes.get('https://example.org/safe1')!;
      const safe2 = model.nodes.get('https://example.org/safe2')!;

      expect(safe1.isHighRisk).toBeUndefined();
      expect(safe2.isHighRisk).toBeUndefined();
    });
  });

  // ------- Highlight with linked properties -------

  describe('highlight with linked properties', () => {
    it('follows linkedVia edges to resolve property values', () => {
      // Post with linked sentiment
      model.addTriple({
        subject: 'https://example.org/post1',
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'https://schema.org/SocialMediaPosting',
      });
      addLinkedSentiment(model, 'https://example.org/post1', 'https://example.org/sent1', 0.1);

      const config: ViewConfig = {
        name: 'test',
        highlight: {
          property: 'sentimentScore',
          source: 'linked',
          linkedVia: 'hasSentiment',
          threshold: 0.5,
          invert: true,
          color: '#d44',
          topN: 10,
        },
      };

      applyViewConfig(config, model);

      const post = model.nodes.get('https://example.org/post1')!;
      expect(post.isHighRisk).toBe(true);
      expect(post.riskScore).toBeCloseTo(0.1, 5);
    });
  });

  // ------- SizeBy -------

  describe('sizeBy', () => {
    it('scales node sizeMultiplier based on a numeric property (log scale)', () => {
      addPostWithProperty(model, 'https://example.org/viral', 'totalInteractions', 1000000);
      addPostWithProperty(model, 'https://example.org/quiet', 'totalInteractions', 10);

      const config: ViewConfig = {
        name: 'test',
        sizeBy: {
          property: 'totalInteractions',
          scale: 'log',
        },
      };

      applyViewConfig(config, model);

      const viral = model.nodes.get('https://example.org/viral')!;
      const quiet = model.nodes.get('https://example.org/quiet')!;

      // Viral post should be bigger
      expect(viral.sizeMultiplier).toBeGreaterThan(quiet.sizeMultiplier!);
      // Both should be in the valid range [0.5, 3.0]
      expect(viral.sizeMultiplier).toBeLessThanOrEqual(3.0);
      expect(quiet.sizeMultiplier).toBeGreaterThanOrEqual(0.5);
    });

    it('does not override focal node sizeMultiplier', () => {
      model.addTriple({
        subject: 'https://guardiankg.org/resource/person/alice',
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'https://schema.org/Person',
      });
      addPostWithProperty(model, 'https://example.org/post', 'totalInteractions', 500);

      const config: ViewConfig = {
        name: 'test',
        focal: {
          uri: 'https://guardiankg.org/resource/person/alice',
          sizeMultiplier: 5.0,
        },
        sizeBy: {
          property: 'totalInteractions',
        },
      };

      applyViewConfig(config, model);

      const alice = model.nodes.get('https://guardiankg.org/resource/person/alice')!;
      expect(alice.sizeMultiplier).toBe(5.0);
    });
  });

  // ------- Platform Icons -------

  describe('platform icons', () => {
    it('assigns icon via URL fallback patterns', () => {
      model.addTriple({
        subject: 'https://youtube.com/watch?v=abc123',
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'https://schema.org/SocialMediaPosting',
      });

      const config: ViewConfig = {
        name: 'test',
        platformIcons: {
          icons: {
            youtube: 'data:image/svg+xml,<svg>YT</svg>',
          },
          urlFallbacks: {
            'youtube.com': 'youtube',
          },
        },
      };

      applyViewConfig(config, model);

      const node = model.nodes.get('https://youtube.com/watch?v=abc123')!;
      expect(node.imageUrl).toBe('data:image/svg+xml,<svg>YT</svg>');
    });
  });

  // ------- Edge cases -------

  describe('edge cases', () => {
    it('handles empty model gracefully', () => {
      const config: ViewConfig = {
        name: 'test',
        focal: { uri: 'https://example.org/nonexistent' },
        highlight: {
          property: 'score',
          threshold: 50,
          color: '#f00',
        },
      };

      // Should not throw
      expect(() => applyViewConfig(config, model)).not.toThrow();
    });

    it('handles nodes without the highlight property', () => {
      // Node without the property
      model.addTriple({
        subject: 'https://example.org/plain',
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'https://schema.org/Thing',
      });

      const config: ViewConfig = {
        name: 'test',
        highlight: {
          property: 'nonExistentProp',
          threshold: 50,
          color: '#f00',
        },
      };

      applyViewConfig(config, model);

      const node = model.nodes.get('https://example.org/plain')!;
      expect(node.isHighRisk).toBeUndefined();
      expect(node.riskScore).toBeUndefined();
    });

    it('all nodes equal score get size 1.0 in continuous scaling', () => {
      addPostWithProperty(model, 'https://example.org/a', 'score', 100);
      addPostWithProperty(model, 'https://example.org/b', 'score', 100);

      const config: ViewConfig = {
        name: 'test',
        highlight: {
          property: 'score',
          threshold: 50,
          color: '#f00',
          topN: 10,
          sizeMin: 1.0,
          sizeMax: 3.0,
        },
      };

      applyViewConfig(config, model);

      // When all scores are equal, normalized defaults to 1.0
      const a = model.nodes.get('https://example.org/a')!;
      expect(a.sizeMultiplier).toBe(3.0); // 1.0 + 1.0 * (3.0 - 1.0)
    });
  });
});


describe('ViewConfig decoration boundaries', () => {
  const type = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const property = (model: GraphModel, id: string, key: string, value: string) => model.addTriple({ subject: id, predicate: 'https://schema.org/' + key, object: value });

  it('chooses platform edges before URL fallbacks and preserves existing application images', () => {
    const model = new GraphModel();
    for (const id of ['urn:post', 'https://site.invalid/post', 'urn:existing']) model.addTriple({ subject: id, predicate: type, object: 'https://schema.org/SocialMediaPosting' });
    model.addTriple({ subject: 'urn:post', predicate: 'https://schema.org/platform', object: 'https://platform.invalid/unknown' });
    model.addTriple({ subject: 'urn:post', predicate: 'https://schema.org/platform', object: 'https://platform.invalid/video' });
    model.getNode('urn:existing')!.imageUrl = 'application.png';
    applyViewConfig({ name: 'platforms', platformIcons: { icons: { video: 'video.svg', web: 'web.svg' }, urlFallbacks: { 'missing': 'unknown', 'site.invalid': 'web' } } }, model);
    expect(model.getNode('urn:post')!.imageUrl).toBe('video.svg');
    expect(model.getNode('https://site.invalid/post')!.imageUrl).toBe('web.svg');
    expect(model.getNode('urn:existing')!.imageUrl).toBe('application.png');
  });
  it.each(['https://schema.org/Person', 'schema:Person', 'vocab:Person', 'Person'])('assigns node type icons using %s aliases', key => {
    const model = new GraphModel();
    model.addTriple({ subject: 'urn:a', predicate: type, object: 'https://schema.org/Person' });
    model.addTriple({ subject: 'urn:b', predicate: type, object: 'https://schema.org/Unknown' });
    applyViewConfig({ name: 'types', nodeTypes: { [key]: { icon: 'person.svg' }, Unknown: { color: 'red' } } }, model);
    expect(model.getNode('urn:a')?.imageUrl).toBe('person.svg');
    expect(model.getNode('urn:b')?.imageUrl).toBeNull();
    model.getNode('urn:a')!.imageUrl = 'app.png';
    applyViewConfig({ name: 'types', nodeTypes: { [key]: { icon: 'person.svg' } } }, model);
    expect(model.getNode('urn:a')?.imageUrl).toBe('app.png');
  });
  it.each([false, true])('scores negative sentiment by magnitude with inversion %s and ignores invalid values', invert => {
    const model = new GraphModel();
    for (const [id, value] of [['low', '-.2'], ['high', '-.8'], ['invalid', 'not numeric'], ['zero', '0']]) property(model, 'urn:' + id, 'score', value);
    applyViewConfig({ name: 'risk', focal: { uri: 'urn:high', sizeMultiplier: 5 }, highlight: { property: 'score', threshold: .5, color: 'red', invert } }, model);
    expect(model.getNode('urn:low')?.isHighRisk).toBe(invert ? true : undefined);
    expect(model.getNode('urn:high')?.isHighRisk).toBe(invert ? undefined : true);
    expect(model.getNode('urn:high')?.riskScore).toBe(.8);
    expect(model.getNode('urn:high')?.sizeMultiplier).toBe(5);
    expect(model.getNode('urn:invalid')?.riskScore).toBeUndefined();
  });
  it.each(['linear', 'log'] as const)('scales %s values at endpoints and gives equal values a middle size', scale => {
    const model = new GraphModel();
    for (const [id, value] of [['min', '10'], ['max', '100'], ['negative', '-1'], ['zero', '0'], ['invalid', 'oops']]) property(model, 'urn:' + id, 'count', value);
    applyViewConfig({ name: 'sizes', sizeBy: { property: 'count', scale } }, model);
    expect(model.getNode('urn:min')?.sizeMultiplier).toBe(.5);
    expect(model.getNode('urn:max')?.sizeMultiplier).toBe(3);
    expect(model.getNode('urn:negative')?.sizeMultiplier).toBeUndefined();
    expect(model.getNode('urn:zero')?.sizeMultiplier).toBeUndefined();
    expect(model.getNode('urn:invalid')?.sizeMultiplier).toBeUndefined();
    const same = new GraphModel();
    property(same, 'urn:a', 'count', '10');
    property(same, 'urn:b', 'count', '10');
    applyViewConfig({ name: 'equal', sizeBy: { property: 'count', scale } }, same);
    expect([...same.nodes.values()].map(n => n.sizeMultiplier)).toEqual([1.75, 1.75]);
  });
  it('finds a focal entity across namespace variants and ignores linked entities without a score', () => {
    const model = new GraphModel();
    property(model, 'https://umanitek.ai/dkg/person/alice', 'name', 'Alice');
    model.addTriple({ subject: 'urn:post', predicate: 'urn:hasScore', object: 'urn:unscored' });
    applyViewConfig({ name: 'aliases', focal: { uri: 'https://other.invalid/person/alice' }, highlight: { source: 'linked', linkedVia: 'hasScore', property: 'score', threshold: 1, color: 'red' } }, model);
    expect(model.getNode('https://umanitek.ai/dkg/person/alice')?.sizeMultiplier).toBe(1.5);
    expect(model.getNode('urn:post')?.isHighRisk).toBeUndefined();
  });
});
