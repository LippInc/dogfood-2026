-- The close-call choices are final once an event's results are published (JUDGING.md, "Close calls and the judges'
-- decision"): the database refuses a settings write that changes closeCalls after publishing, as the app does (409).
-- The text is src/server/db/triggers.ts's, which the boot re-asserts.
CREATE TRIGGER IF NOT EXISTS events_close_calls_final
  BEFORE UPDATE OF settings ON events
  WHEN OLD.results_published_at IS NOT NULL
    AND json_extract(NEW.settings, '$.closeCalls') IS NOT json_extract(OLD.settings, '$.closeCalls')
  BEGIN
    SELECT RAISE(ABORT, 'events: the close-call choices are final once results are published');
  END;
