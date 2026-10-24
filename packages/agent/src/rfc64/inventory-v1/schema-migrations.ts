import {
  INVENTORY_V1_LEGACY_USER_OBJECTS,
  INVENTORY_V1_LEGACY_USER_VERSION,
  INVENTORY_V1_MIGRATE_V1_TO_V2_SQL,
  INVENTORY_V1_MIGRATE_V2_TO_V3_SQL,
  INVENTORY_V1_MIGRATE_V3_TO_V4_SQL,
  INVENTORY_V1_MIGRATE_V4_TO_V5_SQL,
  INVENTORY_V1_MIGRATE_V5_TO_V6_SQL,
  INVENTORY_V1_USER_OBJECTS,
  INVENTORY_V1_USER_VERSION,
  INVENTORY_V1_V2_USER_OBJECTS,
  INVENTORY_V1_V2_USER_VERSION,
  INVENTORY_V1_V3_USER_OBJECTS,
  INVENTORY_V1_V3_USER_VERSION,
  INVENTORY_V1_V4_USER_OBJECTS,
  INVENTORY_V1_V4_USER_VERSION,
  INVENTORY_V1_V5_USER_OBJECTS,
  INVENTORY_V1_V5_USER_VERSION,
} from './sql.js';

export interface InventorySchemaMigrationV1 {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly fromObjects: Readonly<Record<string, string>>;
  readonly toObjects: Readonly<Record<string, string>>;
  readonly sql: string;
}

export const INVENTORY_SCHEMA_MIGRATIONS_V1: readonly InventorySchemaMigrationV1[] = Object.freeze([
  Object.freeze({
    fromVersion: INVENTORY_V1_LEGACY_USER_VERSION,
    toVersion: INVENTORY_V1_V2_USER_VERSION,
    fromLabel: 'v1',
    toLabel: 'v2',
    fromObjects: INVENTORY_V1_LEGACY_USER_OBJECTS,
    toObjects: INVENTORY_V1_V2_USER_OBJECTS,
    sql: INVENTORY_V1_MIGRATE_V1_TO_V2_SQL,
  }),
  Object.freeze({
    fromVersion: INVENTORY_V1_V2_USER_VERSION,
    toVersion: INVENTORY_V1_V3_USER_VERSION,
    fromLabel: 'v2',
    toLabel: 'v3',
    fromObjects: INVENTORY_V1_V2_USER_OBJECTS,
    toObjects: INVENTORY_V1_V3_USER_OBJECTS,
    sql: INVENTORY_V1_MIGRATE_V2_TO_V3_SQL,
  }),
  Object.freeze({
    fromVersion: INVENTORY_V1_V3_USER_VERSION,
    toVersion: INVENTORY_V1_V4_USER_VERSION,
    fromLabel: 'v3',
    toLabel: 'v4',
    fromObjects: INVENTORY_V1_V3_USER_OBJECTS,
    toObjects: INVENTORY_V1_V4_USER_OBJECTS,
    sql: INVENTORY_V1_MIGRATE_V3_TO_V4_SQL,
  }),
  Object.freeze({
    fromVersion: INVENTORY_V1_V4_USER_VERSION,
    toVersion: INVENTORY_V1_V5_USER_VERSION,
    fromLabel: 'v4',
    toLabel: 'v5',
    fromObjects: INVENTORY_V1_V4_USER_OBJECTS,
    toObjects: INVENTORY_V1_V5_USER_OBJECTS,
    sql: INVENTORY_V1_MIGRATE_V4_TO_V5_SQL,
  }),
  Object.freeze({
    fromVersion: INVENTORY_V1_V5_USER_VERSION,
    toVersion: INVENTORY_V1_USER_VERSION,
    fromLabel: 'v5', toLabel: 'v6',
    fromObjects: INVENTORY_V1_V5_USER_OBJECTS,
    toObjects: INVENTORY_V1_USER_OBJECTS,
    sql: INVENTORY_V1_MIGRATE_V5_TO_V6_SQL,
  }),
]);
