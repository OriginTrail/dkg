/**
 * Unit tests for the TypeScript/JavaScript parser.
 */

import { describe, it, expect } from 'vitest';
import { TypeScriptParser } from '../src/code/typescript-parser.js';

const parser = new TypeScriptParser();

describe('TypeScriptParser', () => {
  describe('class extraction', () => {
    it('extracts a basic class', async () => {
      const result = await parser.parse(`
export class Foo {
  bar(): void {}
}`, 'test.ts');

      const cls = result.entities.find(e => e.kind === 'class' && e.name === 'Foo');
      expect(cls).toBeDefined();
      expect(cls!.isExported).toBe(true);
      expect(cls!.startLine).toBe(2);
    });

    it('extracts class with extends and implements', async () => {
      const result = await parser.parse(`
export class Dog extends Animal implements Pet, Trainable {
  speak(): string { return 'woof'; }
}`, 'test.ts');

      const cls = result.entities.find(e => e.kind === 'class' && e.name === 'Dog');
      expect(cls).toBeDefined();
      expect(cls!.extends).toBe('Animal');
      expect(cls!.implements).toEqual(['Pet', 'Trainable']);
    });

    it('extracts class methods', async () => {
      const result = await parser.parse(`
class Service {
  private async fetchData(url: string): Promise<Response> {
    return fetch(url);
  }
  public getName(): string { return ''; }
}`, 'test.ts');

      const methods = result.entities.filter(e => e.kind === 'method');
      expect(methods.length).toBe(2);

      const fetchData = methods.find(m => m.name === 'fetchData');
      expect(fetchData).toBeDefined();
      expect(fetchData!.parentClass).toBe('Service');
      expect(fetchData!.isAsync).toBe(true);
      expect(fetchData!.visibility).toBe('private');
      expect(fetchData!.parameters).toContain('url');
      expect(fetchData!.returnType).toBe('Promise<Response>');
    });

    it('extracts constructor', async () => {
      const result = await parser.parse(`
class Point {
  constructor(public x: number, public y: number) {}
}`, 'test.ts');

      const ctor = result.entities.find(e => e.name === 'constructor');
      expect(ctor).toBeDefined();
      expect(ctor!.kind).toBe('method');
      expect(ctor!.parentClass).toBe('Point');
      expect(ctor!.parameters).toContain('x');
      expect(ctor!.parameters).toContain('y');
    });
  });

  describe('interface extraction', () => {
    it('extracts interfaces', async () => {
      const result = await parser.parse(`
export interface Config {
  host: string;
  port: number;
}`, 'test.ts');

      const iface = result.entities.find(e => e.kind === 'interface' && e.name === 'Config');
      expect(iface).toBeDefined();
      expect(iface!.isExported).toBe(true);
    });

    it('extracts interface with extends', async () => {
      const result = await parser.parse(`
interface ExtendedConfig extends BaseConfig {
  extra: boolean;
}`, 'test.ts');

      const iface = result.entities.find(e => e.kind === 'interface');
      expect(iface).toBeDefined();
      expect(iface!.extends).toBe('BaseConfig');
    });
  });

  describe('function extraction', () => {
    it('extracts top-level functions', async () => {
      const result = await parser.parse(`
export async function loadData(path: string): Promise<Buffer> {
  return readFile(path);
}`, 'test.ts');

      const fn = result.entities.find(e => e.kind === 'function' && e.name === 'loadData');
      expect(fn).toBeDefined();
      expect(fn!.isAsync).toBe(true);
      expect(fn!.isExported).toBe(true);
      expect(fn!.parameters).toEqual(['path']);
      expect(fn!.returnType).toBe('Promise<Buffer>');
      expect(fn!.signature).toContain('async function loadData');
    });

    it('extracts arrow function assigned to const', async () => {
      const result = await parser.parse(`
export const greet = (name: string): string => \`Hello \${name}\`;`, 'test.ts');

      const fn = result.entities.find(e => e.kind === 'function' && e.name === 'greet');
      expect(fn).toBeDefined();
      expect(fn!.isExported).toBe(true);
      expect(fn!.parameters).toEqual(['name']);
    });
  });

  describe('type alias extraction', () => {
    it('extracts type aliases', async () => {
      const result = await parser.parse(`
export type Status = 'active' | 'inactive';`, 'test.ts');

      const type = result.entities.find(e => e.kind === 'type' && e.name === 'Status');
      expect(type).toBeDefined();
      expect(type!.isExported).toBe(true);
    });
  });

  describe('enum extraction', () => {
    it('extracts enums', async () => {
      const result = await parser.parse(`
export enum Color {
  Red,
  Green,
  Blue,
}`, 'test.ts');

      const en = result.entities.find(e => e.kind === 'enum' && e.name === 'Color');
      expect(en).toBeDefined();
      expect(en!.isExported).toBe(true);
    });
  });

  describe('import extraction', () => {
    it('extracts named imports', async () => {
      const result = await parser.parse(`
import { readFile, writeFile } from 'node:fs/promises';`, 'test.ts');

      expect(result.imports.length).toBe(1);
      expect(result.imports[0].source).toBe('node:fs/promises');
      expect(result.imports[0].specifiers).toEqual(['readFile', 'writeFile']);
    });

    it('extracts default imports', async () => {
      const result = await parser.parse(`
import React from 'react';`, 'test.ts');

      expect(result.imports.length).toBe(1);
      expect(result.imports[0].specifiers).toContain('React');
    });

    it('extracts namespace imports', async () => {
      const result = await parser.parse(`
import * as path from 'node:path';`, 'test.ts');

      expect(result.imports.length).toBe(1);
      expect(result.imports[0].specifiers).toContain('* as path');
    });

    it('extracts type-only imports', async () => {
      const result = await parser.parse(`
import type { Config } from './config.js';`, 'test.ts');

      expect(result.imports.length).toBe(1);
      expect(result.imports[0].isTypeOnly).toBe(true);
    });
  });

  describe('export extraction', () => {
    it('extracts re-exports', async () => {
      const result = await parser.parse(`
export { foo, bar } from './utils.js';`, 'test.ts');

      expect(result.exports.length).toBe(2);
      expect(result.exports.map(e => e.name)).toContain('foo');
      expect(result.exports.map(e => e.name)).toContain('bar');
    });

    it('extracts default export', async () => {
      const result = await parser.parse(`
export default function main() {}`, 'test.ts');

      // The function itself should be extracted + the default export
      const fn = result.entities.find(e => e.name === 'main');
      expect(fn).toBeDefined();
    });
  });

  describe('constant extraction', () => {
    it('extracts exported constants', async () => {
      const result = await parser.parse(`
export const MAX_SIZE = 1024;
export const API_URL = 'https://api.example.com';`, 'test.ts');

      const consts = result.entities.filter(e => e.kind === 'constant');
      expect(consts.length).toBe(2);
      expect(consts.map(c => c.name)).toContain('MAX_SIZE');
      expect(consts.map(c => c.name)).toContain('API_URL');
    });
  });

  describe('JSX/TSX support', () => {
    it('handles TSX files', async () => {
      const result = await parser.parse(`
import React from 'react';

export function App(): JSX.Element {
  return <div>Hello</div>;
}`, 'App.tsx');

      const fn = result.entities.find(e => e.name === 'App');
      expect(fn).toBeDefined();
      expect(fn!.kind).toBe('function');
      expect(result.imports.length).toBe(1);
    });
  });
});
