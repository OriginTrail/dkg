/** A CSS colour: channels 0–255 and alpha 0–1. */
export interface Colour { rgb: [number, number, number]; alpha: number }
/** Reads a CSS colour, or returns null if it isn't one. See colour.mjs for the formats. */
export function parseColour(value: string): Colour | null;
