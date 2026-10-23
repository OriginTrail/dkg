export const unexpectedBlobSchemas = [
  { label: 'same-name trigger', sql: 'CREATE TRIGGER blobs AFTER INSERT ON blobs BEGIN DELETE FROM blobs WHERE hash=NEW.hash; END;' },
  { label: 'sqliteX table', sql: "CREATE TABLE sqliteXforeign(value TEXT); INSERT INTO sqliteXforeign VALUES('retain me');" },
  { label: 'sqliteX trigger', sql: 'CREATE TRIGGER sqliteXguard AFTER INSERT ON blobs BEGIN DELETE FROM blobs WHERE hash=NEW.hash; END;' },
] as const;
