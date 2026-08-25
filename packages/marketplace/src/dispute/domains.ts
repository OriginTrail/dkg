// Signing domains + withhold vocabulary — extracted from the retired P4
// wire front. The dispute engine still verifies P4-era signed material and
// reuses the withhold-reason vocabulary in its drawer copy.

export const LEG_DOMAIN_V3 = "nsm:leg:v3";
export const QUOTE_DOMAIN_V3 = "nsm:quote:v3";

export const WITHHOLD_CODES = new Set([
  "E_BYTES_DIGEST", "E_RECOUNT_MISMATCH", "E_TOKENIZER_DRIFT", "E_OVERBILL", "E_LEG_SIGNATURE",
]);
