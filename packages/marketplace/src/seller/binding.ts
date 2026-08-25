// OfferingBinding — extracted from the retired P4 wire front. The binding
// of an offering to its serving backend outlives the tab rail unchanged.

import type { OfferingConfig } from "../config.js";
import type { LlamaCppBinding } from "./connector-llamacpp.js";
import type { OpenAiBinding } from "./connector-openai.js";
import type { CodexOAuthBinding } from "./connector-codex-oauth.js";
import type { BpeEngine } from "../buyer/bpe.js";

export interface OfferingBinding {
  offering: OfferingConfig;
  binding: LlamaCppBinding | OpenAiBinding | CodexOAuthBinding;
  tokenizerBundleRef: string;   // KA UAL or content digest the offering pins
  offeringUal?: string;         // set once published
  /** counting engine over the declared public bundle (☁ classes) — the SAME
   *  algorithm the buyer recounts with, so honest counts match by construction */
  countEngine?: BpeEngine;
}
