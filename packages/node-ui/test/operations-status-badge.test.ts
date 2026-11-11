import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  StatusBadge,
  operationStatusBadgeClass,
} from '../src/ui/pages/Operations.js';

describe('operation status badges', () => {
  it('renders cancellation distinctly from failure and warning states', () => {
    expect(operationStatusBadgeClass('success')).toBe('ds-tone-success');
    expect(operationStatusBadgeClass('error')).toBe('ds-tone-danger');
    expect(operationStatusBadgeClass('cancelled')).toBe('ds-tone-muted');
    expect(operationStatusBadgeClass('in_progress')).toBe('ds-tone-warning');

    const html = renderToStaticMarkup(
      React.createElement(StatusBadge, { status: 'cancelled' }),
    );
    expect(html).toContain('ds-tone-muted');
    expect(html).toContain('Cancelled'); // sentence case (DESIGN.md · Type)
  });
});
