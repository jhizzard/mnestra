-- Sprint 41 T2 — chopin-nashville re-taxonomy.
--
-- Why this exists:
--   Sprint 39 T3 migration 011_project_tag_backfill.sql moved 192 rows out of
--   the chopin-nashville bucket (1,139 → 947) using a conservative 5-bucket
--   keyword pass. 947 rows still remain mis-tagged. Sprint 41 widens the
--   keyword sets per the new project taxonomy (T1 owns the canonical doc at
--   docs/PROJECT-TAXONOMY.md) and adds three buckets that 011 did not have:
--     - chopin-in-bohemia (festival, distinct from the Nashville competition)
--     - chopin-scheduler  (the SchedulingApp / "Maestro" project — single
--                          project under two names per orchestrator
--                          mid-inject clarification 2026-04-28 12:51 ET)
--     - claimguard        (Gorgias-ticket-monitor / ClaimGuard-AI work)
--
--   The remaining residue after this migration is what Sprint 41 T4 hands to
--   the LLM-classification runner. Conservative wins: rows with no clear
--   keyword signal STAY chopin-nashville for T4 to handle.
--
-- What this migration does NOT do:
--   - Does NOT touch mnestra_session_memory / mnestra_project_memory / etc.
--     (legacy rag-events tables; different write path; Sprint 42+ cleanup).
--   - Does NOT consolidate duplicate tags like 'gorgias' vs
--     'gorgias-ticket-monitor', 'pvb' vs 'PVB', or 'mnestra' vs 'engram'.
--     Visible in `SELECT project, count(*) FROM memory_items GROUP BY
--     project` but a separate cleanup pass.
--   - Does NOT re-tag rows whose only signal is the legitimate
--     chopin-nashville vocabulary (competition / performance / jury /
--     sponsor / applicant / repertoire / Acceptd / NICPC / laureate). Those
--     are the rows the chopin-nashville tag SHOULD claim.
--   - Does NOT touch source_session_id → transcript_path → cwd resolution.
--     The briefing scoped that as a possible additional signal, not
--     required. Keyword bucketing + T4's LLM pass hits the < 100 target.
--
-- Heuristic — content keyword bucketing:
--   The migration runs UPDATEs sequentially. Earlier buckets claim ambiguous
--   multi-project rows first; later buckets only see rows that no earlier
--   bucket has already re-tagged. Order is broadest-first (largest expected
--   bucket size first):
--
--     1. termdeck            — termdeck, mnestra, "4+1 sprint", xterm,
--                              node-pty, flashback, memory_items,
--                              memory_relationships
--     2. rumen               — rumen, rumen-tick, "insight synthesis"
--     3. podium              — podium
--     4. chopin-in-bohemia   — bohemia, "chopin in bohemia", "2026 festival"
--     5. chopin-scheduler    — scheduling, schedulingapp, \mMaestro\M
--                              (Maestro is the working name; chopin-scheduler
--                              is the canonical tag — alias confirmed 2026-04-28
--                              by Joshua; case-sensitive word-boundary token
--                              avoids matching unrelated "[maestro]" log
--                              prefixes)
--     6. pvb                 — PVB, petvetbid, "pet vet bid"
--     7. claimguard          — claimguard, gorgias-ticket-monitor,
--                              "gorgias ticket monitor"
--     8. dor                 — \mDOR\M, /DOR/, ~/Documents/DOR, dor.config,
--                              "Rust LLM gateway", openclaw
--                              (reused verbatim from 011's tightened
--                              pattern; word-boundary uppercase rules out
--                              "dormant", "vendored", "indoor", etc.)
--
-- Idempotence:
--   Every UPDATE is gated by `WHERE project = 'chopin-nashville'`. After the
--   first run, those rows have a different project tag, so re-running this
--   migration is a no-op (zero rows updated per bucket). RAISE NOTICE on a
--   re-run will print zeros, which is the expected idempotent signal.
--
-- Application:
--   THIS MIGRATION IS NOT EXECUTED BY THE LANE THAT WROTE IT. Orchestrator
--   reviews the RAISE NOTICE counts after applying. Apply via the bundled
--   migration runner at packages/server/src/setup/migration-runner.js (which
--   uses node-postgres client.query — psql metacommands like \gset are NOT
--   available, so the count probes use GET DIAGNOSTICS ROW_COUNT inside DO
--   blocks). Manual fallback:
--     `psql "$DATABASE_URL" -f 012_project_tag_re_taxonomy.sql`.

BEGIN;

-- ============================================================
-- AUDIT BEFORE
-- ============================================================
DO $$
DECLARE
  before_chopin       int;
  before_termdeck     int;
  before_rumen        int;
  before_podium       int;
  before_bohemia      int;
  before_scheduler    int;
  before_pvb          int;
  before_claimguard   int;
  before_dor          int;
