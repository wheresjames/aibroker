ALTER TABLE public.plugins
    ADD COLUMN access_levels jsonb DEFAULT '{}'::jsonb NOT NULL;


CREATE TABLE public.policy_plugin_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    policy_id uuid NOT NULL,
    plugin_key text NOT NULL,
    instance_name text,
    mode text DEFAULT 'simple'::text NOT NULL,
    access_level text DEFAULT 'none'::text NOT NULL,
    risk_ceiling text,
    grants jsonb DEFAULT '{}'::jsonb NOT NULL,
    denied_tools jsonb DEFAULT '[]'::jsonb NOT NULL,
    constraints jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT policy_plugin_intents_pkey PRIMARY KEY (id),
    CONSTRAINT policy_plugin_intents_scope_key UNIQUE NULLS NOT DISTINCT (policy_id, plugin_key, instance_name),
    CONSTRAINT policy_plugin_intents_mode_check CHECK ((mode = ANY (ARRAY['simple'::text, 'advanced'::text]))),
    CONSTRAINT policy_plugin_intents_access_level_check CHECK ((access_level = ANY (ARRAY['none'::text, 'read'::text, 'contribute'::text, 'manage'::text, 'full'::text]))),
    CONSTRAINT policy_plugin_intents_risk_ceiling_check CHECK (((risk_ceiling IS NULL) OR (risk_ceiling = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text])))),
    CONSTRAINT policy_plugin_intents_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.policies(id) ON DELETE CASCADE,
    CONSTRAINT policy_plugin_intents_plugin_key_fkey FOREIGN KEY (plugin_key) REFERENCES public.plugins(key) ON DELETE RESTRICT
);


ALTER TABLE public.policy_permissions
    ADD COLUMN policy_intent_id uuid,
    ADD COLUMN instance_name text,
    ADD COLUMN risk_ceiling text,
    ADD CONSTRAINT policy_permissions_risk_ceiling_check CHECK (((risk_ceiling IS NULL) OR (risk_ceiling = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text])))),
    ADD CONSTRAINT policy_permissions_policy_intent_id_fkey FOREIGN KEY (policy_intent_id) REFERENCES public.policy_plugin_intents(id) ON DELETE CASCADE;


ALTER TABLE public.policy_permissions
    DROP CONSTRAINT policy_permissions_policy_id_tool_name_effect_key,
    ADD CONSTRAINT policy_permissions_policy_id_tool_name_effect_instance_key UNIQUE NULLS NOT DISTINCT (policy_id, tool_name, effect, instance_name);


CREATE INDEX policy_plugin_intents_lookup_idx
    ON public.policy_plugin_intents USING btree (policy_id, plugin_key, instance_name);
