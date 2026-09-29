-- A per-row salt for the audit rows whose values some reader may not see yet (a ballot's picks while voting
-- is open; a judge's scores, texts and pairwise answers in webhook bodies). It is hashed with the row, so the
-- row's hash no longer gives the values away to someone who can guess them (src/server/audit.ts). Added, not
-- rebuilt: every row already written keeps its bytes and has no salt, so the chain verifies as before, and the
-- table is never dropped, so its append-only triggers stay; they are re-asserted here all the same, with the
-- text of src/server/db/triggers.ts, as the boot does.
ALTER TABLE `audit_log` ADD `salt` text CONSTRAINT "audit_salt_format" CHECK("salt" is null or (length("salt") = 64 and "salt" not glob '*[^0-9a-f]*'));
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
  BEFORE UPDATE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE rejected');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
  BEFORE DELETE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: DELETE rejected');
  END;
