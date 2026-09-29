-- Per-user WordPress login sessions (AB-ELEMENTOR D1). Existing credential kinds are
-- shared by everyone using the server plugin and keep owner_user_id null; a
-- wordpress_session belongs to exactly one AIBroker user, so tools act as the caller.
ALTER TABLE public.server_credentials
    ADD COLUMN owner_user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
    ADD COLUMN metadata jsonb DEFAULT '{}'::jsonb NOT NULL;

ALTER TABLE public.server_credentials
    ADD CONSTRAINT server_credentials_session_owner_check
    CHECK ((kind = 'wordpress_session') = (owner_user_id IS NOT NULL));

CREATE UNIQUE INDEX server_credentials_one_active_session_idx
    ON public.server_credentials (server_plugin_id, owner_user_id)
    WHERE kind = 'wordpress_session' AND status = 'active';

-- Page-builder layouts written through REST meta get no WordPress revision, so the
-- broker keeps its own bounded pre-write snapshots for rollback (AB-ELEMENTOR 5.5).
CREATE TABLE public.page_builder_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    server_plugin_id uuid NOT NULL REFERENCES public.server_plugins(id) ON DELETE CASCADE,
    builder text NOT NULL,
    post_id bigint NOT NULL,
    actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    tool_name text NOT NULL,
    content_hash text NOT NULL,
    data text NOT NULL,
    byte_size integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX page_builder_snapshots_post_idx
    ON public.page_builder_snapshots (server_plugin_id, builder, post_id, created_at DESC);
