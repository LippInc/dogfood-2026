-- The tie-break is final once an event's results are published (JUDGING.md, "Breaking exact ties"): the database
-- refuses a settings write that changes tieBreak or tieBreakChanges after publishing, as the app does (409). The text
-- is src/server/db/triggers.ts's, which the boot re-asserts.
CREATE TRIGGER IF NOT EXISTS events_tie_break_final
  BEFORE UPDATE OF settings ON events
  WHEN OLD.results_published_at IS NOT NULL
    AND (json_extract(NEW.settings, '$.tieBreak') IS NOT json_extract(OLD.settings, '$.tieBreak')
      OR json_extract(NEW.settings, '$.tieBreakChanges') IS NOT json_extract(OLD.settings, '$.tieBreakChanges'))
  BEGIN
    SELECT RAISE(ABORT, 'events: the tie-break is final once results are published');
  END;
