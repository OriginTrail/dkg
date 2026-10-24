import type { Sprite, Texture } from 'three';

export interface SpriteTexture {
  texture: Texture;
  image?: HTMLImageElement;
}

/** The scene mapper owns attached materials; the cache alone owns shared maps. */
export function retireIconSprite(sprite: Sprite): void {
  sprite.material.map = null;
  // An icon not yet attached to the scene was never transferred to its mapper.
  if (!sprite.parent) sprite.material.dispose();
}
