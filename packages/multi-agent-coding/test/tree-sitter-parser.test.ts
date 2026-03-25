/**
 * Unit tests for the tree-sitter parser (Python and Solidity).
 */

import { describe, it, expect } from 'vitest';
import { TreeSitterParser } from '../src/code/tree-sitter-parser.js';

describe('TreeSitterParser — Python', () => {
  const parser = new TreeSitterParser('python');

  it('extracts a class', async () => {
    const result = await parser.parse(`
class Animal:
    def __init__(self, name):
        self.name = name

    def speak(self):
        pass
`, 'test.py');

    const cls = result.entities.find(e => e.kind === 'class' && e.name === 'Animal');
    expect(cls).toBeDefined();
    expect(cls!.startLine).toBe(2);
  });

  it('extracts functions and methods', async () => {
    const result = await parser.parse(`
def greet(name):
    return f"Hello, {name}"

class Calculator:
    def add(self, a, b):
        return a + b
`, 'calc.py');

    const greet = result.entities.find(e => e.kind === 'function' && e.name === 'greet');
    expect(greet).toBeDefined();
    expect(greet!.parameters).toEqual(['name']);

    const add = result.entities.find(e => e.kind === 'method' && e.name === 'add');
    expect(add).toBeDefined();
    expect(add!.parentClass).toBe('Calculator');
    // self should be filtered out
    expect(add!.parameters).not.toContain('self');
  });

  it('extracts imports', async () => {
    const result = await parser.parse(`
import os
from pathlib import Path
from typing import List, Optional
`, 'test.py');

    expect(result.imports.length).toBeGreaterThanOrEqual(2);
    const osImport = result.imports.find(i => i.source === 'os');
    expect(osImport).toBeDefined();
  });

  it('extracts class with inheritance', async () => {
    const result = await parser.parse(`
class Dog(Animal):
    def speak(self):
        return "Woof"
`, 'test.py');

    const cls = result.entities.find(e => e.kind === 'class' && e.name === 'Dog');
    expect(cls).toBeDefined();
    expect(cls!.extends).toBe('Animal');
  });

  it('extracts function with return type annotation', async () => {
    const result = await parser.parse(`
def process(data: bytes) -> str:
    return data.decode('utf-8')
`, 'test.py');

    const fn = result.entities.find(e => e.name === 'process');
    expect(fn).toBeDefined();
    expect(fn!.returnType).toBeDefined();
  });
});

describe('TreeSitterParser — Solidity', () => {
  const parser = new TreeSitterParser('solidity');

  it('extracts a contract', async () => {
    const result = await parser.parse(`
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Token {
    string public name;

    function transfer(address to, uint256 amount) public returns (bool) {
        return true;
    }
}
`, 'Token.sol');

    const contract = result.entities.find(e => e.kind === 'class' && e.name === 'Token');
    expect(contract).toBeDefined();
    expect(contract!.isExported).toBe(true);

    const transfer = result.entities.find(e => e.name === 'transfer');
    expect(transfer).toBeDefined();
    expect(transfer!.kind).toBe('method');
    expect(transfer!.parentClass).toBe('Token');
  });

  it('extracts contract with inheritance', async () => {
    const result = await parser.parse(`
pragma solidity ^0.8.0;

contract ERC20 is IERC20 {
    mapping(address => uint256) private _balances;
}
`, 'ERC20.sol');

    const contract = result.entities.find(e => e.kind === 'class' && e.name === 'ERC20');
    expect(contract).toBeDefined();
  });

  it('extracts imports', async () => {
    const result = await parser.parse(`
pragma solidity ^0.8.0;

import "./IERC20.sol";
import {SafeMath} from "./SafeMath.sol";
`, 'Token.sol');

    expect(result.imports.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts structs and enums', async () => {
    const result = await parser.parse(`
pragma solidity ^0.8.0;

contract Governance {
    struct Proposal {
        uint256 id;
        string description;
    }

    enum Status { Pending, Active, Completed }
}
`, 'Governance.sol');

    const structEntity = result.entities.find(e => e.kind === 'struct');
    expect(structEntity).toBeDefined();
    expect(structEntity!.name).toBe('Proposal');

    const enumEntity = result.entities.find(e => e.kind === 'enum');
    expect(enumEntity).toBeDefined();
    expect(enumEntity!.name).toBe('Status');
  });

  it('extracts events and modifiers', async () => {
    const result = await parser.parse(`
pragma solidity ^0.8.0;

contract Access {
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner);
        _;
    }
}
`, 'Access.sol');

    const event = result.entities.find(e => e.name === 'OwnerChanged');
    expect(event).toBeDefined();

    const modifier = result.entities.find(e => e.name === 'onlyOwner');
    expect(modifier).toBeDefined();
  });
});
