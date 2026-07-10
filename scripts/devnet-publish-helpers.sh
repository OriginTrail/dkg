#!/usr/bin/env bash
#
# Shared helpers for devnet test scripts — rc.12+ single-root sync publish.
#
# Devnet scripts publish through named knowledge assets. Multi-root payloads are
# split into one named KA per root by default so each VM publish remains
# independently verifiable. Set DEVNET_PUBLISH_PRESERVE_BATCH=1 for tests that
# intentionally need one KC containing the full multi-root payload.
#
# Usage: source this file AFTER defining `api_call NODE METHOD PATH [DATA]`.
#
#   PUBLISH_RESP=$(devnet_publish_swm_all_roots "$NODE" "$CG_ID" false)
#   devnet_publish_load_state
#
# Command substitution runs the publish helper in a subshell, so metadata is
# persisted to DEVNET_PUBLISH_STATE_FILE and must be loaded in the caller shell.
# The state file is scoped to the parent shell PID ($$). Unlike BASHPID, $$ is
# stable across command-substitution subshells, so the path the helper writes
# inside `$(...)` matches the one the parent later reads. It also keeps
# concurrent devnet scripts from clobbering each other's publish metadata.
#
DEVNET_PUBLISH_STATE_FILE="${DEVNET_PUBLISH_STATE_FILE:-${DEVNET_DIR:-/tmp}/.devnet-publish-state-$$.json}"
DEVNET_PUBLISH_ALL_RESPONSES='[]'
DEVNET_PUBLISH_ROOT_ENTITIES='[]'
DEVNET_PUBLISH_ASSET_NAMES='[]'
DEVNET_PUBLISH_PENDING_ASSETS='[]'
# Node that performed the last publish. KC metadata (merkleRoot, KCS records)
# must be read from this node — late-joining/non-curator verifier peers may not
# have materialized the batch yet, which would race verify-batch.
DEVNET_PUBLISH_NODE=''

devnet_json_field() {
  printf '%s' "$1" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); const v=j$2; console.log(v == null ? '' : v); }
      catch { process.exit(1); }
    })
  "
}

