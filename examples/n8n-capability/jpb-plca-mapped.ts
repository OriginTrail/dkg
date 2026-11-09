// Readable PLCA study Program. Only reachable pure functions are bundled.
// jpb-plca-study.ts

function preparedJpbJson(value) {
  if (Array.isArray(value)) return "[" + value.map(preparedJpbJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const fields = value;
    return "{" + Object.keys(fields).sort().map((key) => JSON.stringify(key) + ":" + preparedJpbJson(fields[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
function jpbSha256(text) {
  const block = new Uint8Array(64), w = new Int32Array(64);
  let position = 0, length = 0;
  const k = [
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ];
  const h = [1779033703, 3144134277, 1013904242, 2773480762, 1359893119, 2600822924, 528734635, 1541459225];
  const rot = (x, n) => x >>> n | x << 32 - n;
  const compress = () => {
    for (let i = 0; i < 16; i++)
      w[i] = block[i * 4] << 24 | block[i * 4 + 1] << 16 | block[i * 4 + 2] << 8 | block[i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = w[i - 16] + (rot(x, 7) ^ rot(x, 18) ^ x >>> 3) + w[i - 7] + (rot(y, 17) ^ rot(y, 19) ^ y >>> 10) | 0;
    }
    let [a, b, c, d, e, f, g, z] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = z + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + (e & f ^ ~e & g) + k[i] + w[i] | 0;
      const t2 = (rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + (a & b ^ a & c ^ b & c) | 0;
      z = g;
      g = f;
      f = e;
      e = d + t1 | 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 | 0;
    }
    h[0] = h[0] + a | 0;
    h[1] = h[1] + b | 0;
    h[2] = h[2] + c | 0;
    h[3] = h[3] + d | 0;
    h[4] = h[4] + e | 0;
    h[5] = h[5] + f | 0;
    h[6] = h[6] + g | 0;
    h[7] = h[7] + z | 0;
  };
  const byte = (value) => {
    block[position++] = value;
    length++;
    if (position === 64) {
      compress();
      position = 0;
    }
  };
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 55296 && code <= 56319) {
      const low = text.charCodeAt(++i);
      if (!(low >= 56320 && low <= 57343)) throw new URIError("URI malformed");
      code = 65536 + (code - 55296 << 10) + low - 56320;
    } else if (code >= 56320 && code <= 57343) throw new URIError("URI malformed");
    if (code < 128) byte(code);
    else if (code < 2048) {
      byte(192 | code >>> 6);
      byte(128 | code & 63);
    } else if (code < 65536) {
      byte(224 | code >>> 12);
      byte(128 | code >>> 6 & 63);
      byte(128 | code & 63);
    } else {
      byte(240 | code >>> 18);
      byte(128 | code >>> 12 & 63);
      byte(128 | code >>> 6 & 63);
      byte(128 | code & 63);
    }
  }
  const bits = length * 8;
  byte(128);
  while (position !== 56) byte(0);
  for (let i = 7; i >= 0; i--) byte(Math.floor(bits / 2 ** (i * 8)) & 255);
  return h.map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}

function validateJpbPlcaFactorCatalogue(catalogue) {
  if (catalogue.schemaVersion !== "jpb.plca-factors.v1" || !catalogue.studyId || !catalogue.workbookSha256 || !catalogue.source?.name || !catalogue.source.reference || !catalogue.source.exportedAt || !catalogue.method?.name || !catalogue.method.version || !catalogue.indicators?.length)
    throw new Error("PLCA_FACTOR_SOURCE_REQUIRED");
  const indicators = new Set(catalogue.indicators.map((indicator) => indicator.id));
  if (indicators.size !== catalogue.indicators.length || catalogue.indicators.some((indicator) => !indicator.id || !indicator.unit))
    throw new Error("PLCA_FACTOR_INDICATOR_INVALID");
  const keys = /* @__PURE__ */ new Set();
  for (const factor of catalogue.factors) {
    const key = JSON.stringify([factor.studyItemId, factor.indicatorId]);
    if (!factor.studyItemId || !factor.datasetId || !factor.quantityUnit || !indicators.has(factor.indicatorId) || !Number.isFinite(factor.value) || keys.has(key)) throw new Error("PLCA_FACTOR_MAPPING_INVALID");
    keys.add(key);
  }
  return catalogue;
}
function calculateJpbStudyEstimate(snapshot, studyId, basis, catalogue) {
  if (!Number.isFinite(basis.referenceOutputUnits) || basis.referenceOutputUnits <= 0 || !basis.assumption)
    throw new Error("PLCA_ESTIMATE_BASIS_REQUIRED");
  const study = snapshot.records.find((record) => record.kind === "study" && record.id === studyId);
  if (!study) throw new Error("PLCA_STUDY_NOT_FOUND");
  if (catalogue) {
    validateJpbPlcaFactorCatalogue(catalogue);
    if (catalogue.studyId !== studyId || catalogue.workbookSha256 !== study.workbookSha256)
      throw new Error("PLCA_FACTOR_STUDY_CHANGED");
  }
  const inventory = snapshot.records.filter((record) => record.kind === "study-item" && record.studyId === studyId).map((item) => ({
    ...item,
    internalTransfer: item.proxy.trim().toLowerCase() === "input from previous step",
    perProduct: item.value === null ? null : item.value / basis.referenceOutputUnits
  }));
  const resources = inventory.filter((item) => item.category !== "output" && !item.internalTransfer);
  if (!resources.length) throw new Error("PLCA_STUDY_INVENTORY_REQUIRED");
  if (catalogue?.factors.some((factor) => !resources.some((item) => item.id === factor.studyItemId)))
    throw new Error("PLCA_FACTOR_ROW_NOT_RESOURCE");
  const issues = [];
  const warning = (code, recordId, message) => issues.push({ code, recordId, message, severity: "warning" });
  warning("ASSUMED_STUDY_REFERENCE_RUN", study.id, basis.assumption);
  if (!snapshot.coverage.complete)
    warning("INCOMPLETE_STUDY_COVERAGE", study.id, snapshot.coverage.description);
  for (const item of resources) if (item.value === null)
    warning("MISSING_STUDY_QUANTITY", item.id, "No quantity supplied at " + item.sourceCell);
  if (!catalogue) warning("IMPACT_FACTORS_MISSING", study.id, "No partner impact-factor export has been imported");
  const resourceTotals = /* @__PURE__ */ new Map();
  for (const item of resources) {
    const key = JSON.stringify([item.material, item.unit]);
    const total = resourceTotals.get(key) ?? {
      material: item.material,
      unit: item.unit,
      knownQuantity: 0,
      knownRows: 0,
      missingRows: 0,
      sourceCells: []
    };
    if (item.value === null) total.missingRows++;
    else {
      total.knownQuantity += item.value;
      total.knownRows++;
    }
    if (!Number.isFinite(total.knownQuantity / basis.referenceOutputUnits)) throw new Error("PLCA_INVENTORY_OVERFLOW");
    total.sourceCells.push(item.sourceCell);
    resourceTotals.set(key, total);
  }
  const impacts = (catalogue?.indicators ?? []).map((indicator) => {
    let subtotal = 0, coveredRows = 0;
    const contributions = [];
    for (const item of resources) {
      const factor = catalogue.factors.find((factor2) => factor2.studyItemId === item.id && factor2.indicatorId === indicator.id);
      if (!factor) {
        warning("IMPACT_FACTOR_MISSING", item.id, "No " + indicator.id + " factor for " + item.sourceCell);
        continue;
      }
      if (factor.quantityUnit !== item.unit) {
        warning("IMPACT_FACTOR_UNIT_MISMATCH", item.id, "Factor unit " + factor.quantityUnit + " differs from " + item.unit + "; an explicit conversion is required");
        continue;
      }
      if (item.value === null) continue;
      const impact = item.value * factor.value;
      if (!Number.isFinite(impact)) throw new Error("PLCA_IMPACT_OVERFLOW");
      subtotal += impact;
      if (!Number.isFinite(subtotal / basis.referenceOutputUnits)) throw new Error("PLCA_IMPACT_OVERFLOW");
      coveredRows++;
      contributions.push({
        studyItemId: item.id,
        sourceCell: item.sourceCell,
        datasetId: factor.datasetId,
        factor: factor.value,
        impact,
        perProduct: impact / basis.referenceOutputUnits
      });
    }
    const complete = coveredRows === resources.length;
    return {
      indicatorId: indicator.id,
      unit: indicator.unit,
      status: complete ? "estimated" : "partial-estimate",
      coveredRows,
      requiredRows: resources.length,
      subtotal: coveredRows ? subtotal : null,
      subtotalPerProduct: coveredRows ? subtotal / basis.referenceOutputUnits : null,
      total: complete ? subtotal : null,
      totalPerProduct: complete ? subtotal / basis.referenceOutputUnits : null,
      contributions
    };
  });
  const impactStatus = !catalogue ? "not-calculated" : impacts.every((impact) => impact.status === "estimated") ? "estimated" : "partial-estimate";
  return {
    schemaVersion: "jpb.plca-study-estimate.v1",
    calculationKind: "representative-product-estimate",
    studyId,
    snapshotIri: snapshot.snapshotIri,
    datasetRevision: snapshot.revision,
    workbookSha256: study.workbookSha256,
    boundary: study.boundary,
    functionalUnit: study.functionalUnit,
    coverage: snapshot.coverage,
    basis: { ...basis, status: "assumed", orderAllocationConfirmed: false },
    inventoryStatus: resources.some((item) => item.value === null) ? "partial-estimate" : "estimated",
    impactStatus,
    inventory,
    resourceTotals: [...resourceTotals.values()].map((total) => ({
      ...total,
      knownQuantity: total.knownRows ? total.knownQuantity : null,
      perProduct: total.knownRows ? total.knownQuantity / basis.referenceOutputUnits : null,
      total: total.missingRows ? null : total.knownQuantity,
      totalPerProduct: total.missingRows ? null : total.knownQuantity / basis.referenceOutputUnits
    })),
    impacts,
    ...catalogue ? { factorSource: catalogue.source, method: catalogue.method } : {},
    issues
  };
}

// Mapped-input adapter; calculation above is reused verbatim from JPB's installed Program.
export function run(input) {
  const {records, assumptions}=input;
  if (!Array.isArray(records)||records.length>20||!assumptions||assumptions.kind!=="demo-assumptions") throw new Error("MAPPED_INPUT_REQUIRED");
  const workbook=records.filter(r=>r.workbook).map(r=>r.workbook);
  if(workbook.length!==4||new Set(workbook.map(w=>w.rowId)).size!==4) throw new Error("EXACT_WORKBOOK_ROWS_REQUIRED");
  const studyId="urn:nos:jpb:mapped-demo-study";
  const workbookSha256=workbook[0].evidence.contentDigest;
  if(workbook.some(w=>w.evidence.contentDigest!==workbookSha256)) throw new Error("WORKBOOK_REVISION_MISMATCH");
  const inventory=workbook.map(w=>({id:w.rowId,kind:"study-item",studyId,material:w.material,unit:w.unit,category:"input",proxy:assumptions.internalTransferRows.includes(w.rowId)?"input from previous step":"external",value:w.quantity===null?assumptions.missingQuantities[w.rowId]:w.quantity,sourceCell:w.rowId,evidenceIds:["urn:sha256:"+workbookSha256]}));
  if(inventory.some(w=>!Number.isFinite(w.value)||w.value<0)) throw new Error("EXPLICIT_QUANTITY_REQUIRED");
  const catalogue={schemaVersion:"jpb.plca-factors.v1",studyId,workbookSha256,source:{name:"Explicit demo assumptions",reference:assumptions.reference,exportedAt:assumptions.date},method:{name:"Demo arithmetic - selected workbook rows",version:"1"},indicators:[{id:"climate",unit:"kg CO2e"}],factors:assumptions.factors.map(f=>({...f,indicatorId:"climate",datasetId:assumptions.reference}))};
  const snapshot={snapshotIri:"urn:nos:mapped:"+jpbSha256(preparedJpbJson(records)),revision:"mapped-v1",coverage:{complete:true,description:"Only the four selected demo rows; not the complete product life cycle"},records:[{id:studyId,kind:"study",workbookSha256,boundary:"Selected demo rows",functionalUnit:"Assumed reference batch"},...inventory]};
  const estimate=calculateJpbStudyEstimate(snapshot,studyId,{referenceOutputUnits:assumptions.outputUnits,assumption:assumptions.notice},catalogue);
  const impact=estimate.impacts[0];
  return {records,assessment:{kind:"Demo estimate",calculated:impact.status==="estimated",total:impact.total,perProduct:impact.totalPerProduct,unit:impact.unit,outputUnits:assumptions.outputUnits,contributions:impact.contributions,assumptions,scope:"Selected demo rows only; not a validated JPB product footprint",sourceSnapshot:snapshot.snapshotIri}};
}
