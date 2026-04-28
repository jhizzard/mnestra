-- Mnestra v0.3.2 — explicit GRANTs to make installs deterministic
--
-- Prior migrations relied on Supabase's auto-grant default, which
-- auto-grants public-schema privileges to service_role / authenticated /
-- anon when (a) the creating role is `postgres` AND (b) the project's
-- default privileges in schema public haven't been tightened. On any
-- Supabase project where one of those preconditions failed, every
-- Mnestra install landed in the same broken state:
--
--   memory_remember(...)  → "Memory skipped: ..."   (silent — see remember.ts)
--   memory_status         → Total active memories: 0
--   memory_recall(...)    → "Search error: permission denied for table memory_items"
--
-- Root cause: `service_role` had no SELECT/INSERT/UPDATE/DELETE on
-- memory_items, memory_sessions, memory_relationships, and no EXECUTE
-- on match_memories / memory_hybrid_search / expand_memory_neighborhood.
-- PostgREST checks table-level privileges before evaluating RLS, so
-- service_role's bypassrls attribute does not help.
--
-- Reported and root-caused by Brad Heath 2026-04-28 against project
-- ref rrzkceirgciiqgeefvbe; fix verified end-to-end on his install
-- before being upstreamed here.
--
-- This migration is idempotent and safe on greenfield projects where
-- the auto-grant default already fired (the GRANTs become no-ops).

-- ── Tables: service_role is Mnestra's only direct connection role.

grant select, insert, update, delete on all tables in schema public
  to service_role;

-- ── Functions / RPCs: convention from migrations 006 and 010 is to
--    grant execute to all three Supabase roles. Apply schema-wide so
--    future RPCs inherit without another migration.

grant execute on all functions in schema public
  to service_role, authenticated, anon;

-- ── Default privileges: any future tables/functions created in
--    schema public automatically inherit the same grants.

alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;

alter default privileges in schema public
  grant execute on functions to service_role, authenticated, anon;