_devnet_append_pending_assets_file() {
  local assets_file="$1"
  _devnet_publish_init_state_file
  STATE_FILE="$DEVNET_PUBLISH_STATE_FILE" ASSETS_FILE="$assets_file" node -e '
    const fs = require("fs");
    const stateFile = process.env.STATE_FILE;
    const state = fs.existsSync(stateFile)
      ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
      : {};
    const newAssets = fs.readFileSync(process.env.ASSETS_FILE, "utf8")
      .split(/\n+/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const pendingAssets = (state.pendingAssets || []).concat(newAssets);
    fs.writeFileSync(stateFile, JSON.stringify({
      ...state,
      allResponses: state.allResponses || [],
      rootEntities: state.rootEntities || [],
      publishNode: state.publishNode || "",
      assetNames: pendingAssets.map((asset) => asset.name),
      pendingAssets,
    }));
  '
}

# Create one or more named knowledge assets, seal them, and share them to SWM.
# Echoes a legacy-shaped write response so older devnet scripts can keep their
# `triplesWritten` assertions while exercising the named KA lifecycle path.
devnet_create_shared_ka() {
  local node_id="$1" payload="$2" name_prefix="${3:-devnet-ka}" extra_fields="${4:-}"
  local nonce plan_file responses_file assets_file count i asset body resp status

  _devnet_publish_init_state_file
  nonce="$(date +%s)-$$-${RANDOM:-0}"
  plan_file="$(mktemp "${DEVNET_DIR:-/tmp}/devnet-create-plan.XXXXXX")" || return 1
  responses_file="$(mktemp "${DEVNET_DIR:-/tmp}/devnet-create-responses.XXXXXX")" || {
    rm -f "$plan_file"
    return 1
  }
  assets_file="$(mktemp "${DEVNET_DIR:-/tmp}/devnet-create-assets.XXXXXX")" || {
    rm -f "$plan_file" "$responses_file"
    return 1
  }
  if ! printf '%s' "$payload" | PLAN_FILE="$plan_file" NAME_PREFIX="$name_prefix" EXTRA_FIELDS="$extra_fields" NONCE="$nonce" node -e '
    const fs = require("fs");
    let input = "";
    process.stdin.on("data", c => input += c);
    process.stdin.on("end", () => {
      const payload = JSON.parse(input);
      const extra = process.env.EXTRA_FIELDS ? JSON.parse("{" + process.env.EXTRA_FIELDS + "}") : {};
      const quads = Array.isArray(payload.quads) ? payload.quads : [];
      const rootOf = (subject) => String(subject || "").split("/.well-known/genid/")[0];
      const slug = (value) => String(value || "ka")
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "ka";
      const prefix = slug(process.env.NAME_PREFIX || "devnet-ka");
      const roots = [...new Set(quads.map(q => rootOf(q.subject)).filter(Boolean))];
      const effectiveRoots = roots.length > 0 ? roots : [prefix];
      const preserveBatch = process.env.DEVNET_PUBLISH_PRESERVE_BATCH === "1";
      const assetRoots = preserveBatch ? [effectiveRoots[0]] : effectiveRoots;
      const fd = fs.openSync(process.env.PLAN_FILE, "w");
      try {
        fs.writeSync(fd, JSON.stringify({
          contextGraphId: payload.contextGraphId,
          totalQuads: quads.length,
          count: assetRoots.length,
        }) + "\n");
        for (let index = 0; index < assetRoots.length; index++) {
          const root = assetRoots[index];
          const rootQuads = roots.length > 0
            ? (preserveBatch ? quads : quads.filter(q => rootOf(q.subject) === root))
            : quads;
          const name = `${prefix}-${process.env.NONCE}-${index + 1}-${slug(root).slice(0, 24)}`;
          fs.writeSync(fd, JSON.stringify({
            name,
            root,
            rootEntities: preserveBatch ? effectiveRoots : [root],
            preserveBatch,
            ...(extra.subGraphName || payload.subGraphName ? { subGraphName: extra.subGraphName || payload.subGraphName } : {}),
            body: {
              contextGraphId: payload.contextGraphId,
              name,
              quads: rootQuads,
              finalize: true,
              alsoShareSwm: true,
              ...(payload.subGraphName ? { subGraphName: payload.subGraphName } : {}),
              ...extra,
            },
          }) + "\n");
        }
      } finally {
        fs.closeSync(fd);
      }
    });
  '; then
    rm -f "$plan_file" "$responses_file" "$assets_file"
    return 1
  fi

  count=$(sed -n '1p' "$plan_file" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).count));')
  i=0
  while [ "$i" -lt "$count" ]; do
    asset=$(sed -n "$((i + 2))p" "$plan_file")
    body=$(printf '%s' "$asset" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(d).body)));')
    if ! resp=$(api_call "$node_id" POST /api/knowledge-assets "$body"); then
      rm -f "$plan_file" "$responses_file" "$assets_file"
      return 1
    fi
    if ! printf '%s' "$resp" | RESPONSES_FILE="$responses_file" node -e '
      const fs = require("fs");
      let d=""; process.stdin.on("data", c => d += c);
      process.stdin.on("end", () => {
        try {
          const j = JSON.parse(d);
          if (j.error || (Array.isArray(j.errors) && j.errors.length > 0)) process.exit(1);
          if (j.swmShared !== true) process.exit(1);
          if (j.publishReady !== true) process.exit(1);
          if (typeof j.shareOperationId !== "string" || j.shareOperationId.trim().length === 0) process.exit(1);
          if (Number(j.promotedCount || 0) <= 0) process.exit(1);
          fs.appendFileSync(process.env.RESPONSES_FILE, JSON.stringify(j) + "\n");
        } catch {
          process.exit(1);
        }
      });
    '; then
      printf 'devnet_create_shared_ka: /api/knowledge-assets did not return a publish-ready SWM share\n%s\n' "$resp" >&2
      rm -f "$plan_file" "$responses_file" "$assets_file"
      return 1
    fi
    if ! printf '%s' "$asset" | ASSETS_FILE="$assets_file" node -e '
      const fs = require("fs");
      let input = "";
      process.stdin.on("data", c => input += c);
      process.stdin.on("end", () => {
        const asset = JSON.parse(input);
        fs.appendFileSync(process.env.ASSETS_FILE, JSON.stringify({
          name: asset.name,
          root: asset.root,
          rootEntities: asset.rootEntities || [asset.root],
          preserveBatch: Boolean(asset.preserveBatch),
          ...(asset.subGraphName ? { subGraphName: asset.subGraphName } : {}),
        }) + "\n");
      });
    '; then
      rm -f "$plan_file" "$responses_file" "$assets_file"
      return 1
    fi
    i=$((i + 1))
  done

  if ! _devnet_append_pending_assets_file "$assets_file"; then
    rm -f "$plan_file" "$responses_file" "$assets_file"
    return 1
  fi
  PLAN_FILE="$plan_file" RESPONSES_FILE="$responses_file" ASSETS_FILE="$assets_file" node -e '
    const fs = require("fs");
    const readJsonLines = (file) => fs.readFileSync(file, "utf8")
      .split(/\n+/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const [meta] = readJsonLines(process.env.PLAN_FILE);
    const responses = readJsonLines(process.env.RESPONSES_FILE);
    const assets = readJsonLines(process.env.ASSETS_FILE);
    const names = assets.map((asset) => asset.name);
    const roots = [...new Set(assets.flatMap((asset) => asset.rootEntities || [asset.root]))];
    process.stdout.write(JSON.stringify({
      triplesWritten: Number(meta.totalQuads),
      shareOperationId: "knowledge-assets:" + names.join(","),
      names,
      rootEntities: roots,
      responses,
    }));
  '
  status=$?
  rm -f "$plan_file" "$responses_file" "$assets_file"
  return "$status"
}

