-- ====================================
-- SUPABASE DATABASE + STORAGE SETUP 
-- ====================================

BEGIN;
-- ------------------------------------------------------------
-- 1. REQUIRED EXTENSION
-- ------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- ------------------------------------------------------------
-- 2. MAIN CARDS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.cards (
    id                  text PRIMARY KEY,
    name                text NOT NULL,
    tier                text,
    series              text,
    image_url           text,
    author              text,
    author_link         text,
    source_updated_at   timestamptz,
    synced_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cards_tier_idx
    ON public.cards (tier);

CREATE INDEX IF NOT EXISTS cards_series_idx
    ON public.cards (series);

CREATE INDEX IF NOT EXISTS cards_name_search_idx
    ON public.cards
    USING gin (
        to_tsvector(
            'simple',
            coalesce(name, '') || ' ' || coalesce(series, '')
        )
    );
-- ------------------------------------------------------------
-- 3. EVENT CARDS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.event_cards (
    id                  text PRIMARY KEY,
    name                text NOT NULL,
    tier                text,
    series              text,
    image_url           text,
    author              text,
    author_link         text,
    event_slug          text NOT NULL,
    source_updated_at   timestamptz,
    synced_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_cards_event_idx
    ON public.event_cards (event_slug);

CREATE INDEX IF NOT EXISTS event_cards_tier_idx
    ON public.event_cards (tier);

CREATE INDEX IF NOT EXISTS event_cards_series_idx
    ON public.event_cards (series);

CREATE INDEX IF NOT EXISTS event_cards_name_search_idx
    ON public.event_cards
    USING gin (
        to_tsvector(
            'simple',
            coalesce(name, '') || ' ' || coalesce(series, '')
        )
    );
-- ------------------------------------------------------------
-- 4. CATALOG STATE
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.catalog_state (
    catalog             text PRIMARY KEY
                        CHECK (catalog IN ('cards', 'events')),
    record_count        bigint NOT NULL DEFAULT 0,
    storage_path        text NOT NULL,
    last_checked_at     timestamptz,
    last_synced_at      timestamptz,
    last_error          text,
    status              text NOT NULL DEFAULT 'missing',
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO public.catalog_state (catalog, storage_path)
VALUES
    ('cards', 'cards.json'),
    ('events', 'events.json')
ON CONFLICT (catalog) DO NOTHING;

-- ------------------------------------------------------------
-- 5. SCRAPE / SYNC HISTORY
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.sync_runs (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    catalog             text NOT NULL,
    trigger             text NOT NULL,
    status              text NOT NULL DEFAULT 'running',
    started_at          timestamptz NOT NULL DEFAULT now(),
    finished_at         timestamptz,
    records_found       bigint,
    records_added       bigint,
    error               text,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS sync_runs_started_idx
    ON public.sync_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS sync_runs_catalog_status_idx
    ON public.sync_runs (catalog, status);

-- ------------------------------------------------------------
-- 6. SYSTEM LOGS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.system_logs (
    id                  text PRIMARY KEY,
    timestamp           timestamptz NOT NULL DEFAULT now(),
    level               text NOT NULL,
    component           text NOT NULL,
    message             text NOT NULL,
    details             jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS system_logs_timestamp_idx
    ON public.system_logs (timestamp DESC);

CREATE INDEX IF NOT EXISTS system_logs_level_timestamp_idx
    ON public.system_logs (level, timestamp DESC);

CREATE INDEX IF NOT EXISTS system_logs_component_timestamp_idx
    ON public.system_logs (component, timestamp DESC);

-- ------------------------------------------------------------
-- 7. API KEY METADATA
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.api_keys (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    label               text NOT NULL,
    key_hash            text NOT NULL UNIQUE,
    key_prefix          text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    last_used_at        timestamptz,
    disabled_at         timestamptz,
    metadata            jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Store hashes/prefixes only, never raw API secrets.

-- ------------------------------------------------------------
-- 8. ENABLE ROW LEVEL SECURITY
-- ------------------------------------------------------------

ALTER TABLE public.cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catalog_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------
-- 9. EXPLICIT TABLE PRIVILEGES (GRANTS)
-- ------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE public.cards,
               public.event_cards,
               public.catalog_state,
               public.sync_runs,
               public.system_logs,
               public.api_keys
    TO service_role;

-- ------------------------------------------------------------
-- 10. PRIVATE STORAGE BUCKET + STORAGE PERMISSIONS
-- ------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM storage.buckets
        WHERE id = 'shoob-catalogs'
    ) THEN
        INSERT INTO storage.buckets (id, name, public)
        VALUES ('shoob-catalogs', 'shoob-catalogs', false);

        RAISE NOTICE 'SUCCESS: Created private bucket shoob-catalogs.';
    ELSE
        UPDATE storage.buckets
        SET public = false
        WHERE id = 'shoob-catalogs';

        RAISE NOTICE 'INFO: Bucket shoob-catalogs already existed; kept private.';
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION
            'FAILED to create/configure Storage bucket shoob-catalogs. SQLSTATE: %, Error: %',
            SQLSTATE, SQLERRM;
END;
$$;

-- Explicit Storage object privileges for trusted server-side service_role.
-- Storage object access is also controlled by RLS policies. The service_role
-- key is intended for trusted server-side use and bypasses RLS.
GRANT USAGE ON SCHEMA storage TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE storage.objects
    TO service_role;
GRANT SELECT
    ON TABLE storage.buckets
    TO service_role;

-- No anon/authenticated Storage policies are created: the bucket remains
-- private to ordinary clients. Use the server-side service-role key to upload.

-- ------------------------------------------------------------
-- 11. VERIFY REQUIRED OBJECTS
-- ------------------------------------------------------------

DO $$
DECLARE
    missing_objects text;
BEGIN
    SELECT string_agg(required_object, ', ')
    INTO missing_objects
    FROM (
        VALUES
            ('public.cards'),
            ('public.event_cards'),
            ('public.catalog_state'),
            ('public.sync_runs'),
            ('public.system_logs'),
            ('public.api_keys')
    ) AS required(required_object)
    WHERE to_regclass(required_object) IS NULL;

    IF missing_objects IS NOT NULL THEN
        RAISE EXCEPTION
            'SETUP VERIFICATION FAILED. Missing tables: %', missing_objects;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM storage.buckets
        WHERE id = 'shoob-catalogs'
          AND public = false
    ) THEN
        RAISE EXCEPTION
            'SETUP VERIFICATION FAILED. Private bucket shoob-catalogs was not found.';
    END IF;

    RAISE NOTICE
        'SUCCESS: Required tables and private Storage bucket verified.';
END;
$$;

COMMIT;

-- ------------------------------------------------------------
-- 12. DISPLAY SETUP RESULTS
-- ------------------------------------------------------------

SELECT 'cards' AS object_name,
       to_regclass('public.cards') IS NOT NULL AS exists;

SELECT 'event_cards' AS object_name,
       to_regclass('public.event_cards') IS NOT NULL AS exists;

SELECT 'catalog_state' AS object_name,
       to_regclass('public.catalog_state') IS NOT NULL AS exists;

SELECT 'sync_runs' AS object_name,
       to_regclass('public.sync_runs') IS NOT NULL AS exists;

SELECT 'system_logs' AS object_name,
       to_regclass('public.system_logs') IS NOT NULL AS exists;

SELECT 'api_keys' AS object_name,
       to_regclass('public.api_keys') IS NOT NULL AS exists;

SELECT id AS bucket_id,
       name AS bucket_name,
       public AS is_public
FROM storage.buckets
WHERE id = 'shoob-catalogs';

SELECT catalog, record_count, storage_path, status
FROM public.catalog_state
ORDER BY catalog;

-- If execution reaches these result queries, the setup transaction committed.
