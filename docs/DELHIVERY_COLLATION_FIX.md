# September 16 tracking collation fix

## Evidence and limits

Inspected base: `70b7699f0d525170a6049db42ca84b5a9b9098cd` on `main`.
Read-only `git ls-remote origin HEAD` returned that same SHA on September 16.
The supplied 11:20 production logs show the pacing/missing-AWB behavior from that
commit (`collationSafeEq` present; date COALESCE still failing) but do not contain
a build SHA. No Hostinger session or production DB credentials were available in
the workspace. The live production engine/version, connection state, schema and
triggers remain **not verified** until post-deploy diagnostics run.

## Failing statement and smallest fix

`refreshOneShipment` inserts history using `INSERT ... SELECT ... FROM DUAL
WHERE NOT EXISTS (...)`. Its remaining unprotected expression was:

```sql
COALESCE(event_time, '1970-01-01') = COALESCE(?, '1970-01-01')
```

With a `utf8mb4_general_ci` prepared parameter and a
`utf8mb4_unicode_ci` session/literal, MariaDB reported:

| Expression | Collation | Coercibility |
| --- | --- | --- |
| Bound string parameter | utf8mb4_general_ci | COERCIBLE |
| Left date COALESCE | utf8mb4_unicode_ci | 4 / COERCIBLE |
| Right parameter COALESCE | utf8mb4_bin | 1 / NONE |

The complete original history INSERT throws precisely
`ER_CANT_AGGREGATE_2COLLATIONS: Illegal mix of collations
(utf8mb4_unicode_ci,COERCIBLE) and (utf8mb4_bin,NONE) for operation '='`.
The matching-session control does not fail. The defect depends on expression
typing and connection/parameter collations, not just table defaults.

Replacement:

```sql
event_time <=> CAST(? AS DATETIME)
```

This compares temporal values with explicit NULL equality. Input already goes
through `mysqlDateTime`, producing a full seconds-resolution datetime or NULL.
NULL/NULL still deduplicates; a real `1970-01-01 00:00:00` remains distinct from
NULL. Using typed COALESCE sentinels on both sides would conflate these two cases.
Real database tests compare old/new results on a compatible session for NULL,
epoch and ordinary date combinations.

The earlier `collationSafeEq` explicitly collates BOTH operands to
`utf8mb4_unicode_ci` and converts the parameter to utf8mb4. It is retained.
Tests confirm its case/accent-insensitive behavior for status and for
`CONVERT(IFNULL(location, '') USING utf8mb4)`, including a binary-collated
location column. It never protected the date expression above.

**No migration, table-wide conversion, connection-collation change, dependency
update, or error suppression is required by this patch.**

## Database call trace and comparison review

| Path | Queries and review |
| --- | --- |
| Scheduled selection | Select due shipments; environment parameter comparison; explicit unicode status NOT IN; temporal COALESCE used only for sorting. |
| `acquireShipmentOperation` → `shipmentById` | Begin; numeric-ID SELECT FOR UPDATE; check environment/token age in JS; set processing token by numeric ID; commit (rollback on error). |
| `refreshOneShipment` history loop | INSERT/NOT EXISTS; numeric shipment ID; explicit unicode status/location comparisons; **date expression fixed**. |
| Current shipment update | Numeric CASE flags; date/text COALESCE assignments are not string equality predicates; numeric ID filter. Tested actual writes, including delivered_at. |
| Order update → `writeAudit` | Numeric order ID equality; audit JSON insert. |
| Older tracking event | History retained; only tracking response/fetch time/error metadata updated. Existing status time/progression guards remain. |
| `releaseShipmentOperation` | Numeric ID and processing-token column/parameter equality; original best-effort release retained, now query failures have a stage log. |
| Webhook | Begin; AWB column/parameter SELECT FOR UPDATE; INSERT IGNORE with unique `(shipment_id,event_key)`; JS time/progression guard; shipment/order/audit updates; commit/rollback. Numeric CASE flags retained. |
| Triggers/derived schema expressions | None defined in repository SQL. Production may have additional triggers, CHECKs or generated columns; inspect using diagnostics below, including routines/tables called by triggers. |

Existing transaction boundaries are preserved: webhook persistence is atomic;
tracking's operation-lock acquisition is transactional, but the subsequent
history/shipment/order/audit writes are separate autocommit operations, as before.
This patch does not claim to repair pre-existing tracking/webhook concurrency or
partial-write behavior. Tracking's token guard and webhook unique-key protection
remain intact.

