import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pool } from '../config/db.js';

// Use the same pool/execute path as the application; never display credentials,
// shipment rows, query parameters, SQL error messages, or trigger bodies.
let client;
try {
  const require = createRequire(import.meta.url);
  console.log(JSON.stringify({ stage: 'application_connection',
    mysql2Version: require('mysql2/package.json').version,
    charsetNumber: pool._mysql.pool.config.connectionConfig.charsetNumber,
    connectionLimit: pool._mysql.pool.config.connectionLimit,
    protocol: 'prepared execute',
  }));
  client = await pool.connect();
  const source = readFileSync(new URL('../sql/diagnose_delhivery_collations.sql', import.meta.url), 'utf8');
  const statements = source.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
  for (const [index, sql] of statements.entries()) {
    const { rows } = await client.query(sql);
    console.log(JSON.stringify({ stage: `metadata.${index + 1}`, rows: rows.map(row => {
      const { ACTION_STATEMENT, ...metadata } = row;
      return ACTION_STATEMENT === undefined ? metadata : { ...metadata, definitionOmitted: true };
    }) }));
  }
  const { rows } = await client.query(`SELECT
    COLLATION(?) AS parameter_collation, COERCIBILITY(?) AS parameter_coercibility,
    COLLATION(COALESCE(?, '1970-01-01')) AS derived_collation,
    COERCIBILITY(COALESCE(?, '1970-01-01')) AS derived_coercibility`,
    Array(4).fill('2026-09-16 01:02:03'));
  console.log(JSON.stringify({ stage: 'prepared_parameter', rows }));
} catch (error) {
  console.error(JSON.stringify({ stage: 'diagnostics', code: error.code || 'UNKNOWN' }));
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
