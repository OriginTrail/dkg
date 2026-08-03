-- Release-certification tables (M1). Additive only: nothing here touches the
-- existing publish_*_summary / error_messages_* tables.
-- Safe to re-run: everything is IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS queue_snapshots (
    id            BIGSERIAL PRIMARY KEY,
    node_name     TEXT        NOT NULL,
    network       TEXT,
    node_version  TEXT,
    source        TEXT        NOT NULL, -- 'status' | 'admission' | 'store' | 'sync-global'
    lane          TEXT,                 -- lane name when the diagnostics endpoint provides it
    state         TEXT,                 -- scheduler state as reported (e.g. healthy)
    queued        INTEGER,
    inflight      INTEGER,
    oldest_age_ms BIGINT,
    active_ops    JSONB,               -- bounded active-operation summaries when available
    raw           JSONB,               -- raw payload fragment for forward compatibility
    time_stamp    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_queue_snapshots_time ON queue_snapshots (time_stamp);
CREATE INDEX IF NOT EXISTS idx_queue_snapshots_node ON queue_snapshots (node_name, source, lane, time_stamp);

CREATE TABLE IF NOT EXISTS releases (
    id          BIGSERIAL PRIMARY KEY,
    package     TEXT        NOT NULL DEFAULT '@origintrail-official/dkg',
    dist_tag    TEXT        NOT NULL,
    version     TEXT        NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (package, dist_tag, version)
);

-- Filled from M3 on (layered suite); created now so the dashboard can reference it.
CREATE TABLE IF NOT EXISTS publish_layer_ops (
    id              BIGSERIAL PRIMARY KEY,
    run_id          TEXT,
    node_name       TEXT        NOT NULL,
    blockchain_name TEXT,
    layer           TEXT        NOT NULL, -- wm | swm | swm_receiver | vm | vm_get | query_remote
    cg_kind         TEXT,                 -- public | private
    payload_size_kb INTEGER,
    success         BOOLEAN     NOT NULL,
    client_ms       BIGINT,
    server_ms       BIGINT,
    error           TEXT,
    node_version    TEXT,
    details         JSONB,
    time_stamp      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_publish_layer_ops_time ON publish_layer_ops (time_stamp);
CREATE INDEX IF NOT EXISTS idx_publish_layer_ops_key  ON publish_layer_ops (node_name, layer, cg_kind, time_stamp);

-- Scorecard verdicts per release checkpoint (M4).
CREATE TABLE IF NOT EXISTS scorecards (
    id         BIGSERIAL PRIMARY KEY,
    release_id BIGINT      NOT NULL REFERENCES releases (id),
    checkpoint TEXT        NOT NULL, -- '1h' | '6h' | '24h'
    verdict    TEXT        NOT NULL, -- PASS | DEGRADED | FAIL | INCONCLUSIVE
    details    JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (release_id, checkpoint)
);

-- Queue-incident evidence bundles (Q3).
CREATE TABLE IF NOT EXISTS incidents (
    id         BIGSERIAL PRIMARY KEY,
    node_name  TEXT        NOT NULL,
    trigger    TEXT        NOT NULL,
    bundle     JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incidents_node_time ON incidents (node_name, created_at);
