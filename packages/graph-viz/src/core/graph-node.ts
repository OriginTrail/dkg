import type { GraphNode, NodeDecorations, RdfValue } from './types.js';

function effectiveDecoration<K extends keyof NodeDecorations>(node: GraphNode, key: K): NodeDecorations[K] {
  const highlight = node.highlightOverrides[key];
  if (highlight !== undefined) return highlight;
  const view = node.viewOverrides[key];
  if (view !== undefined) return view;
  const application = node.applicationOverrides[key];
  return application === undefined ? node.dataDecorations[key] : application;
}

/** Each producer owns its layer; effective values never become another layer's baseline. */
export class GraphModelNode implements GraphNode {
  types: string[] = [];
  label: string;
  properties = new Map<string, RdfValue[]>();
  metadata = new Map<string, RdfValue[]>();
  degree = 0;
  isBoundary = false;
  dataDecorations: NodeDecorations = { imageUrl: null };
  applicationOverrides: Partial<NodeDecorations> = {};
  viewOverrides: Partial<NodeDecorations> = {};
  highlightOverrides: Partial<NodeDecorations> = {};

  constructor(public id: string) { this.label = id; }

  // Public assignments belong to the application; RDF ingestion, declarative
  // views and transient highlighting each update their own explicit layer.
  get imageUrl() { return effectiveDecoration(this, 'imageUrl'); }
  set imageUrl(value: string | null) { this.applicationOverrides.imageUrl = value; }
  get riskScore() { return effectiveDecoration(this, 'riskScore'); }
  set riskScore(value: number | undefined) { this.applicationOverrides.riskScore = value; }
  get isHighRisk() { return effectiveDecoration(this, 'isHighRisk'); }
  set isHighRisk(value: boolean | undefined) { this.applicationOverrides.isHighRisk = value; }
  get sizeMultiplier() { return effectiveDecoration(this, 'sizeMultiplier'); }
  set sizeMultiplier(value: number | undefined) { this.applicationOverrides.sizeMultiplier = value; }
}