BEGIN
  SELECT count(*) INTO before_chopin     FROM memory_items WHERE project = 'chopin-nashville';
  SELECT count(*) INTO before_termdeck   FROM memory_items WHERE project = 'termdeck';
  SELECT count(*) INTO before_rumen      FROM memory_items WHERE project = 'rumen';
  SELECT count(*) INTO before_podium     FROM memory_items WHERE project = 'podium';
  SELECT count(*) INTO before_bohemia    FROM memory_items WHERE project = 'chopin-in-bohemia';
  SELECT count(*) INTO before_scheduler  FROM memory_items WHERE project = 'chopin-scheduler';
  SELECT count(*) INTO before_pvb        FROM memory_items WHERE project = 'pvb';
  SELECT count(*) INTO before_claimguard FROM memory_items WHERE project = 'claimguard';
  SELECT count(*) INTO before_dor        FROM memory_items WHERE project = 'dor';
  RAISE NOTICE '[012-retaxonomy] BEFORE  chopin-nashville=% termdeck=% rumen=% podium=% chopin-in-bohemia=% chopin-scheduler=% pvb=% claimguard=% dor=%',
    before_chopin, before_termdeck, before_rumen, before_podium, before_bohemia, before_scheduler, before_pvb, before_claimguard, before_dor;
END $$;

-- ============================================================
-- BUCKET 1 — termdeck (broadest first; claims ambiguous multi-project rows)
--
-- Widened from 011's 3-keyword set [termdeck | mnestra | "4+1 sprint"] to
-- include TermDeck-internal vocabulary that almost never appears outside the
-- TermDeck stack (xterm, node-pty), the Flashback subsystem name, and the
-- memory_* table identifiers (which are spoken about in TermDeck/Mnestra
-- context overwhelmingly — graph-routes, mnestra-bridge, the migrations
-- themselves).
-- ============================================================
DO $$
DECLARE
  rows_updated int;
BEGIN
  UPDATE memory_items SET project = 'termdeck'
   WHERE project = 'chopin-nashville'
     AND (
       content ILIKE '%termdeck%'
       OR content ILIKE '%mnestra%'
       OR content ILIKE '%4+1 sprint%'
       OR content ILIKE '%xterm%'
       OR content ILIKE '%node-pty%'
       OR content ILIKE '%flashback%'
       OR content ILIKE '%memory_items%'
       OR content ILIKE '%memory_relationships%'
     );
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE '[012-retaxonomy] bucket 1 (termdeck): % rows re-tagged', rows_updated;
END $$;

-- ============================================================
-- BUCKET 2 — rumen
--
-- 011 used [rumen] alone. 012 widens to include rumen-tick (the Rumen
-- cron-tick subsystem) and "insight synthesis" (Rumen's product vocabulary).
-- ============================================================
DO $$
DECLARE
  rows_updated int;
BEGIN
  UPDATE memory_items SET project = 'rumen'
   WHERE project = 'chopin-nashville'
     AND (
       content ILIKE '%rumen%'
       OR content ILIKE '%rumen-tick%'
       OR content ILIKE '%insight synthesis%'
     );
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE '[012-retaxonomy] bucket 2 (rumen): % rows re-tagged', rows_updated;
END $$;

-- ============================================================
-- BUCKET 3 — podium
--
-- Same single-keyword pattern as 011. Podium-specific vocabulary doesn't
-- have synonyms that justify widening. (The Chopin in Bohemia festival
-- mentions Podium often, but bucket 1's broadest-first ordering means
-- podium-AND-bohemia rows where podium is the dominant tag claim it here;
-- bohemia-only rows fall to bucket 4.)
-- ============================================================
DO $$
DECLARE
  rows_updated int;
BEGIN
  UPDATE memory_items SET project = 'podium'
   WHERE project = 'chopin-nashville'
     AND content ILIKE '%podium%';
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE '[012-retaxonomy] bucket 3 (podium): % rows re-tagged', rows_updated;
END $$;

-- ============================================================
-- BUCKET 4 — chopin-in-bohemia (NEW in 012)
--
-- The 2026 festival is a distinct project from the Chopin Nashville
-- competition. Keywords: bohemia (substring; festival-specific), "chopin in
-- bohemia" (full phrase, near-zero false positives), "2026 festival" (date+
-- project disambiguator).
--
-- Note: rows that mention "Chopin Nashville" AND "Bohemia" together (rare —
-- maybe cross-project planning notes) will already have been claimed by
-- earlier buckets if they also mention TermDeck/Rumen/Podium tooling.
-- Otherwise they land here, which is the right call: the "current festival
-- being planned" is Bohemia 2026.
-- ============================================================
DO $$
DECLARE
  rows_updated int;