# Publish statuses the devnet harness treats as success (matches devnet-test.sh).
_devnet_publish_status_ok() {
  case "$1" in
    confirmed|finalized|tentative) return 0 ;;
    *) return 1 ;;
  esac
}

# Honor an already-set DEVNET_PUBLISH_STATE_FILE; otherwise derive a
# parent-stable path from $$ (NOT BASHPID, which changes inside subshells).
_devnet_publish_init_state_file() {
  : "${DEVNET_PUBLISH_STATE_FILE:=${DEVNET_DIR:-/tmp}/.devnet-publish-state-$$.json}"
}

_devnet_publish_persist_state() {
  local all_responses="$1" root_entities="${2:-[]}" publish_node="${3:-}" asset_names="${4:-[]}" pending_assets="${5:-[]}"
  node -e "
    require('fs').writeFileSync(
      process.argv[1],
      JSON.stringify({
        allResponses: JSON.parse(process.argv[2]),
        rootEntities: JSON.parse(process.argv[3]),
        publishNode: process.argv[4],
        assetNames: JSON.parse(process.argv[5]),
        pendingAssets: JSON.parse(process.argv[6]),
      }),
    );
  " "$DEVNET_PUBLISH_STATE_FILE" "$all_responses" "$root_entities" "$publish_node" "$asset_names" "$pending_assets"
}

