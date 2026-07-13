CREATE TABLE public.browser_artifacts (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE RESTRICT,
    server_plugin_id uuid NOT NULL REFERENCES public.server_plugins(id) ON DELETE RESTRICT,
    operation_id uuid,
    session_id uuid,
    actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    actor_token_id uuid REFERENCES public.api_tokens(id) ON DELETE SET NULL,
    artifact_type text NOT NULL,
    mime_type text NOT NULL,
    byte_size bigint NOT NULL CHECK (byte_size >= 0),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    storage_backend text NOT NULL CHECK (storage_backend IN ('filesystem','s3')),
    storage_key text NOT NULL UNIQUE,
    redaction_status text NOT NULL DEFAULT 'not_applicable'
      CHECK (redaction_status IN ('not_applicable','redacted','unredacted')),
    status text NOT NULL DEFAULT 'available'
      CHECK (status IN ('available','deleting','deleted','failed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    deleted_at timestamptz,
    cleanup_error text
);

CREATE INDEX browser_artifacts_actor_idx ON public.browser_artifacts(actor_user_id, actor_token_id, created_at DESC);
CREATE INDEX browser_artifacts_plugin_idx ON public.browser_artifacts(server_plugin_id, created_at DESC);
CREATE INDEX browser_artifacts_expiry_idx ON public.browser_artifacts(expires_at) WHERE status IN ('available','failed');
CREATE INDEX browser_artifacts_active_storage_idx ON public.browser_artifacts(storage_key) WHERE status IN ('available','deleting','failed');