BEGIN
  UPDATE memory_items SET project = 'chopin-in-bohemia'
   WHERE project = 'chopin-nashville'
     AND (
       content ILIKE '%bohemia%'
       OR content ILIKE '%chopin in bohemia%'
       OR content ILIKE '%2026 festival%'
     );
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE '[012-retaxonomy] bucket 4 (chopin-in-bohemia): % rows re-tagged', rows_updated;
END $$;

-- ============================================================
-- BUCKET 5 — chopin-scheduler (NEW in 012; absorbs Maestro alias)
--
-- Per orchestrator clarification 2026-04-28 12:51 ET: "Maestro" is the
-- working/branding name for the chopin-scheduler project. Same project,
-- two names. The on-disk path is SchedulingApp/, so the keywords cover both
-- the path-style identifier (scheduling, schedulingapp) and the branding
-- alias (\mMaestro\M — POSIX word-boundary, case-sensitive Capitalized
-- token).
--
-- The case-sensitive Maestro pattern matters: lowercase "maestro" can
-- appear in unrelated content (log prefixes like "[maestro]" if any tool
-- ever named itself that, generic music vocabulary). Capitalized Maestro
-- with word boundaries is much closer to "the project name" intent.
-- ============================================================
DO $$
DECLARE
  rows_updated int;
BEGIN
  UPDATE memory_items SET project = 'chopin-scheduler'
   WHERE project = 'chopin-nashville'
     AND (
       content ILIKE '%scheduling%'
       OR content ILIKE '%schedulingapp%'
       OR content ~ '\mMaestro\M'
     );
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE '[012-retaxonomy] bucket 5 (chopin-scheduler): % rows re-tagged', rows_updated;
END $$;

-- ============================================================
-- BUCKET 6 — pvb (case-insensitive PVB / petvetbid markers)
--
-- Same pattern as 011 bucket 4. PVB is small in the chopin-nashville bucket
-- (Sprint 39 dry-run found 7 rows; live apply landed 3 because bucket 1
-- claimed mnestra-AND-PVB rows first). 012's earlier expansion of bucket 1
-- means this stays small or zero.
-- ============================================================
DO $$
DECLARE
  rows_updated int;
BEGIN
  UPDATE memory_items SET project = 'pvb'
   WHERE project = 'chopin-nashville'
     AND (
       content ILIKE '%PVB%'
       OR content ILIKE '%petvetbid%'
       OR content ILIKE '%pet vet bid%'
     );
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE '[012-retaxonomy] bucket 6 (pvb): % rows re-tagged', rows_updated;
END $$;

-- ============================================================
-- BUCKET 7 — claimguard (NEW in 012)
--
-- ClaimGuard-AI is the active Unagi project (Joshua's roadmap shows it as
-- the next 1-2 sprints after Sprint 41 ships). On-disk path is
-- ~/Documents/Unagi/gorgias-ticket-monitor/. Keywords:
--   - claimguard (substring; product name, near-zero false positives)
--   - gorgias-ticket-monitor (the on-disk dir name; near-zero FP)
--   - "gorgias ticket monitor" (the spoken-form variant)
--
-- The bare "gorgias" keyword is intentionally NOT used here because the
-- pre-existing `gorgias` tag (468 rows) and `gorgias-ticket-monitor` tag
-- (207 rows) are separate categories — bare "gorgias" content could be
-- about Gorgias-the-helpdesk-product unrelated to ClaimGuard. The
-- compound-token discipline keeps the bucket precise.
-- ============================================================
DO $$
DECLARE
  rows_updated int;
BEGIN
  UPDATE memory_items SET project = 'claimguard'
   WHERE project = 'chopin-nashville'
     AND (
       content ILIKE '%claimguard%'
       OR content ILIKE '%gorgias-ticket-monitor%'
       OR content ILIKE '%gorgias ticket monitor%'
     );
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE '[012-retaxonomy] bucket 7 (claimguard): % rows re-tagged', rows_updated;
END $$;

