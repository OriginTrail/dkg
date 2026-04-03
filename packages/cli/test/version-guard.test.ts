import { describe, it, expect } from 'vitest';
import { parseMajorVersion, isMajorVersionBump } from '../src/daemon.js';

describe('parseMajorVersion', () => {
  it('extracts major from stable version', () => {
    expect(parseMajorVersion('9.0.0')).toBe(9);
    expect(parseMajorVersion('10.0.0')).toBe(10);
    expect(parseMajorVersion('1.2.3')).toBe(1);
  });

  it('extracts major from prerelease version', () => {
    expect(parseMajorVersion('9.0.0-beta.6')).toBe(9);
    expect(parseMajorVersion('10.0.0-rc.1')).toBe(10);
  });

  it('returns null for invalid input', () => {
    expect(parseMajorVersion('')).toBeNull();
    expect(parseMajorVersion('abc')).toBeNull();
    expect(parseMajorVersion('latest')).toBeNull();
  });
});

describe('isMajorVersionBump', () => {
  it('detects major version upgrade', () => {
    expect(isMajorVersionBump('9.0.0-beta.6', '10.0.0')).toBe(true);
    expect(isMajorVersionBump('9.1.2', '10.0.0-rc.1')).toBe(true);
  });

  it('detects major version downgrade', () => {
    expect(isMajorVersionBump('10.0.0', '9.0.0')).toBe(true);
  });

  it('allows minor/patch updates within same major', () => {
    expect(isMajorVersionBump('9.0.0', '9.0.1')).toBe(false);
    expect(isMajorVersionBump('9.0.0', '9.1.0')).toBe(false);
    expect(isMajorVersionBump('9.0.0-beta.5', '9.0.0-beta.6')).toBe(false);
  });

  it('allows same version', () => {
    expect(isMajorVersionBump('9.0.0', '9.0.0')).toBe(false);
  });

  it('returns false when versions are unparseable', () => {
    expect(isMajorVersionBump('', '10.0.0')).toBe(false);
    expect(isMajorVersionBump('9.0.0', '')).toBe(false);
    expect(isMajorVersionBump('abc', '10.0.0')).toBe(false);
  });
});
