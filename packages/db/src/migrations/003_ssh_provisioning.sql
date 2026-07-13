CREATE TABLE public.ssh_provisioning (
    server_plugin_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    profile jsonb DEFAULT '{}'::jsonb NOT NULL,
    public_key text,
    last_error text,
    provisioned_at timestamp with time zone,
    deprovisioned_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ssh_provisioning_pkey PRIMARY KEY (server_plugin_id),
    CONSTRAINT ssh_provisioning_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'provisioning'::text, 'provisioned'::text, 'failed'::text, 'deprovisioned'::text])))
);


ALTER TABLE public.ssh_provisioning
    ADD CONSTRAINT ssh_provisioning_server_plugin_id_fkey FOREIGN KEY (server_plugin_id) REFERENCES public.server_plugins(id) ON DELETE CASCADE;


ALTER TABLE public.ssh_connectors
    ADD COLUMN server_plugin_id uuid,
    ADD CONSTRAINT ssh_connectors_server_plugin_id_fkey FOREIGN KEY (server_plugin_id) REFERENCES public.server_plugins(id) ON DELETE CASCADE,
    ADD CONSTRAINT ssh_connectors_server_plugin_id_key UNIQUE (server_plugin_id);


ALTER TABLE public.host_sessions
    ADD COLUMN server_plugin_id uuid,
    ADD CONSTRAINT host_sessions_server_plugin_id_fkey FOREIGN KEY (server_plugin_id) REFERENCES public.server_plugins(id) ON DELETE SET NULL;


ALTER TABLE public.host_operations
    ADD COLUMN server_plugin_id uuid,
    ADD CONSTRAINT host_operations_server_plugin_id_fkey FOREIGN KEY (server_plugin_id) REFERENCES public.server_plugins(id) ON DELETE SET NULL;


CREATE INDEX ssh_provisioning_status_idx ON public.ssh_provisioning USING btree (status, updated_at DESC);
CREATE INDEX host_sessions_server_plugin_started_idx ON public.host_sessions USING btree (server_plugin_id, started_at DESC);