Named stages identify batch selection, lock acquisition/release, history
deduplication, shipment update/stale handling, order update, and audit insertion.
Webhook stages identify its lock/history/shipment/order/audit statements.
Diagnostics retain source stack frames and error codes, excluding SQL, bound
values, raw error messages, payloads, and credentials. Request logs now list query
parameter names rather than AWB/customer values. Success logs report only counts
and applied/duplicate/stale flags.

## Read-only production diagnostics

From the deployed backend directory, with its existing environment available:

```sh
git rev-parse HEAD
node -e "import('./lib/buildIdentity.js').then(m=>console.log(JSON.stringify(m.buildIdentity())))"
node scripts/diagnose-delhivery-db.js
```

The script uses the actual app pool and prepared protocol, pins one connection,
and prints driver version, configured charset number, session/server settings,
column collations/types, indexes, trigger metadata and synthetic parameter
coercibility. It does not select customer rows. It omits trigger bodies.
If `.git` is absent, compare the source fingerprint with the reviewed checkout.
The startup log now includes the same fingerprint and the commit when available.

Without an app shell, execute the exact read-only queries in
`sql/diagnose_delhivery_collations.sql` in the production database's SQL console.
Also inspect locally:

```sql
SHOW CREATE TABLE shipments;
SHOW CREATE TABLE shipment_tracking_history;
SHOW CREATE TABLE orders;
SHOW CREATE TABLE shipment_audit_log;
SHOW GLOBAL VARIABLES LIKE 'init_connect';
```

For every trigger name returned, run `SHOW CREATE TRIGGER` with that name and
inspect any referenced routines and downstream tables. Do not paste unredacted
definitions if they contain hardcoded private values. Empty trigger metadata
without TRIGGER privilege is inconclusive; have the database administrator check.
A phpMyAdmin session's connection variables do **not** verify the Node session.
Production parameter coercibility must come from the app script.

## Reproduction and tests

Use a disposable local MariaDB server bound to loopback (not a production tunnel).
The script requires explicit opt-in, creates a unique database, and drops only
that database in `finally`. Courier HTTP is stubbed; all persistence uses real SQL.

PowerShell, with credentials belonging only to that disposable instance:

```powershell
$env:DELHIVERY_DB_LAB='1'
$env:LAB_DB_PORT='33318'
$env:LAB_DB_USER='root'
$env:LAB_DB_PASSWORD='<disposable-instance-password>'
node scripts/delhivery-db-regression.js
node scripts/delhivery-db-regression.js --matched-connection
node --test --test-isolation=none "test/delhiveryWebhook.test.js" "test/delhiveryCollationThrottle.test.js" "test/delhiveryDiagnostics.test.js"
```

The default run deliberately mismatches handshake/session collations. The second
run uses the application default for the actual worker/webhook connection; both
runs independently reproduce the original SQL on a mismatched control connection.
Repeat using the **exact engine/version, SQL mode, column definitions and connection
state reported by production** before calling this a production-matched reproduction.

Results on September 16 (this workspace): MariaDB **10.11.14** on loopback
`127.0.0.1:33318`, Node 24.14.1, mysql2 3.x from package-lock. **13/13** real-DB
checks passed in both connection modes. **17** focused unit tests passed.
Checks cover exact original failure, fixed duplicate behavior, unicode semantics,
NULL/empty/epoch boundaries, actual scheduled batch and order/audit persistence,
pacing, stale events, actual webhook handler, concurrent webhook duplicates,
trigger-induced rollback/redacted stage logging, delivered timestamps, missing
AWB cooldown, and 429 recovery/exhaustion at three requests.

`npm test` also auto-discovers pre-existing live smoke scripts outside `test/`.
It reports many passing tests but exits 1 because localhost:3000 and production DB
configuration are unavailable. Do not report that command as a full-suite pass.

**Still unverified against Hostinger production:** deployed SHA after this fix,
production MySQL/MariaDB version and `init_connect`, live column collations,
production triggers, and post-deploy processing logs. Use the diagnostics below
after redeploy. Production success is **not** claimed until those succeed.

## GitHub and Hostinger deployment

Changes are local and have not been pushed or deployed. From this backend repo:

```sh
git switch -c fix/delhivery-temporal-dedup
git add config/db.js controllers/logisticsController.js controllers/delhiveryWebhookController.js services/delhiveryWebhookService.js services/logisticsSyncService.js services/delhiveryService.js server.js lib/buildIdentity.js lib/delhiveryDbDiagnostics.js scripts/delhivery-db-regression.js scripts/diagnose-delhivery-db.js sql/diagnose_delhivery_collations.sql test/delhiveryDiagnostics.test.js docs/DELHIVERY_COLLATION_FIX.md
git diff --cached --check
git commit -m "Fix Delhivery history datetime deduplication collation error"
git push -u origin fix/delhivery-temporal-dedup
```

1. In `telaqua-ph/telaqua_mysql_backend` on GitHub, open a PR from
   `fix/delhivery-temporal-dedup` to `main`, review this diff and the real-DB results,
   and merge. Record the final commit SHA. If auto-deploy is enabled, merging may
   immediately start the deployment.
2. Fetch the merged version locally (`git fetch origin`, `git switch main`,
   `git pull --ff-only origin main`); run the build-identity command above and record
   its fingerprint with `git rev-parse HEAD`.
3. In Hostinger hPanel open the **backend** Website Dashboard → **Deployments** →
   **Redeploy**. Confirm GitHub repository `telaqua-ph/telaqua_mysql_backend`, branch
   `main`, and the merged source. For this standalone repository use root `.`.
4. Retain Node 24 and existing environment values. Use `npm ci` to install locked
   dependencies and `npm start` (entry `server.js`) to start; no compilation or
   database migration is needed. Retain tracking enablement, environment, interval,
   pacing and webhook authentication settings. Do not put secrets in build commands.
5. Confirm settings and click **Redeploy**. A GitHub redeploy uses the latest code
   from its selected branch. For a ZIP deployment, upload the new source ZIP;
   **Use previous files** would redeploy the old archive.
6. Verify the deployment's SHA when shown, then compare the new process's startup
   `sourceFingerprint` to step 2. A restart/startup message alone proves nothing
   about processing. If `.git` is absent, `commit:null` is expected; the fingerprint
   must still match. Separate the old SIGTERM process's logs from the new process.

Hostinger's current workflow: https://www.hostinger.com/support/how-to-redeploy-a-node-js-application/

## Safe verification after deployment

1. Record the new process identity, deployment time and DB session timezone. Run
   the read-only diagnostics. Resolve any production trigger/schema mismatch.
2. Let the normal worker run (first run around 10 seconds after startup; subsequent
   runs use the configured interval). Do not reset customer cooldowns, replay
   fabricated payloads, or disable pacing. If no eligible shipments exist, await
   naturally due work; startup/empty batches are not proof of the fix.
3. Require `Scheduled Delhivery tracking processed` for genuinely due shipments and
   no `Delhivery database query failed`/collation errors in that new deployment's
   processing window. Inspect `tracking.history.deduplicate` first if it fails.
   Continue monitoring at least one subsequent scheduled batch.
4. Privately select a naturally processed shipment in the admin application and
   check actual carrier status, new/unchanged history, order fulfillment, cleared
   error and released lock. For a read-only SQL aggregate check, bind the real
   internal ID locally (do not paste customer data into logs):

   ```sql
   SELECT last_tracking_update, shipment_status_at, fulfillment_status,
          last_error IS NULL AS error_cleared,
          processing_token IS NULL AS lock_released
   FROM shipments WHERE id = ?;
   SELECT COUNT(*) AS events, MAX(created_at) AS latest_history_insert
   FROM shipment_tracking_history WHERE shipment_id = ?;
   SELECT COUNT(*) AS audits, MAX(created_at) AS latest_tracking_audit
   FROM shipment_audit_log WHERE shipment_id = ? AND action = 'tracking_refreshed';
   SELECT o.fulfillment_status = s.fulfillment_status COLLATE utf8mb4_unicode_ci AS status_matches
   FROM orders o JOIN shipments s ON o.id = s.order_id WHERE s.id = ?;
   ```

   Zero added history can be valid for an unchanged carrier response. Verify one
   naturally new event when available. A stale event should add history without
   regressing current state. Compare counts before/after a naturally repeated scan
   to confirm no additional duplicate. Do not delete historical duplicates.
5. Observe an authentic Delhivery webhook arriving normally: HTTP 200 and
   `Delhivery webhook processed` with the expected applied/duplicate flag; confirm
   the persisted history/state privately. If no webhook arrives, record webhook
   production verification as pending, even though local real-DB tests pass.
6. If database errors persist, retain sanitized stage/code/source frames and the
   metadata diagnostics; do not repeatedly redeploy or retry fabricated updates.
   Review the specific statement and its triggers. Production success remains
   unconfirmed until actual processing and persisted results are checked.