-- ============================================================
-- BUCKET 8 — dor (REUSED VERBATIM from 011's tightened pattern)
--
-- 011's audit found that the original briefing's `%dor%` ILIKE pattern
-- produced ~33% false positives (matched "dormant", "vendored", "indoor",
-- etc.). 011 tightened to:
--   - POSIX word boundary `\mDOR\M` — case-sensitive uppercase only
--   - path/identifier markers: /DOR/, ~/Documents/DOR, dor.config,
--     "Rust LLM gateway" (DOR's tagline)
--   - openclaw substring (OpenClaw is the slack-channel automation product
--     that lives next to DOR in Joshua's stack)
--
-- 012 reuses this verbatim. After 011 caught 3 dor rows live, residue is
-- expected to be near-zero — but the bucket stays in case any new rows
-- accumulated post-Sprint-39 carry the markers.
-- ============================================================
DO $$
DECLARE
  rows_updated int;
BEGIN
  UPDATE memory_items SET project = 'dor'
   WHERE project = 'chopin-nashville'
     AND (
       content ~ '\mDOR\M'
       OR content ILIKE '%/DOR/%'
       OR content ILIKE '%~/Documents/DOR%'
       OR content ILIKE '%dor.config%'
       OR content ILIKE '%Rust LLM gateway%'
       OR content ILIKE '%openclaw%'
     );
  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RAISE NOTICE '[012-retaxonomy] bucket 8 (dor): % rows re-tagged', rows_updated;
END $$;

-- ============================================================
-- AUDIT AFTER
-- ============================================================
DO $$
DECLARE
  after_chopin       int;
  after_termdeck     int;
  after_rumen        int;
  after_podium       int;
  after_bohemia      int;
  after_scheduler    int;
  after_pvb          int;
  after_claimguard   int;
  after_dor          int;
BEGIN
  SELECT count(*) INTO after_chopin     FROM memory_items WHERE project = 'chopin-nashville';
  SELECT count(*) INTO after_termdeck   FROM memory_items WHERE project = 'termdeck';
  SELECT count(*) INTO after_rumen      FROM memory_items WHERE project = 'rumen';
  SELECT count(*) INTO after_podium     FROM memory_items WHERE project = 'podium';
  SELECT count(*) INTO after_bohemia    FROM memory_items WHERE project = 'chopin-in-bohemia';
  SELECT count(*) INTO after_scheduler  FROM memory_items WHERE project = 'chopin-scheduler';
  SELECT count(*) INTO after_pvb        FROM memory_items WHERE project = 'pvb';
  SELECT count(*) INTO after_claimguard FROM memory_items WHERE project = 'claimguard';
  SELECT count(*) INTO after_dor        FROM memory_items WHERE project = 'dor';
  RAISE NOTICE '[012-retaxonomy] AFTER   chopin-nashville=% termdeck=% rumen=% podium=% chopin-in-bohemia=% chopin-scheduler=% pvb=% claimguard=% dor=%',
    after_chopin, after_termdeck, after_rumen, after_podium, after_bohemia, after_scheduler, after_pvb, after_claimguard, after_dor;
  RAISE NOTICE '[012-retaxonomy] Sprint 41 acceptance target: chopin-nashville drops 947 -> < 100 after T2+T4. T2 (this migration) handles deterministic keyword cases; T4 LLM-classifies the residue. If chopin-nashville count after this migration is still > 200, T4 has more rows to chew through; if < 100 already, T4 may have very little to do.';
END $$;

COMMIT;

-- ============================================================
-- POST-APPLY: optional verification queries (NOT part of the migration).
-- Run separately to confirm the new taxonomy holds and to spot-check
-- false-positive rates per bucket.
-- ============================================================
--
-- 1. Tag distribution after migration:
--    SELECT project, count(*) FROM memory_items
--     GROUP BY project ORDER BY count(*) DESC LIMIT 20;
--
-- 2. Confirm no chopin-nashville rows match obvious termdeck/rumen/podium
--    keywords (these should all return 0 if the migration succeeded):
--    SELECT count(*) FROM memory_items
--     WHERE project='chopin-nashville'
--       AND (content ILIKE '%termdeck%' OR content ILIKE '%rumen%'
--            OR content ILIKE '%podium%' OR content ILIKE '%bohemia%'
--            OR content ILIKE '%scheduling%' OR content ILIKE '%claimguard%');
--    -- Expected: 0
--
-- 3. Spot-check false-positive rate per bucket (replace 'termdeck' with
--    each new tag in turn):
--    SELECT id, left(content, 200) AS preview
--    FROM memory_items
--    WHERE project='termdeck' AND id IN (
--      SELECT id FROM memory_items
--      WHERE project='termdeck'
--      ORDER BY updated_at DESC LIMIT 10
--    );
--
-- 4. Confirm the legitimate-chopin-nashville signal is preserved (rows
--    matching competition/laureate/applicant/Acceptd/NICPC/Bohemia/
--    repertoire keywords should still be tagged chopin-nashville,
--    EXCEPT for those that ALSO matched a code-project keyword and got
--    legitimately re-tagged):
--    SELECT count(*) FROM memory_items
--     WHERE project='chopin-nashville'
--       AND (content ILIKE '%competition%' OR content ILIKE '%laureate%'
--            OR content ILIKE '%applicant%' OR content ILIKE '%Acceptd%'
--            OR content ILIKE '%NICPC%' OR content ILIKE '%repertoire%'
--            OR content ILIKE '%jury%');
--    -- Expected: most of the residue (~71+ rows from Sprint 39 baseline,
--    -- possibly higher as more legitimate competition content has
--    -- accumulated since 2026-04-27).
