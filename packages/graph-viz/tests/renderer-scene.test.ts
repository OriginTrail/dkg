// @vitest-environment happy-dom
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { WebGL3DRenderer } from '../src/core/renderer-3d.js';
import { GraphEventEmitter } from '../src/core/events.js';

// Resolve the real scene mapper used by the installed 3d-force-graph. No
// WebGL context is needed to test its object ownership and disposal behavior.
const require = createRequire(import.meta.url);
const mapperPath = createRequire(require.resolve('3d-force-graph')).resolve('three-forcegraph');
const { default: ThreeForceGraph } = await import(pathToFileURL(mapperPath).href);
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('3D renderer with the real Three.js scene mapper', () => {
  it('retains icons on repeated renders and releases shared textures only after their last owner', async () => {
    const scene = new ThreeForceGraph();
    const renderer = new WebGL3DRenderer({
      container: document.createElement('div'), events: new GraphEventEmitter(),
      hexPainter: { setMaxDegree: () => {}, getRadius: () => 28 } as any,
      styleEngine: {} as any,
    });
    const internal = renderer as any;
    internal._THREE = THREE; internal._graph = scene;
    const texture = new THREE.Texture(); const disposeTexture = vi.spyOn(texture, 'dispose');
    const replacement = new THREE.Texture(); const disposeReplacement = vi.spyOn(replacement, 'dispose');
    internal._textureLoader = { load: (url: string) => url.endsWith('/icon.png') ? texture : replacement };
    scene.nodeThreeObject((node: any) => node._graphNode.imageUrl ? internal._createIconSprite(node._graphNode) : undefined);
    const node = { id: 'urn:a', degree: 1, imageUrl: 'https://example.invalid/icon.png' } as any;
    const peer = { ...node, id: 'urn:b' };
    try {
      renderer.render(new Map([[node.id, node], [peer.id, peer]]), new Map()); await settle();
      expect(scene.children).toHaveLength(2);
      const sprite = internal._iconSprites.get(node.id).sprite;
      const material = sprite.material; const disposeMaterial = vi.spyOn(material, 'dispose');
      const forceNode = internal._currentNodes.get(node.id);
      for (let i = 0; i < 3; i++) {
        renderer.render(new Map([[node.id, { ...node }], [peer.id, { ...peer }]]), new Map()); await settle();
        expect(scene.children).toHaveLength(2);
        expect(sprite.parent).toBe(scene);
        expect(internal._currentNodes.get(node.id)).toBe(forceNode);
      }
      renderer.render(new Map([[peer.id, peer]]), new Map()); await settle();
      expect(scene.children).toHaveLength(1);
      expect(disposeMaterial).toHaveBeenCalledOnce();
      expect(disposeTexture).not.toHaveBeenCalled();
      // View application mutates GraphNode decorations in place.
      peer.imageUrl = 'https://example.invalid/replacement.png';
      renderer.render(new Map([[peer.id, peer]]), new Map()); await settle();
      expect(internal._iconSprites.get(peer.id).sprite.parent).toBe(scene);
      expect(internal._iconSprites.get(peer.id).sprite.material.map).toBe(replacement);
      expect(disposeTexture).toHaveBeenCalledOnce();
      peer.imageUrl = undefined;
      renderer.render(new Map([[peer.id, peer]]), new Map()); await settle();
      expect(scene.children).toHaveLength(1);
      expect(scene.children[0].isMesh).toBe(true);
      expect(disposeTexture).toHaveBeenCalledOnce();
      expect(disposeReplacement).toHaveBeenCalledOnce();
    } finally {
      renderer.destroy(); scene.graphData({ nodes: [], links: [] }); await settle();
    }
  });
});
