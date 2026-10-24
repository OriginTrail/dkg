import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  StatusBadge,
  operationStatusBadgeClass,
} from '../src/ui/pages/Operations.js';

describe('operation status badges', () => {
  it('renders cancellation distinctly from failure and warning states', () => {
    expect(operationStatusBadgeClass('success')).toBe('badge-success');
    expect(operationStatusBadgeClass('error')).toBe('badge-error');
    expect(operationStatusBadgeClass('cancelled')).toBe('badge-cancelled');
    expect(operationStatusBadgeClass('in_progress')).toBe('badge-warn');

    const html = renderToStaticMarkup(
      React.createElement(StatusBadge, { status: 'cancelled' }),
    );
    expect(html).toContain('badge-cancelled');
    expect(html).toContain('cancelled');
  });
});
