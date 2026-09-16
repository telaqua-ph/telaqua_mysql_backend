-- READ ONLY. Run in the application's database; no customer rows are selected.
SELECT VERSION() AS engine_version, @@version_comment AS engine_comment,
       @@character_set_client AS character_set_client,
       @@character_set_connection AS character_set_connection,
       @@character_set_results AS character_set_results,
       @@collation_connection AS collation_connection,
       @@character_set_database AS character_set_database,
       @@collation_database AS collation_database,
       @@sql_mode AS sql_mode, @@session.time_zone AS time_zone;

SELECT TABLE_NAME, ENGINE, TABLE_COLLATION
FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
AND TABLE_NAME IN ('shipments', 'shipment_tracking_history', 'orders', 'shipment_audit_log');

SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME,
       IS_NULLABLE, EXTRA, GENERATION_EXPRESSION
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
AND TABLE_NAME IN ('shipments', 'shipment_tracking_history', 'orders', 'shipment_audit_log')
ORDER BY TABLE_NAME, ORDINAL_POSITION;

SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
AND TABLE_NAME IN ('shipments', 'shipment_tracking_history', 'orders', 'shipment_audit_log')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- Inspect ACTION_STATEMENT locally: trigger definitions can contain hardcoded values.
SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION,
       CHARACTER_SET_CLIENT, COLLATION_CONNECTION, DATABASE_COLLATION, ACTION_STATEMENT
FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()
AND EVENT_OBJECT_TABLE IN ('shipments', 'shipment_tracking_history', 'orders', 'shipment_audit_log');

-- Also run SHOW CREATE TABLE for these four tables locally to inspect CHECK constraints.
-- Trigger visibility requires TRIGGER privilege. An empty result without that privilege
-- is not proof that no triggers exist. Inspect called routines/other written tables too.
