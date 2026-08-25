// v3.5 canonical Model KA — content-addressed model identity that offerings
// REFERENCE instead of each carrying their own loose copy of "what model".
//
//   Model id:  ⛓ weights digest (sha256 of the GGUF) — the model IS the bytes
//              ☁ the upstream model string — an upstream-claimed identity
//   Normalized predicates: family · displayName · logoRef · contextLength ·
//   quantization · modality — exactly what the catalog UI groups and renders.
//
// The UI rule that pairs with this (CLAUDE.md §7): endpoints render ONLY from
// the live signed quote; the Model KA carries identity, never endpoints.
import type { OfferingBinding } from "./binding.js";
import { NSM, type Quad } from "./offering.js";

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

export interface ModelKaInput {
  provenanceClass: "weights-pinned" | "upstream-claimed";
  id: string;                 // ⛓: "sha256:<gguf>"; ☁: upstream model string
  family: string;             // "qwen" | "openai" | …
  displayName: string;        // "Qwen2.5 14B Instruct"
  logoRef: string;            // "assets/model-logos/qwen.svg" (local, licensed)
  contextLength: number;
  quantization?: string;      // "Q4_K_M" (⛓ only)
  modality: string;           // "text"
}

export function modelKaName(m: ModelKaInput): string {
  // stable, filesystem/KA-safe name derived from the identity
  const stem = m.provenanceClass === "weights-pinned"
    ? m.id.replace(/^sha256:/, "").slice(0, 16)
    : m.id.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
  return `nsm-model-${stem}`;
}

export function modelKaUrn(m: ModelKaInput): string {
  return `urn:nsm:model:${m.provenanceClass === "weights-pinned" ? m.id : m.id}`;
}

export function buildModelKaQuads(m: ModelKaInput): { ka: string; urn: string; quads: Quad[] } {
  const ka = modelKaName(m);
  const S = modelKaUrn(m);
  const q: Quad[] = [];
  const iri = (p: string, o: string) => q.push({ subject: S, predicate: p, object: o });
  const lit = (p: string, v: unknown) => q.push({ subject: S, predicate: p, object: JSON.stringify(String(v)) });
  iri(`${RDF}type`, `${NSM}Model`);
  lit(`${NSM}modelIdentity`, m.id);
  lit(`${NSM}provenanceClass`, m.provenanceClass);
  lit(`${NSM}family`, m.family);
  lit(`${NSM}displayName`, m.displayName);
  lit(`${NSM}logoRef`, m.logoRef);
  lit(`${NSM}contextLength`, m.contextLength);
  if (m.quantization) lit(`${NSM}quantization`, m.quantization);
  lit(`${NSM}modality`, m.modality);
  return { ka, urn: S, quads: q };
}

/** Derive the Model-KA input from a mounted offering binding (family/logo by
 *  known-family match; monogram fallback is the UI's job, not ours). */
export function modelKaFromBinding(ob: OfferingBinding, meta?: Partial<ModelKaInput>): ModelKaInput {
  const known: Array<{ test: RegExp; family: string; logo: string }> = [
    { test: /qwen/i, family: "qwen", logo: "assets/model-logos/qwen.svg" },
    { test: /gpt|codex|o[0-9]/i, family: "openai", logo: "assets/model-logos/openai.svg" },
    { test: /deepseek/i, family: "deepseek", logo: "assets/model-logos/deepseek.svg" },
    { test: /llama/i, family: "meta", logo: "assets/model-logos/meta.svg" },
    { test: /mistral|mixtral/i, family: "mistral", logo: "assets/model-logos/mistral.svg" },
  ];
  if (ob.binding.kind === "llamacpp") {
    const name = ob.binding.modelId;
    const fam = known.find((k) => k.test.test(name));
    return {
      provenanceClass: "weights-pinned",
      id: ob.binding.ggufSha256,
      family: meta?.family ?? fam?.family ?? "unknown",
      displayName: meta?.displayName ?? name.replace(/-/g, " "),
      logoRef: meta?.logoRef ?? fam?.logo ?? "monogram",
      contextLength: meta?.contextLength ?? ob.binding.settings.ctx,
      quantization: meta?.quantization ?? (name.match(/Q\d+_K_[MS]|Q\d+_\d+/)?.[0] ?? undefined),
      modality: meta?.modality ?? "text",
    };
  }
  const model = ob.binding.kind === "openai" ? ob.binding.model : ob.binding.model;
  const fam = known.find((k) => k.test.test(model));
  return {
    provenanceClass: "upstream-claimed",
    id: model,
    family: meta?.family ?? fam?.family ?? "unknown",
    displayName: meta?.displayName ?? model,
    logoRef: meta?.logoRef ?? fam?.logo ?? "monogram",
    contextLength: meta?.contextLength ?? 128_000,
    modality: meta?.modality ?? "text",
  };
}