devnet_publish_load_state() {
  _devnet_publish_init_state_file
  if [ ! -f "$DEVNET_PUBLISH_STATE_FILE" ]; then
    DEVNET_PUBLISH_ALL_RESPONSES='[]'
    DEVNET_PUBLISH_ROOT_ENTITIES='[]'
    DEVNET_PUBLISH_ASSET_NAMES='[]'
    DEVNET_PUBLISH_PENDING_ASSETS='[]'
    DEVNET_PUBLISH_NODE=''
    return 0
  fi
  DEVNET_PUBLISH_ALL_RESPONSES=$(node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    process.stdout.write(JSON.stringify(s.allResponses || []));
  " "$DEVNET_PUBLISH_STATE_FILE")
  DEVNET_PUBLISH_ROOT_ENTITIES=$(node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    process.stdout.write(JSON.stringify(s.rootEntities || []));
  " "$DEVNET_PUBLISH_STATE_FILE")
  DEVNET_PUBLISH_NODE=$(node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    process.stdout.write(s.publishNode || '');
  " "$DEVNET_PUBLISH_STATE_FILE")
  DEVNET_PUBLISH_ASSET_NAMES=$(node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    process.stdout.write(JSON.stringify(s.assetNames || []));
  " "$DEVNET_PUBLISH_STATE_FILE")
  DEVNET_PUBLISH_PENDING_ASSETS=$(node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    process.stdout.write(JSON.stringify(s.pendingAssets || []));
  " "$DEVNET_PUBLISH_STATE_FILE")
}

# Echo the number of publishes recorded by the last devnet_publish_swm_all_roots
# call. This counts `allResponses` (one entry per confirmed publish), NOT
# `rootEntities`: the single-root path persists 1 response but `[]` root
# subjects for older single-root runs may be absent, so counting rootEntities
# would report 0 for a perfectly good one-root publish and make
# `devnet_verify_each_published_root` reject it. The
# verify loop indexes `allResponses[i]` via `devnet_publish_ka_id_at`, so this
# count must track `allResponses`. rootEntities is supplementary (per-root quad
# filtering, guarded by `roots.length > 0`).
devnet_publish_root_count() {
  devnet_publish_load_state
  printf '%s' "$DEVNET_PUBLISH_ALL_RESPONSES" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try {
        const arr = JSON.parse(d);
        // Honest count — never fabricate 1. An empty batch (0 roots) and a
        // corrupt/unparseable state file are real failures the caller must
        // see, not silently paper over with a phantom single root (same
        // class as the publish-status-gating fix).
        console.log(Array.isArray(arr) ? arr.length : "PARSE_ERR");
      } catch {
        console.log("PARSE_ERR");
      }
    });
  '
}

# Args: zero-based index into the last publish batch list.
devnet_publish_ka_id_at() {
  local idx="$1"
  devnet_publish_load_state
  printf '%s' "$DEVNET_PUBLISH_ALL_RESPONSES" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>console.log(JSON.parse(d)[Number(process.argv[1])].kaId));
  " "$idx"
}

# Args: root_subject
# Resolve the kaId of the batch that published a given root entity. The helper
# preserves publish order (allResponses[i] <-> rootEntities[i]), but the
# daemon's rootEntities order is NOT tied to the original quad order, so callers
# must look the batch up by subject rather than positional index. Lookups fail
# fast when the requested root has no recorded root->batch mapping (e.g. a typo,
# or a single-root publish where the subject was never recorded) instead of
# silently resolving to the wrong batch — use devnet_publish_ka_id_at for
# positional access to a single-batch publish.
devnet_publish_ka_id_for_root() {
  local root="$1"
  devnet_publish_load_state
  ALL="$DEVNET_PUBLISH_ALL_RESPONSES" ROOTS="$DEVNET_PUBLISH_ROOT_ENTITIES" ROOT="$root" node -e '
    const all = JSON.parse(process.env.ALL || "[]");
    const roots = JSON.parse(process.env.ROOTS || "[]");
    const root = process.env.ROOT;
    if (roots.length === 0) {
      console.error(
        "no root->batch mapping recorded for " + root +
        " (single-root publish records no subject; use devnet_publish_ka_id_at instead)",
      );
      process.exit(1);
    }
    const idx = roots.indexOf(root);
    if (idx < 0 || !all[idx]) {
      console.error("no published batch for root " + root);
      process.exit(1);
    }
    console.log(all[idx].kaId);
  '
}

devnet_kc_merkle_root() {
  local node="$1" kc="$2"
  local meta
  meta=$(api_call "$node" GET "/api/kc/$kc")
  devnet_json_field "$meta" '.merkleRoot'
}

# Args: expected_minted_per_kc (default 1)
# Requires REPO_ROOT, HARDHAT_PORT, CONTRACTS_JSON, EVM_ABI_DIR in caller env.
devnet_kcs_readback_all_published() {
  local expected_minted="${1:-1}"
  devnet_publish_load_state
  (
    cd "${REPO_ROOT:?REPO_ROOT must be set}/packages/evm-module" && \
    RPC_URL="http://127.0.0.1:${HARDHAT_PORT:-8545}" \
    CONTRACTS_JSON="${CONTRACTS_JSON:?CONTRACTS_JSON must be set}" \
    ABI_DIR="${EVM_ABI_DIR:?EVM_ABI_DIR must be set}" \
    ALL_KCS="$DEVNET_PUBLISH_ALL_RESPONSES" \
    EXPECTED_MINTED="$expected_minted" \
    node -e '
const { ethers } = require("ethers");
const fs = require("fs"); const path = require("path");
(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const contracts = JSON.parse(fs.readFileSync(process.env.CONTRACTS_JSON, "utf8")).contracts;
  const kcsAddr = contracts.DKGKnowledgeAssets?.evmAddress ?? contracts.KnowledgeCollectionStorage?.evmAddress;
  if (!kcsAddr) throw new Error("DKGKnowledgeAssets / KnowledgeCollectionStorage not deployed");
  const kcsAbiFile = fs.existsSync(path.join(process.env.ABI_DIR, "DKGKnowledgeAssets.json"))
    ? "DKGKnowledgeAssets.json" : "DKGKnowledgeAssets.json";
  const kas = new ethers.Contract(kcsAddr,
    JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, kcsAbiFile), "utf8")), provider);
  const kcs = JSON.parse(process.env.ALL_KCS);
  const expectedMinted = BigInt(process.env.EXPECTED_MINTED);
  if (!kcs.length) throw new Error("no published KC responses in state");
  for (const pub of kcs) {
    const batchId = pub.kaId;
    const [merkleRoots, , minted, byteSize] = await kas.getKnowledgeAssetMetadata(BigInt(batchId));
    if (!merkleRoots || merkleRoots.length === 0) throw new Error("no merkleRoots for kaId=" + batchId);
    if (byteSize === 0n) throw new Error("byteSize=0 for kaId=" + batchId);
    if (minted !== expectedMinted) {
      throw new Error("kaId=" + batchId + ": expected " + expectedMinted + " KAs minted, got " + minted);
    }
  }
  console.log("✓ KCS: " + kcs.length + " KC(s) each minted=" + expectedMinted);
})().catch(e => { console.error(e?.message || e); process.exit(1); });
    '
  )
}

