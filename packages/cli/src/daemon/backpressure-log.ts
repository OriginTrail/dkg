import type { OperationContext } from '@origintrail-official/dkg-core';

export interface BackpressureLogWriter {
  info(context: OperationContext, message: string): void;
  warn(context: OperationContext, message: string): void;
}

/**
 * Route monitor output through the structured daemon logger.
 *
 * The structured logger is the single path that persists records to the
 * dashboard database and forwards redacted copies to syslog/OTLP. Keeping this
 * adapter separate makes the remote-observability wiring testable without
 * starting a daemon.
 */
export function createBackpressureLogEmitter(
  logger: BackpressureLogWriter,
  context: OperationContext,
): (level: 'info' | 'warn', message: string) => void {
  return (level, message) => {
    logger[level](context, message);
  };
}
