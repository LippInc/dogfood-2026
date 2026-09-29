-- The community vote and the comments, final where the app never changes them (DATA-MODEL.md, "Community vote and
-- comments"): a pick is never changed in place; once an event's voting has closed (its close time has passed) or its
-- results are published, no pick goes on or comes off; a comment's words, author, project and time never change; and
-- a hidden comment cannot be deleted until the organizers unhide it. The text is src/server/db/triggers.ts's, which
-- the boot re-asserts.
CREATE TRIGGER IF NOT EXISTS votes_no_update
  BEFORE UPDATE ON votes
  BEGIN
    SELECT RAISE(ABORT, 'votes: a pick is never changed in place');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS votes_closed_insert
  BEFORE INSERT ON votes
  WHEN EXISTS (
    SELECT 1 FROM voters v JOIN events e ON e.id = v.event_id
    WHERE v.id = NEW.voter_id
      AND (e.results_published_at IS NOT NULL
        OR (e.voting_close_at IS NOT NULL AND julianday(e.voting_close_at) <= julianday('now')))
  )
  BEGIN
    SELECT RAISE(ABORT, 'votes: voting has closed, so the ballots are final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS votes_closed_delete
  BEFORE DELETE ON votes
  WHEN EXISTS (
    SELECT 1 FROM voters v JOIN events e ON e.id = v.event_id
    WHERE v.id = OLD.voter_id
      AND (e.results_published_at IS NOT NULL
        OR (e.voting_close_at IS NOT NULL AND julianday(e.voting_close_at) <= julianday('now')))
  )
  BEGIN
    SELECT RAISE(ABORT, 'votes: voting has closed, so the ballots are final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS comments_words_final
  BEFORE UPDATE OF body, event_id, project_id, user_id, created_at ON comments
  WHEN NEW.body IS NOT OLD.body OR NEW.event_id IS NOT OLD.event_id OR NEW.project_id IS NOT OLD.project_id
    OR NEW.user_id IS NOT OLD.user_id OR NEW.created_at IS NOT OLD.created_at
  BEGIN
    SELECT RAISE(ABORT, 'comments: a comment''s words, author, project and time never change');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS comments_hidden_stays
  BEFORE DELETE ON comments
  WHEN OLD.hidden_at IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'comments: a hidden comment stays until the organizers unhide it');
  END;
