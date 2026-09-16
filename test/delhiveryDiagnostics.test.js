import assert from 'node:assert/strict';
import test from 'node:test';
import { safeDelhiveryError } from '../lib/delhiveryDbDiagnostics.js';

test('database diagnostics exclude SQL, payloads and multiline error messages from stack', () => {
  const error = new Error('customer-secret\n    at customer-private-data');
  Object.assign(error, { code: 'ER_DUP_ENTRY', errno: 1062, sql: 'secret SQL', sqlMessage: 'secret value', queryStage: 'webhook.history.insert' });
  const safe = safeDelhiveryError(error);
  assert.equal(safe.stage, 'webhook.history.insert');
  assert.equal(safe.code, 'ER_DUP_ENTRY');
  assert.match(safe.stack, /delhiveryDiagnostics/);
  assert.doesNotMatch(JSON.stringify(safe), /secret|customer-private/);
});
