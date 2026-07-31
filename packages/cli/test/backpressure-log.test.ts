import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { createBackpressureLogEmitter } from '../src/daemon/backpressure-log.js';

describe('backpressure log bridge', () => {
  it('routes warning and recovery records through the structured logger', () => {
    const context: OperationContext = {
      operationId: 'backpressure-monitor',
      operationName: 'system',
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const emit = createBackpressureLogEmitter(logger, context);

    emit('warn', '[backpressure] {"event":"transition"}');
    emit('info', '[backpressure] {"event":"recovered"}');

    expect(logger.warn).toHaveBeenCalledWith(
      context,
      '[backpressure] {"event":"transition"}',
    );
    expect(logger.info).toHaveBeenCalledWith(
      context,
      '[backpressure] {"event":"recovered"}',
    );
  });
});
