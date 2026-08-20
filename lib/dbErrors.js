/**
 * MySQL / legacy PostgreSQL error classification helpers.
 */

export function isMissingTableError(err) {
  const code = err?.code;
  const msg = String(err?.message || "");
  return code === "ER_NO_SUCH_TABLE" || code === "42P01" || /doesn't exist/i.test(msg);
}

export function isMissingColumnError(err, column) {
  const code = err?.code;
  const msg = String(err?.message || "");
  if (code === "ER_BAD_FIELD_ERROR" || code === "42703") return true;
  if (column && msg.includes(column)) return true;
  return /Unknown column/i.test(msg);
}

export function isDuplicateKeyError(err) {
  const code = err?.code;
  return code === "ER_DUP_ENTRY" || code === "23505";
}
