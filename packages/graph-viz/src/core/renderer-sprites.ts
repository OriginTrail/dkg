import type { Sprite, SpriteMaterial, Texture } from 'three';

export interface SpriteTexture {
  texture: Texture;
  image?: HTMLImageElement;
}

/** Transfer a retired icon to three-forcegraph without transferring its shared texture. */
export function disposeIconSprite(sprite: Sprite): void {
  sprite.parent?.remove(sprite);
  sprite.material.dispose();
  // three-forcegraph otherwise disposes both the material and its map again.
  // Only this retirement adapter may detach a live Sprite's material contract.
  const retiring: { material: SpriteMaterial | null } = sprite;
  retiring.material = null;
}
