import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  OperationStatusBadge as StatusBadge,
  operationStatusLabel,
  operationStatusTone,
} from '../src/ui/components/OperationStatusBadge.js';

describe('operation status badges', () => {
  it('renders cancellation distinctly from failure and warning states', () => {
    expect(operationStatusTone('success')).toBe('success');
    expect(operationStatusTone('error')).toBe('danger');
    expect(operationStatusTone('cancelled')).toBe('muted');
    expect(operationStatusTone('in_progress')).toBe('pending');

    const html = renderToStaticMarkup(
      React.createElement(StatusBadge, { status: 'cancelled' }),
    );
    expect(html).toContain('ds-tone-muted');
    expect(html).toContain('Cancelled'); // sentence case (DESIGN.md · Type)
  });

  it('uses the nOS words Done and Failed', () => {
    expect(operationStatusLabel('success')).toBe('Done');
    expect(operationStatusLabel('error')).toBe('Failed');
    expect(operationStatusLabel('in_progress')).toBe('In progress');
  });
});

describe('one operation status everywhere', () => {
  it('the Transactions list uses the shared badge, not its own status colours', async () => {
    const { readFileSync } = await import('node:fs');
    const bottom = readFileSync(new URL('../src/ui/components/Shell/PanelBottom.tsx', import.meta.url), 'utf8');
    expect(bottom).toContain('<OperationStatusBadge status={op.status} />');
    expect(bottom).not.toMatch(/op\.status === 'success' \? 'var\(--success/);
  });
});
