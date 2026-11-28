-- Hand-written; never regenerate. Prisma's schema has no notion of row-level security, so `migrate dev`
-- neither creates nor diffs it.
--
-- Supabase publishes the `public` schema through its Data API (PostgREST), and its default privileges give
-- the API roles `anon` and `authenticated` full access to every new table there (checked on the hosted
-- project, 2026-11-28). Row-level security with no policy denies those roles every row, and the REVOKEs
-- remove the grants themselves. The app and the Prisma CLI connect as the tables' owner (`postgres` on
-- Supabase, which also has BYPASSRLS; `app` locally), and RLS without FORCE doesn't apply to an owner, so the
-- app is unaffected. Local and CI Postgres have no API roles: there only the RLS part runs.
--
-- Every later migration that adds a table must enable RLS on it; `rls.test.ts` fails otherwise.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated',
      current_user);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated',
      current_user);
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated',
      current_user);
  END IF;
END $$;
