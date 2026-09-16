import { AsyncLocalStorage } from 'node:async_hooks';

const stages = new AsyncLocalStorage();

// Stage names are static source-code identifiers, never shipment/customer values.
export function withDelhiveryDbStage(stage, operation) {
  return stages.run(stage, async () => {
    try {
      return await operation();
    } catch (error) {
      // Includes connection/transaction failures outside executeOn. Preserve a
      // more specific inner query stage and avoid logging it twice here.
      if (!error?.queryStage) logDelhiveryDbError(error);
      throw error;
    }
  });
}

export function logDelhiveryDbError(error) {
  const stage = stages.getStore();
  if (!stage) return;
  error.queryStage = stage;
  console.error('Delhivery database query failed', safeDelhiveryError(error));
}

export function safeDelhiveryError(error) {
  // mysql2 messages (and the first stack line) can include SQL/data. Retain only
  // source frames, never error.message, sql, sqlMessage, parameters, or payloads.
  const rawStack = String(error?.stack || '');
  const heading = `${error?.name || 'Error'}: ${error?.message || ''}`;
  const frames = rawStack.startsWith(heading) ? rawStack.slice(heading.length) : '';
  const stack = frames.split('\n')
    .filter(line => /^\s+at /.test(line)).slice(0, 12).join('\n');
  return {
    stage: error?.queryStage,
    code: /^(ER_|DELHIVERY_)[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'PROCESSING_ERROR',
    errno: Number.isInteger(error?.errno) ? error.errno : undefined,
    stack,
  };
}
