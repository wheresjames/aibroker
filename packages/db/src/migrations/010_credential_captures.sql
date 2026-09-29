-- Logins in progress (AB-ELEMENTOR D6/D7): a WordPress login paused at its second factor,
-- or a live remote-browser login the user is driving from the UI. Rows are short-lived;
-- the encrypted payload (pending 2FA state) is wiped when the capture finishes.
CREATE TABLE public.credential_captures (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    server_plugin_id uuid NOT NULL REFERENCES public.server_plugins(id) ON DELETE CASCADE,
    owner_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    encrypted_payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT credential_captures_kind_check CHECK ((kind = ANY (ARRAY['wordpress_two_factor'::text, 'wordpress_browser'::text, 'playwright_browser'::text]))),
    CONSTRAINT credential_captures_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'cancelled'::text, 'expired'::text, 'failed'::text])))
);

CREATE INDEX credential_captures_owner_idx ON public.credential_captures (owner_user_id, status, created_at DESC);