devnet_private_roots_for_published_root() {
  local node="$1" cg="$2" root="$3"
  local body resp

  body=$(CG="$cg" ROOT="$root" node -e '
    const cg = process.env.CG;
    const root = process.env.ROOT;
    const metaGraph = `did:dkg:context-graph:${cg}/_meta`;
    const sparql = `
      SELECT DISTINCT ?privateRoot WHERE {
        GRAPH <${metaGraph}> {
          ?ka <http://dkg.io/ontology/rootEntity> ?rootEntity ;
              <http://dkg.io/ontology/privateMerkleRoot> ?privateRoot .
          FILTER(STR(?rootEntity) = ${JSON.stringify(root)})
        }
      }
    `;
    process.stdout.write(JSON.stringify({ sparql }));
  ')
  resp=$(api_call "$node" POST /api/query "$body") || return 1
  printf '%s' "$resp" | node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d || "{}");
        if (j.error) throw new Error(j.error);
        const bindings = j?.result?.bindings ?? j?.result?.results?.bindings ?? j?.bindings ?? j?.results?.bindings ?? [];
        const roots = [];
        for (const row of bindings) {
          const cell = row?.privateRoot ?? row?.root;
          let value = typeof cell === "object" && cell !== null && "value" in cell ? cell.value : cell;
          value = String(value ?? "").split("^^")[0].replace(/^"|"$/g, "").trim();
          const match = value.match(/^(?:0x)?([0-9a-fA-F]{64})$/);
          if (match) roots.push("0x" + match[1].toLowerCase());
        }
        process.stdout.write(JSON.stringify([...new Set(roots)]));
      } catch (err) {
        console.error(`devnet_private_roots_for_published_root: ${err?.message || err}`);
        process.exit(1);
      }
    });
  '
}

devnet_catalog_quads_for_published_kc() {
  local node="$1" cg="$2" kc="$3"
  local body resp

  body=$(CG="$cg" KC="$kc" node -e '
    const cg = process.env.CG;
    const kc = process.env.KC;
    const metaGraph = `did:dkg:context-graph:${cg}/_meta`;
    const cgDid = `did:dkg:context-graph:${cg}`;
    const DKG = "http://dkg.io/ontology/";
    const sparql = `
      SELECT DISTINCT ?p ?o WHERE {
        GRAPH <${metaGraph}> {
          ?assertion <${DKG}publishedUal> ?publishedUal ;
                     <${DKG}assertionGraph> ?assertionGraph .
          ?ual <${DKG}batchId> ?batchId .
          FILTER(STR(?publishedUal) = STR(?ual) && CONTAINS(STR(?batchId), ${JSON.stringify(kc)}))
        }
        GRAPH ?assertionGraph {
          <${cgDid}> ?p ?o .
        }
      }
      ORDER BY ?p ?o
    `;
    process.stdout.write(JSON.stringify({ sparql }));
  ')
  resp=$(api_call "$node" POST /api/query "$body") || return 1
  printf '%s' "$resp" | CG="$cg" node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d || "{}");
        if (j.error) throw new Error(j.error);
        const bindings = j?.result?.bindings ?? j?.result?.results?.bindings ?? j?.bindings ?? j?.results?.bindings ?? [];
        const subject = `did:dkg:context-graph:${process.env.CG}`;
        const quads = [];
        for (const row of bindings) {
          const pCell = row?.p;
          const oCell = row?.o;
          const predicate = String((typeof pCell === "object" && pCell !== null && "value" in pCell) ? pCell.value : pCell ?? "");
          const object = String((typeof oCell === "object" && oCell !== null && "value" in oCell) ? oCell.value : oCell ?? "");
          if (predicate && object) quads.push({ subject, predicate, object, graph: "" });
        }
        process.stdout.write(JSON.stringify(quads));
      } catch (err) {
        console.error(`devnet_catalog_quads_for_published_kc: ${err?.message || err}`);
        process.exit(1);
      }
    });
  '
}

