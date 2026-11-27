// Mapped four-row demo estimate. Package with jpb-plca-mapped-bundle.mjs for the Program guest.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

function preparedJpbJson(value) {
  if (Array.isArray(value)) return "[" + value.map(preparedJpbJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const fields = value;
    return "{" + Object.keys(fields).sort().map((key) => JSON.stringify(key) + ":" + preparedJpbJson(fields[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
function calculateMappedImpact(inventory, factors, assumptions, workbookSha256) {
  const outputUnits = assumptions.outputUnits;
  if (!Number.isFinite(outputUnits) || outputUnits <= 0 || !assumptions.notice)
    throw new Error("PLCA_ESTIMATE_BASIS_REQUIRED");
  if (!workbookSha256 || !assumptions.reference || !assumptions.date)
    throw new Error("PLCA_FACTOR_SOURCE_REQUIRED");
  const keys = new Set();
  for (const factor of factors) {
    const key = JSON.stringify([factor.studyItemId]);
    if (!factor.studyItemId || !factor.quantityUnit || !Number.isFinite(factor.value) || keys.has(key))
      throw new Error("PLCA_FACTOR_MAPPING_INVALID");
    keys.add(key);
  }
  const resources = inventory.filter(item => !item.internalTransfer);
  if (!resources.length) throw new Error("PLCA_STUDY_INVENTORY_REQUIRED");
  if (factors.some(factor => !resources.some(item => item.rowId === factor.studyItemId)))
    throw new Error("PLCA_FACTOR_ROW_NOT_RESOURCE");

  // Preserve the inventory overflow check even when impact factors are missing.
  const quantities = new Map();
  for (const item of resources) {
    const key = JSON.stringify([item.material, item.unit]);
    const total = (quantities.get(key) ?? 0) + item.quantity;
    if (!Number.isFinite(total / outputUnits)) throw new Error("PLCA_INVENTORY_OVERFLOW");
    quantities.set(key, total);
  }
  let subtotal = 0;
  const contributions = [];
  for (const item of resources) {
    const factor = factors.find(factor => factor.studyItemId === item.rowId);
    if (!factor || factor.quantityUnit !== item.unit) continue;
    const impact = item.quantity * factor.value;
    if (!Number.isFinite(impact)) throw new Error("PLCA_IMPACT_OVERFLOW");
    subtotal += impact;
    if (!Number.isFinite(subtotal / outputUnits)) throw new Error("PLCA_IMPACT_OVERFLOW");
    contributions.push({ studyItemId: item.rowId, sourceCell: item.rowId, datasetId: assumptions.reference,
      factor: factor.value, impact, perProduct: impact / outputUnits });
  }
  const calculated = contributions.length === resources.length;
  return { calculated, total: calculated ? subtotal : null, perProduct: calculated ? subtotal / outputUnits : null,
    unit: "kg CO2e", contributions };
}

export function run(input) {
  const { records, assumptions } = input;
  if (!Array.isArray(records) || records.length > 20 || !assumptions || assumptions.kind !== "demo-assumptions")
    throw new Error("MAPPED_INPUT_REQUIRED");
  const workbook = records.filter(r => r.workbook).map(r => r.workbook);
  if (workbook.length !== 4 || new Set(workbook.map(w => w.rowId)).size !== 4)
    throw new Error("EXACT_WORKBOOK_ROWS_REQUIRED");
  const workbookSha256 = workbook[0].evidence.contentDigest;
  if (workbook.some(w => w.evidence.contentDigest !== workbookSha256)) throw new Error("WORKBOOK_REVISION_MISMATCH");
  const inventory = workbook.map(w => ({ rowId: w.rowId, material: w.material, unit: w.unit,
    internalTransfer: assumptions.internalTransferRows.includes(w.rowId),
    quantity: w.quantity === null ? assumptions.missingQuantities[w.rowId] : w.quantity }));
  if (inventory.some(w => !Number.isFinite(w.quantity) || w.quantity < 0)) throw new Error("EXPLICIT_QUANTITY_REQUIRED");
  const factors = assumptions.factors.map(factor => ({ ...factor }));
  const sourceSnapshot = "urn:nos:mapped:" + bytesToHex(sha256(utf8ToBytes(preparedJpbJson(records))));
  const impact = calculateMappedImpact(inventory, factors, assumptions, workbookSha256);
  return { records, assessment: { kind: "Demo estimate", calculated: impact.calculated, total: impact.total,
    perProduct: impact.perProduct, unit: impact.unit, outputUnits: assumptions.outputUnits,
    contributions: impact.contributions, assumptions,
    scope: "Selected demo rows only; not a validated JPB product footprint", sourceSnapshot } };
}
