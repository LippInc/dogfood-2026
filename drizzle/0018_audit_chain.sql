-- The audit chain in the database (DATA-MODEL.md, "The chain"): a new audit_log row must link to the last row (its
-- prev_hash is that row's hash, 64 zeros before the first), may not carry an id or a hash the log already holds (so an
-- INSERT OR REPLACE cannot rewrite a row, even from a connection without recursive_triggers), and may not go before the
-- last row. SQLite has no SHA-256: the database checks the links; verifyAuditChain checks the hashes. The text is
-- src/server/db/triggers.ts's, which the boot re-asserts.
CREATE TRIGGER IF NOT EXISTS audit_log_chain_link
  BEFORE INSERT ON audit_log
  WHEN NEW.prev_hash IS NOT coalesce((SELECT a.hash FROM audit_log a ORDER BY a.id DESC LIMIT 1), '0000000000000000000000000000000000000000000000000000000000000000')
  BEGIN
    SELECT RAISE(ABORT, 'audit_log: a new row must link to the last row (prev_hash is not its hash)');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_log_no_replace
  BEFORE INSERT ON audit_log
  WHEN EXISTS (SELECT 1 FROM audit_log a WHERE a.id = NEW.id OR a.hash = NEW.hash)
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: a row with this id or hash is already there');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_log_at_end
  AFTER INSERT ON audit_log
  WHEN NEW.id < (SELECT max(a.id) FROM audit_log a)
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: a new row goes after the last one');
  END;
