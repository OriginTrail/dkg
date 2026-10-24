/**
 * The schema fixture for every store test in this package.
 *
 * In Phase 1 of the extraction the stores moved but the SQLite file did not:
 * `DashboardDB` (packages/node-ui) still opens `node-ui.db` and still owns every
 * table, index and migration the stores read and write. The stores are
 * therefore tested against the REAL database class rather than a hand-copied
 * DDL fixture that could drift from it.
 *
 * This is a relative test-only import, not a package dependency: this package
 * must never depend on node-ui (node-ui depends on this one), and the workspace
 * graph stays acyclic. Once protocol state has its own database (Phase 2) the
 * schema moves here and this helper goes away.
 */
export { DashboardDB, SCHEMA_VERSION } from '../../../node-ui/src/db.js';
