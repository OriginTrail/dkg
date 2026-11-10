/** Move only recorded profile/owner metadata into its invocation, atomically. */
export function migrateDkgInvocationMetadata(db) {
  db.exec('SAVEPOINT dkg_invocation_metadata');
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(dkg_component_runs)').all().map(column => column.name));
    for (const name of ['profile_id', 'profile_revision', 'actor', 'authority'])
      if (!columns.has(name)) db.exec(`ALTER TABLE dkg_component_runs ADD COLUMN ${name} TEXT`);
    const exists = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (exists('dkg_component_profiles')) {
      if (db.prepare(`SELECT 1 FROM dkg_component_runs r JOIN dkg_component_profiles p ON p.id=r.id
        WHERE (r.profile_id IS NOT NULL AND r.profile_id<>p.profile_id)
          OR (r.profile_revision IS NOT NULL AND r.profile_revision<>p.revision) LIMIT 1`).get())
        throw new Error('Conflicting stored invocation profile metadata.');
      db.exec(`UPDATE dkg_component_runs SET
        profile_id=COALESCE(profile_id,(SELECT profile_id FROM dkg_component_profiles WHERE id=dkg_component_runs.id)),
        profile_revision=COALESCE(profile_revision,(SELECT revision FROM dkg_component_profiles WHERE id=dkg_component_runs.id));
        DROP TABLE dkg_component_profiles;`);
    }
    if (exists('dkg_component_actors')) {
      if (db.prepare(`SELECT 1 FROM dkg_component_runs r JOIN dkg_component_actors a ON a.id=r.id
        WHERE r.actor IS NOT NULL AND r.actor<>a.actor LIMIT 1`).get())
        throw new Error('Conflicting stored invocation owner metadata.');
      db.exec(`UPDATE dkg_component_runs SET actor=COALESCE(actor,
        (SELECT actor FROM dkg_component_actors WHERE id=dkg_component_runs.id));
        DROP TABLE dkg_component_actors;`);
    }
    // Missing metadata stays SQL NULL. No current profile or principal is assigned.
    db.exec('RELEASE dkg_invocation_metadata');
  } catch (error) {
    db.exec('ROLLBACK TO dkg_invocation_metadata');
    db.exec('RELEASE dkg_invocation_metadata');
    throw error;
  }
}
