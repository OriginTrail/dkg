declare module 'better-sqlite3' {
  export interface Statement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }

  export interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): void;
    pragma(sql: string, options?: { simple?: boolean }): unknown;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
    close(): void;
    loadExtension(path: string): void;
  }

  export default class BetterSqlite3Database implements Database {
    constructor(filename: string, options?: Record<string, unknown>);
    prepare(sql: string): Statement;
    exec(sql: string): void;
    pragma(sql: string, options?: { simple?: boolean }): unknown;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
    close(): void;
    loadExtension(path: string): void;
  }
}