# Args: node cg quads_payload_json [metadata_node]
# Verifies each published root entity against its KC merkleRoot via verify-batch.
# verify-batch runs on `node` (often a late-joining/non-curator peer), but the
# expected merkleRoot is read from `metadata_node` — defaults to the node that
# performed the publish — to avoid racing that peer's KC chain-sync.
devnet_verify_each_published_root() {
  local node="$1" cg="$2" quads_payload="$3" meta_node="${4:-}"
  local count i kc merkle root private_roots catalog_quads body resp ok actual

  devnet_publish_load_state
  [ -z "$meta_node" ] && meta_node="${DEVNET_PUBLISH_NODE:-$node}"
  [ -z "$meta_node" ] && meta_node="$node"

  count=$(devnet_publish_root_count)
  # A non-positive / unparseable count means the publish state file recorded
  # no roots (or is corrupt). The verify loop below would otherwise execute
  # zero iterations and return success — silently "passing" a publish that
  # never landed (the bug class fixed in devnet_publish_swm_all_roots).
  if ! [[ "$count" =~ ^[0-9]+$ ]] || [ "$count" -lt 1 ]; then
    echo "devnet_verify_each_published_root: no published roots to verify (count=$count) — publish state missing/corrupt" >&2
    return 1
  fi

  i=0
  while [ "$i" -lt "$count" ]; do
    kc=$(devnet_publish_ka_id_at "$i")
    merkle=$(devnet_kc_merkle_root "$meta_node" "$kc")
    root=$(ROOT_IDX="$i" ROOTS="$DEVNET_PUBLISH_ROOT_ENTITIES" node -e '
      const roots = JSON.parse(process.env.ROOTS || "[]");
      const idx = Number(process.env.ROOT_IDX);
      process.stdout.write(String(roots[idx] || ""));
    ')
    private_roots="[]"
    if [ -n "$root" ]; then
      private_roots=$(devnet_private_roots_for_published_root "$meta_node" "$cg" "$root") || return 1
    fi
    catalog_quads=$(devnet_catalog_quads_for_published_kc "$meta_node" "$cg" "$kc") || return 1
    body=$(QUADS_PAYLOAD="$quads_payload" ROOT_IDX="$i" ROOTS="$DEVNET_PUBLISH_ROOT_ENTITIES" PRIVATE_ROOTS="$private_roots" CATALOG_QUADS="$catalog_quads" CG="$cg" MERKLE="$merkle" KC="$kc" node -e '
      const genidPrefix = "/.well-known/genid/";
      const quadBelongsToRoot = (q, root) =>
        q.subject === root || q.subject.startsWith(root + genidPrefix);
      const roots = JSON.parse(process.env.ROOTS || "[]");
      const rootIdx = Number(process.env.ROOT_IDX);
      const payload = JSON.parse(process.env.QUADS_PAYLOAD);
      const privateRoots = JSON.parse(process.env.PRIVATE_ROOTS || "[]");
      const catalogQuads = JSON.parse(process.env.CATALOG_QUADS || "[]");
      let quads = payload.quads;
      if (roots.length > 0) {
        const root = roots[rootIdx];
        quads = quads.filter((q) => quadBelongsToRoot(q, root));
      }
      quads = quads.concat(catalogQuads);
      console.log(JSON.stringify({
        contextGraphId: process.env.CG,
        expectedMerkleRoot: process.env.MERKLE,
        batchId: process.env.KC,
        quads,
        ...(privateRoots.length ? { privateRoots } : {}),
      }));
    ')
    resp=$(api_call "$node" POST /api/shared-memory/verify-batch "$body")
    ok=$(devnet_json_field "$resp" '.ok')
    actual=$(devnet_json_field "$resp" '.actualRoot')
    if [ "$ok" != "true" ] || [ "$actual" != "$merkle" ]; then
      printf '%s\n' "$resp" >&2
      return 1
    fi
    i=$((i + 1))
  done
  return 0
}

_devnet_publish_swm_all_roots_retired_legacy() {
  echo "retired legacy anonymous SWM publish helper; use devnet_create_shared_ka + devnet_publish_swm_all_roots" >&2
  return 1
}

devnet_publish_swm_all_roots() {
  local node="$1" cg="$2" clear_after="${3:-false}"
  local extra_fields="${4:-}"

  _devnet_publish_init_state_file
  devnet_publish_load_state

  local pending_json count roots_json names_json i name pending_subgraph ca body last_resp st all_resps
  pending_json="$DEVNET_PUBLISH_PENDING_ASSETS"
  count=$(printf '%s' "$pending_json" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d || "[]").length))')
  if [ "$count" -eq 0 ]; then
    echo "devnet_publish_swm_all_roots: no pending named KAs; use devnet_create_shared_ka before publishing" >&2
    return 1
  fi

  roots_json=$(printf '%s' "$pending_json" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      const assets = JSON.parse(d || "[]");
      if (assets.some(a => a.preserveBatch)) {
        console.log("[]");
        return;
      }
      console.log(JSON.stringify(assets.map(a => a.root)));
    });
  ')
  names_json=$(printf '%s' "$pending_json" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.stringify(JSON.parse(d).map(a=>a.name))))')
  all_resps="[]"
  i=0
  last_resp=""
  while [ "$i" -lt "$count" ]; do
    name=$(printf '%s' "$pending_json" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)[Number(process.argv[1])].name))" "$i")
    pending_subgraph=$(printf '%s' "$pending_json" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d)[Number(process.argv[1])].subGraphName || ''))" "$i")
    ca="$clear_after"
    if [ "$clear_after" = "true" ] && [ "$i" -lt $((count - 1)) ]; then
      ca="false"
    fi
    body=$(node -e "
      const cg = process.argv[1];
      const clearAfter = process.argv[2] === 'true';
      const extra = process.argv[3] ? JSON.parse('{' + process.argv[3] + '}') : {};
      const pendingSubGraphName = process.argv[4] || '';
      const { subGraphName, ...publishOptions } = extra;
      const resolvedSubGraphName = subGraphName || pendingSubGraphName;
      console.log(JSON.stringify({
        contextGraphId: cg,
        ...(resolvedSubGraphName ? { subGraphName: resolvedSubGraphName } : {}),
        options: {
          clearAfter,
          ...publishOptions,
        },
      }));
    " "$cg" "$ca" "$extra_fields" "$pending_subgraph")
    last_resp=$(api_call "$node" POST "/api/knowledge-assets/${name}/vm/publish" "$body")
    st=$(devnet_json_field "$last_resp" '.status')
    if ! _devnet_publish_status_ok "$st"; then
      printf '%s' "$last_resp" >&2
      return 1
    fi
    all_resps=$(node -e "
      const arr = JSON.parse(process.argv[1]);
      arr.push(JSON.parse(process.argv[2]));
      console.log(JSON.stringify(arr));
    " "$all_resps" "$last_resp")
    i=$((i + 1))
    sleep 1
  done
  _devnet_publish_persist_state "$all_resps" "$roots_json" "$node" "$names_json" "[]"
  printf '%s' "$last_resp"
  return 0
}

# Filter quads to those belonging to a published root entity (matches publisher selection).
devnet_quads_for_root_json() {
  local quads_payload="$1" root="$2"
  QUADS_PAYLOAD="$quads_payload" ROOT="$root" node -e '
    const genidPrefix = "/.well-known/genid/";
    const quadBelongsToRoot = (q, root) =>
      q.subject === root || q.subject.startsWith(root + genidPrefix);
    const payload = JSON.parse(process.env.QUADS_PAYLOAD);
    const quads = payload.quads.filter((q) => quadBelongsToRoot(q, process.env.ROOT));
    console.log(JSON.stringify(quads));
  '
}
