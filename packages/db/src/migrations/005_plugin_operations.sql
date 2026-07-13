ALTER TABLE public.server_plugins DROP CONSTRAINT server_plugins_status_check;
ALTER TABLE public.server_plugins
    ADD COLUMN removed_at timestamp with time zone,
    ADD CONSTRAINT server_plugins_status_check CHECK ((status = ANY (ARRAY['enabled'::text, 'disabled'::text, 'removed'::text])));


CREATE TABLE public.postgres_provisioning (
    server_plugin_id uuid PRIMARY KEY REFERENCES public.server_plugins(id) ON DELETE CASCADE,
    status text DEFAULT 'pending' NOT NULL,
    scoped_role text,
    allowed_schemas jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_error text,
    provisioned_at timestamp with time zone,
    deprovisioned_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT postgres_provisioning_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'provisioning'::text, 'provisioned'::text, 'failed'::text, 'deprovisioned'::text])))
);


CREATE TABLE public.postgres_connectors (
    server_plugin_id uuid PRIMARY KEY REFERENCES public.server_plugins(id) ON DELETE CASCADE,
    credential_id uuid REFERENCES public.server_credentials(id) ON DELETE SET NULL,
    host text NOT NULL,
    port integer DEFAULT 5432 NOT NULL,
    database_name text NOT NULL,
    scoped_role text NOT NULL,
    connection_status text DEFAULT 'unknown' NOT NULL,
    last_tested_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT postgres_connectors_port_check CHECK (port BETWEEN 1 AND 65535),
    CONSTRAINT postgres_connectors_status_check CHECK ((connection_status = ANY (ARRAY['unknown'::text, 'available'::text, 'unavailable'::text])))
);


CREATE TABLE public.sandbox_targets (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    plugin_key text NOT NULL REFERENCES public.plugins(key) ON DELETE RESTRICT,
    name text NOT NULL,
    status text DEFAULT 'running' NOT NULL,
    connection_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    encrypted_secrets jsonb,
    registered_server_id uuid REFERENCES public.servers(id) ON DELETE SET NULL,
    created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    torn_down_at timestamp with time zone,
    CONSTRAINT sandbox_targets_status_check CHECK ((status = ANY (ARRAY['running'::text, 'stopped'::text, 'removed'::text])))
);


CREATE INDEX sandbox_targets_status_created_idx ON public.sandbox_targets USING btree (status, created_at DESC);
