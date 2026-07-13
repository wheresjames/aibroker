CREATE TABLE public.leased_sessions (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    resource_kind text NOT NULL CHECK (resource_kind IN ('browser')),
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE RESTRICT,
    server_plugin_id uuid NOT NULL REFERENCES public.server_plugins(id) ON DELETE RESTRICT,
    actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    actor_token_id uuid REFERENCES public.api_tokens(id) ON DELETE SET NULL,
    worker_lease_id uuid NOT NULL UNIQUE,
    lease_slot smallint NOT NULL CHECK (lease_slot BETWEEN 1 AND 2),
    status text NOT NULL DEFAULT 'opening'
      CHECK (status IN ('opening','active','closing','closed','expired','failed')),
    current_url text,
    viewport jsonb NOT NULL DEFAULT '{}'::jsonb,
    event_cursors jsonb NOT NULL DEFAULT '{"console":0,"errors":0}'::jsonb,
    event_counts jsonb NOT NULL DEFAULT '{"console":0,"errors":0,"dropped":0,"artifacts":0}'::jsonb,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_activity_at timestamptz NOT NULL DEFAULT now(),
    idle_expires_at timestamptz NOT NULL,
    absolute_expires_at timestamptz NOT NULL,
    closed_at timestamptz,
    close_code text,
    error_code text,
    error_message text CHECK (length(error_message) <= 500),
    CHECK (idle_expires_at <= absolute_expires_at),
    CHECK ((status IN ('closed','expired','failed')) = (closed_at IS NOT NULL))
);

CREATE UNIQUE INDEX leased_sessions_actor_token_active_idx
  ON public.leased_sessions(actor_token_id)
  WHERE status IN ('opening','active','closing') AND actor_token_id IS NOT NULL;
CREATE UNIQUE INDEX leased_sessions_plugin_slot_active_idx
  ON public.leased_sessions(server_plugin_id,lease_slot)
  WHERE status IN ('opening','active','closing');
CREATE INDEX leased_sessions_actor_history_idx
  ON public.leased_sessions(actor_user_id,actor_token_id,created_at DESC);
CREATE INDEX leased_sessions_plugin_history_idx
  ON public.leased_sessions(server_plugin_id,created_at DESC);
CREATE INDEX leased_sessions_expiry_idx
  ON public.leased_sessions(LEAST(idle_expires_at,absolute_expires_at))
  WHERE status IN ('opening','active','closing');
CREATE INDEX leased_sessions_worker_idx
  ON public.leased_sessions(worker_lease_id,status);

ALTER TABLE public.browser_artifacts
  ADD CONSTRAINT browser_artifacts_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES public.leased_sessions(id) ON DELETE SET NULL;
