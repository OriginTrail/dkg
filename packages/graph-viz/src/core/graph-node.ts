import type { GraphNode, NodeDecorations, RdfValue } from './types.js';

function effectiveDecoration<K extends keyof NodeDecorations>(node: GraphNode, key: K): NodeDecorations[K] {
  const override = node.viewOverrides[key];
  return override === undefined ? node.dataDecorations[key] : override;
}

/** Stable model identity with explicit data and view layers; no copied effective state. */
export class GraphModelNode implements GraphNode {
  types: string[] = [];
  label: string;
  properties = new Map<string, RdfValue[]>();
  metadata = new Map<string, RdfValue[]>();
  degree = 0;
  isBoundary = false;
  dataDecorations: NodeDecorations = { imageUrl: null };
  viewOverrides: Partial<NodeDecorations> = {};

  constructor(public id: string) { this.label = id; }

  // Existing property readers see the effective value. Application assignments
  // update data; applying a view writes only the explicit override layer.
  get imageUrl() { return effectiveDecoration(this, 'imageUrl'); }
  set imageUrl(value: string | null) { this.dataDecorations.imageUrl = value; }
  get riskScore() { return effectiveDecoration(this, 'riskScore'); }
  set riskScore(value: number | undefined) { this.dataDecorations.riskScore = value; }
  get isHighRisk() { return effectiveDecoration(this, 'isHighRisk'); }
  set isHighRisk(value: boolean | undefined) { this.dataDecorations.isHighRisk = value; }
  get sizeMultiplier() { return effectiveDecoration(this, 'sizeMultiplier'); }
  set sizeMultiplier(value: number | undefined) { this.dataDecorations.sizeMultiplier = value; }
}
