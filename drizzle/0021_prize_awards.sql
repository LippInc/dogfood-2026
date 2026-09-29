-- Prize awards (DATA-MODEL.md, JUDGING.md "Prizes"): the prizes an event gives to projects live in the event's
-- settings (settings.prizeAwards). They are decided before publishing and final with it: once the results are
-- published the database refuses a change to them, and, when the event gave at least one prize, any addition, edit
-- or removal of its prizes, since an award names its prize by id. An event that gave no prize keeps its prizes as
-- before. The text is src/server/db/triggers.ts's, which the boot re-asserts.
CREATE TRIGGER IF NOT EXISTS events_prize_awards_final
  BEFORE UPDATE OF settings ON events
  WHEN OLD.results_published_at IS NOT NULL
    AND json_extract(NEW.settings, '$.prizeAwards') IS NOT json_extract(OLD.settings, '$.prizeAwards')
  BEGIN
    SELECT RAISE(ABORT, 'events: the results are published, so the prize awards are final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS prizes_final_insert
  BEFORE INSERT ON prizes
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.results_published_at IS NOT NULL AND json_array_length(e.settings, '$.prizeAwards') > 0)
    AND NOT EXISTS (SELECT 1 FROM prizes x WHERE x.id = NEW.id)
  BEGIN
    SELECT RAISE(ABORT, 'prizes: the results are published, so the awarded prizes are final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS prizes_final_update
  BEFORE UPDATE ON prizes
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL AND json_array_length(e.settings, '$.prizeAwards') > 0)
  BEGIN
    SELECT RAISE(ABORT, 'prizes: the results are published, so the awarded prizes are final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS prizes_final_delete
  BEFORE DELETE ON prizes
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL AND json_array_length(e.settings, '$.prizeAwards') > 0)
  BEGIN
    SELECT RAISE(ABORT, 'prizes: the results are published, so the awarded prizes are final');
  END;
