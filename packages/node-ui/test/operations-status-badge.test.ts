import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  StatusBadge,
  operationStatusLabel,
  operationStatusTone,
} from '../src/ui/pages/Operations.js';

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
