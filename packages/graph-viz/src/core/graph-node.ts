import type { GraphNode, NodeDecorations, ProvenanceInfo, RdfValue } from './types.js';

/** Each producer owns its layer; effective values never become another layer's baseline. */
export class GraphModelNode implements GraphNode {
  types: string[] = [];
  label: string;
  properties = new Map<string, RdfValue[]>();
  metadata = new Map<string, RdfValue[]>();
  degree = 0;
  isBoundary = false;
  provenance?: ProvenanceInfo;
  #source: NodeDecorations = { imageUrl: null };
  #application: Partial<NodeDecorations> = {};
  #view: Partial<NodeDecorations> = {};
  #highlight: Partial<NodeDecorations> = {};

  constructor(public id: string) { this.label = id; }

  private effective<K extends keyof NodeDecorations>(key: K): NodeDecorations[K] {
    const highlight = this.#highlight[key];
    if (highlight !== undefined) return highlight;
    const view = this.#view[key];
    if (view !== undefined) return view;
    const application = this.#application[key];
    return application === undefined ? this.#source[key] : application;
  }

  // Producer operations are internal to the model; callback consumers see
  // only GraphNode's effective values and public application assignments.
  setSourceImage(value: string | null): void { this.#source.imageUrl = value; }
  clearView(): void { this.#view = {}; }
  setViewDecoration<K extends keyof NodeDecorations>(key: K, value: NodeDecorations[K]): void { this.#view[key] = value; }
  highlight(): void { this.#highlight = { isHighRisk: true, sizeMultiplier: Math.max(this.sizeMultiplier ?? 1, 2) }; }
  clearHighlight(): void { this.#highlight = {}; }

  // Public assignments belong to the application; RDF ingestion, declarative
  // views and transient highlighting each update their own explicit layer.
  get imageUrl() { return this.effective('imageUrl'); }
  set imageUrl(value: string | null) { this.#application.imageUrl = value; }
  get riskScore() { return this.effective('riskScore'); }
  set riskScore(value: number | undefined) { this.#application.riskScore = value; }
  get isHighRisk() { return this.effective('isHighRisk'); }
  set isHighRisk(value: boolean | undefined) { this.#application.isHighRisk = value; }
  get sizeMultiplier() { return this.effective('sizeMultiplier'); }
  set sizeMultiplier(value: number | undefined) { this.#application.sizeMultiplier = value; }
}
