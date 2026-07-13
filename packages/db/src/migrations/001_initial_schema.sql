--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: assert_owner_is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_owner_is_admin() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  owner_role text;
begin
  if new.owner_user_id is null then
    return new;
  end if;
  select role into owner_role from users where id = new.owner_user_id;
  if owner_role is null then
    raise exception 'owner_user_id % does not reference an existing user', new.owner_user_id
      using errcode = 'foreign_key_violation';
  end if;
  if owner_role not in ('team_admin', 'global_admin') then
    raise exception 'owner % must be a team_admin or global_admin to own users', new.owner_user_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;


--
-- Name: assert_server_binding_subject_exists(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_server_binding_subject_exists() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.subject_type = 'group' then
    if not exists (select 1 from groups where id = new.subject_id) then
      raise exception 'server binding group subject does not exist';
    end if;
  elsif new.subject_type = 'user' then
    if not exists (select 1 from users where id = new.subject_id) then
      raise exception 'server binding user subject does not exist';
    end if;
  else
    raise exception 'invalid server binding subject type';
  end if;
  return new;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: api_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    token_prefix text NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id text NOT NULL,
    event_type text NOT NULL,
    actor_user_id uuid,
    actor_token_id uuid,
    server_id uuid,
    tool_name text,
    status text NOT NULL,
    input_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    encrypted_payload jsonb,
    error_code text,
    duration_ms integer,
    client_ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    executor_kind text,
    operation_id uuid,
    session_id uuid,
    reason text,
    tool_domain text,
    tool_action text,
    tool_risk text,
    error_class text,
    CONSTRAINT audit_events_status_check CHECK ((status = ANY (ARRAY['success'::text, 'failure'::text, 'denied'::text])))
);


--
-- Name: backup_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    credential_id uuid,
    configuration jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'unknown'::text NOT NULL,
    last_discovered_at timestamp with time zone,
    CONSTRAINT backup_providers_kind_check CHECK ((kind = ANY (ARRAY['ssh_archive'::text, 'hosting_provider'::text]))),
    CONSTRAINT backup_providers_status_check CHECK ((status = ANY (ARRAY['unknown'::text, 'available'::text, 'unavailable'::text])))
);


--
-- Name: backups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid NOT NULL,
    provider_id uuid,
    operation_id uuid,
    kind text NOT NULL,
    status text NOT NULL,
    storage_reference text,
    checksum_sha256 text,
    size_bytes bigint,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    retention_until timestamp with time zone,
    verified_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT backups_kind_check CHECK ((kind = ANY (ARRAY['filesystem'::text, 'database'::text, 'combined'::text, 'deployment_snapshot'::text]))),
    CONSTRAINT backups_status_check CHECK ((status = ANY (ARRAY['creating'::text, 'available'::text, 'verified'::text, 'restoring'::text, 'failed'::text, 'deleted'::text])))
);


--
-- Name: database_artifacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.database_artifacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid NOT NULL,
    backup_id uuid,
    operation_id uuid,
    kind text NOT NULL,
    storage_reference text,
    checksum_sha256 text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: deployments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deployments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid NOT NULL,
    provider_id uuid,
    operation_id uuid,
    provider_reference text,
    environment text,
    status text NOT NULL,
    source_deployment_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);


--
-- Name: group_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.group_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_user_id uuid
);


--
-- Name: host_operation_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_operation_logs (
    id bigint NOT NULL,
    operation_id uuid NOT NULL,
    stream text NOT NULL,
    content text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT host_operation_logs_stream_check CHECK ((stream = ANY (ARRAY['stdout'::text, 'stderr'::text, 'system'::text])))
);


--
-- Name: host_operation_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.host_operation_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: host_operation_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.host_operation_logs_id_seq OWNED BY public.host_operation_logs.id;


--
-- Name: host_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_operations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid,
    server_id uuid NOT NULL,
    actor_user_id uuid,
    actor_token_id uuid,
    tool_name text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    input jsonb DEFAULT '{}'::jsonb NOT NULL,
    result jsonb,
    exit_code integer,
    error_code text,
    reason text,
    cancel_requested_at timestamp with time zone,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    progress jsonb DEFAULT '{}'::jsonb NOT NULL,
    correlation_id uuid,
    parent_operation_id uuid,
    error_message text,
    CONSTRAINT host_operations_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: host_session_stream; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_session_stream (
    id bigint NOT NULL,
    session_id uuid NOT NULL,
    direction text NOT NULL,
    content bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT host_session_stream_direction_check CHECK ((direction = ANY (ARRAY['input'::text, 'output'::text, 'system'::text])))
);


--
-- Name: host_session_stream_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.host_session_stream_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: host_session_stream_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.host_session_stream_id_seq OWNED BY public.host_session_stream.id;


--
-- Name: host_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.host_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid NOT NULL,
    actor_user_id uuid,
    actor_token_id uuid,
    credential_id uuid,
    mode text NOT NULL,
    host text NOT NULL,
    username text NOT NULL,
    status text DEFAULT 'starting'::text NOT NULL,
    reason text,
    source_ip text,
    client_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    recording_enabled boolean DEFAULT true NOT NULL,
    recording_failed boolean DEFAULT false NOT NULL,
    recording_truncated boolean DEFAULT false NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_activity_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    CONSTRAINT host_sessions_mode_check CHECK ((mode = ANY (ARRAY['read'::text, 'constrained_shell'::text, 'full_shell'::text, 'root_access'::text]))),
    CONSTRAINT host_sessions_status_check CHECK ((status = ANY (ARRAY['starting'::text, 'active'::text, 'disconnected'::text, 'ended'::text, 'failed'::text, 'revoked'::text])))
);


--
-- Name: hosting_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hosting_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid NOT NULL,
    adapter_id text NOT NULL,
    credential_id uuid,
    base_url text NOT NULL,
    api_version text,
    configuration jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'unknown'::text NOT NULL,
    last_discovered_at timestamp with time zone,
    CONSTRAINT hosting_providers_status_check CHECK ((status = ANY (ARRAY['unknown'::text, 'available'::text, 'unavailable'::text])))
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    actor_token_id uuid,
    server_id uuid,
    tool_name text NOT NULL,
    idempotency_key text NOT NULL,
    input_hash text NOT NULL,
    response_payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    server_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_error text,
    run_after timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT jobs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: operational_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operational_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    status text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: plugins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plugins (
    key text NOT NULL,
    name text NOT NULL,
    version integer NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    cardinality text NOT NULL,
    min_role_to_enable text NOT NULL,
    config_schema jsonb DEFAULT '{}'::jsonb NOT NULL,
    credential_kinds jsonb DEFAULT '[]'::jsonb NOT NULL,
    domains jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT plugins_cardinality_check CHECK ((cardinality = ANY (ARRAY['singleton'::text, 'multi'::text]))),
    CONSTRAINT plugins_min_role_to_enable_check CHECK ((min_role_to_enable = ANY (ARRAY['team_admin'::text, 'global_admin'::text])))
);


--
-- Name: policies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    built_in boolean DEFAULT false NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: policy_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    policy_id uuid NOT NULL,
    tool_name text NOT NULL,
    effect text NOT NULL,
    constraints jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT policy_permissions_effect_check CHECK ((effect = ANY (ARRAY['allow'::text, 'deny'::text])))
);


--
-- Name: provider_operation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_operation_events (
    id bigint NOT NULL,
    operation_id uuid NOT NULL,
    provider_reference text,
    status text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_operation_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.provider_operation_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: provider_operation_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.provider_operation_events_id_seq OWNED BY public.provider_operation_events.id;


--
-- Name: rate_limit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bucket text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: restore_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.restore_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    backup_id uuid,
    server_id uuid NOT NULL,
    operation_id uuid,
    status text NOT NULL,
    rollback_backup_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);


--
-- Name: server_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_bindings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    server_id uuid NOT NULL,
    policy_id uuid NOT NULL,
    constraints jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT server_bindings_subject_type_check CHECK ((subject_type = ANY (ARRAY['group'::text, 'user'::text])))
);


--
-- Name: server_capabilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_capabilities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_plugin_id uuid NOT NULL,
    capability text NOT NULL,
    status text NOT NULL,
    executor_kind text,
    credential_id uuid,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    discovered_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    error_code text,
    error_message text,
    CONSTRAINT server_capabilities_status_check CHECK ((status = ANY (ARRAY['available'::text, 'unavailable'::text, 'unknown'::text])))
);


--
-- Name: server_connection_tests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_connection_tests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid NOT NULL,
    credential_id uuid,
    status text NOT NULL,
    error_code text,
    error_message text,
    tested_at timestamp with time zone DEFAULT now() NOT NULL,
    duration_ms integer,
    CONSTRAINT server_connection_tests_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'error'::text])))
);


--
-- Name: server_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_credentials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_plugin_id uuid NOT NULL,
    kind text NOT NULL,
    encrypted_payload jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    last_tested_at timestamp with time zone,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    rotation_due_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    replaced_at timestamp with time zone,
    CONSTRAINT server_credentials_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text, 'expired'::text, 'failing'::text, 'replaced'::text])))
);


--
-- Name: server_plugins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_plugins (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid NOT NULL,
    plugin_key text NOT NULL,
    instance_name text NOT NULL,
    status text DEFAULT 'enabled'::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_probe_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT server_plugins_status_check CHECK ((status = ANY (ARRAY['enabled'::text, 'disabled'::text])))
);


--
-- Name: servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    address text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    owner_group_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    disabled_at timestamp with time zone,
    CONSTRAINT servers_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);


--
-- Name: server_workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid NOT NULL,
    name text NOT NULL,
    remote_root text NOT NULL,
    kind text NOT NULL,
    allowed_extensions text[] DEFAULT ARRAY['php'::text, 'js'::text, 'ts'::text, 'tsx'::text, 'css'::text, 'scss'::text, 'json'::text, 'md'::text, 'txt'::text, 'yml'::text, 'yaml'::text] NOT NULL,
    max_file_bytes integer DEFAULT 1048576 NOT NULL,
    git_repository text,
    commands jsonb DEFAULT '{}'::jsonb NOT NULL,
    deploy_target text,
    rollback_method text,
    direct_live_edit boolean DEFAULT false NOT NULL,
    CONSTRAINT server_workspaces_kind_check CHECK ((kind = ANY (ARRAY['plugin'::text, 'theme'::text])))
);


--
-- Name: ssh_connectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ssh_connectors (
    server_id uuid NOT NULL,
    credential_id uuid,
    mode text NOT NULL,
    host text NOT NULL,
    port integer DEFAULT 22 NOT NULL,
    username text NOT NULL,
    host_key_fingerprint text NOT NULL,
    wordpress_path text,
    wp_cli_path text DEFAULT 'wp'::text NOT NULL,
    has_sudo boolean DEFAULT false NOT NULL,
    unrestricted_sudo boolean DEFAULT false NOT NULL,
    connection_status text DEFAULT 'unknown'::text NOT NULL,
    last_tested_at timestamp with time zone,
    session_recording boolean DEFAULT true NOT NULL,
    idle_timeout_seconds integer DEFAULT 900 NOT NULL,
    max_session_seconds integer DEFAULT 14400 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ssh_connectors_connection_status_check CHECK ((connection_status = ANY (ARRAY['unknown'::text, 'available'::text, 'unavailable'::text, 'host_key_changed'::text]))),
    CONSTRAINT ssh_connectors_idle_timeout_seconds_check CHECK (((idle_timeout_seconds >= 60) AND (idle_timeout_seconds <= 86400))),
    CONSTRAINT ssh_connectors_max_session_seconds_check CHECK (((max_session_seconds >= 60) AND (max_session_seconds <= 86400))),
    CONSTRAINT ssh_connectors_mode_check CHECK ((mode = ANY (ARRAY['typed_wp_cli'::text, 'constrained_shell'::text, 'full_shell'::text, 'root_access'::text]))),
    CONSTRAINT ssh_connectors_port_check CHECK (((port >= 1) AND (port <= 65535)))
);


--
-- Name: tool_definitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_definitions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    version integer NOT NULL,
    category text NOT NULL,
    input_schema jsonb NOT NULL,
    output_schema jsonb NOT NULL,
    is_write boolean DEFAULT false NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    domain text,
    action text,
    risk text,
    reversible boolean,
    executor_kind text,
    credential_kinds jsonb DEFAULT '[]'::jsonb NOT NULL,
    supports_dry_run boolean DEFAULT false NOT NULL,
    is_long_running boolean DEFAULT false NOT NULL,
    description text,
    constraints_schema jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed boolean DEFAULT false NOT NULL,
    plugin_key text,
    CONSTRAINT tool_definitions_action_check CHECK (((action IS NULL) OR (action = ANY (ARRAY['read'::text, 'create'::text, 'change'::text, 'remove'::text, 'operate'::text])))),
    CONSTRAINT tool_definitions_category_check CHECK ((category = ANY (ARRAY['read'::text, 'write'::text, 'diagnostic'::text]))),
    CONSTRAINT tool_definitions_risk_check CHECK (((risk IS NULL) OR (risk = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]))))
);


--
-- Name: user_ownership_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_ownership_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    previous_owner_user_id uuid,
    new_owner_user_id uuid,
    changed_by_user_id uuid,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid,
    email text NOT NULL,
    display_name text NOT NULL,
    password_hash text NOT NULL,
    password_change_required boolean DEFAULT false NOT NULL,
    role text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone,
    mfa_required boolean DEFAULT false NOT NULL,
    sso_subject text,
    CONSTRAINT users_check CHECK (((role <> 'global_admin'::text) OR (owner_user_id IS NULL))),
    CONSTRAINT users_global_admin_root_check CHECK (((role <> 'global_admin'::text) OR (owner_user_id IS NULL))),
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['global_admin'::text, 'team_admin'::text, 'auditor'::text, 'user'::text]))),
    CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'invited'::text, 'disabled'::text, 'deleted'::text])))
);


--
-- Name: wordpress_networks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wordpress_networks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    primary_server_id uuid,
    credential_id uuid,
    domain text NOT NULL,
    base_path text DEFAULT '/'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    capabilities jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wordpress_networks_status_check CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))
);


--
-- Name: host_operation_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_operation_logs ALTER COLUMN id SET DEFAULT nextval('public.host_operation_logs_id_seq'::regclass);


--
-- Name: host_session_stream id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_session_stream ALTER COLUMN id SET DEFAULT nextval('public.host_session_stream_id_seq'::regclass);


--
-- Name: provider_operation_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_operation_events ALTER COLUMN id SET DEFAULT nextval('public.provider_operation_events_id_seq'::regclass);


--
-- Name: api_tokens api_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);


--
-- Name: api_tokens api_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: backup_providers backup_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_providers
    ADD CONSTRAINT backup_providers_pkey PRIMARY KEY (id);


--
-- Name: backup_providers backup_providers_server_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_providers
    ADD CONSTRAINT backup_providers_server_id_name_key UNIQUE (server_id, name);


--
-- Name: backups backups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backups
    ADD CONSTRAINT backups_pkey PRIMARY KEY (id);


--
-- Name: database_artifacts database_artifacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_artifacts
    ADD CONSTRAINT database_artifacts_pkey PRIMARY KEY (id);


--
-- Name: deployments deployments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_pkey PRIMARY KEY (id);


--
-- Name: group_memberships group_memberships_group_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_memberships
    ADD CONSTRAINT group_memberships_group_id_user_id_key UNIQUE (group_id, user_id);


--
-- Name: group_memberships group_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_memberships
    ADD CONSTRAINT group_memberships_pkey PRIMARY KEY (id);


--
-- Name: groups groups_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_name_key UNIQUE (name);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);


--
-- Name: host_operation_logs host_operation_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_operation_logs
    ADD CONSTRAINT host_operation_logs_pkey PRIMARY KEY (id);


--
-- Name: host_operations host_operations_job_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_operations
    ADD CONSTRAINT host_operations_job_id_key UNIQUE (job_id);


--
-- Name: host_operations host_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_operations
    ADD CONSTRAINT host_operations_pkey PRIMARY KEY (id);


--
-- Name: host_session_stream host_session_stream_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_session_stream
    ADD CONSTRAINT host_session_stream_pkey PRIMARY KEY (id);


--
-- Name: host_sessions host_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_sessions
    ADD CONSTRAINT host_sessions_pkey PRIMARY KEY (id);


--
-- Name: hosting_providers hosting_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosting_providers
    ADD CONSTRAINT hosting_providers_pkey PRIMARY KEY (id);


--
-- Name: hosting_providers hosting_providers_server_id_adapter_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosting_providers
    ADD CONSTRAINT hosting_providers_server_id_adapter_id_key UNIQUE (server_id, adapter_id);


--
-- Name: idempotency_keys idempotency_keys_actor_token_id_server_id_tool_name_idempot_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_actor_token_id_server_id_tool_name_idempot_key UNIQUE (actor_token_id, server_id, tool_name, idempotency_key);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: operational_events operational_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operational_events
    ADD CONSTRAINT operational_events_pkey PRIMARY KEY (id);


--
-- Name: plugins plugins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plugins
    ADD CONSTRAINT plugins_pkey PRIMARY KEY (key);


--
-- Name: policies policies_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policies
    ADD CONSTRAINT policies_name_key UNIQUE (name);


--
-- Name: policies policies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policies
    ADD CONSTRAINT policies_pkey PRIMARY KEY (id);


--
-- Name: policy_permissions policy_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_permissions
    ADD CONSTRAINT policy_permissions_pkey PRIMARY KEY (id);


--
-- Name: policy_permissions policy_permissions_policy_id_tool_name_effect_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_permissions
    ADD CONSTRAINT policy_permissions_policy_id_tool_name_effect_key UNIQUE (policy_id, tool_name, effect);


--
-- Name: provider_operation_events provider_operation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_operation_events
    ADD CONSTRAINT provider_operation_events_pkey PRIMARY KEY (id);


--
-- Name: rate_limit_events rate_limit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_events
    ADD CONSTRAINT rate_limit_events_pkey PRIMARY KEY (id);


--
-- Name: restore_history restore_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restore_history
    ADD CONSTRAINT restore_history_pkey PRIMARY KEY (id);


--
-- Name: server_bindings server_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_bindings
    ADD CONSTRAINT server_bindings_pkey PRIMARY KEY (id);


--
-- Name: server_bindings server_bindings_subject_type_subject_id_server_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_bindings
    ADD CONSTRAINT server_bindings_subject_type_subject_id_server_id_key UNIQUE (subject_type, subject_id, server_id);


--
-- Name: server_capabilities server_capabilities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_capabilities
    ADD CONSTRAINT server_capabilities_pkey PRIMARY KEY (id);


--
-- Name: server_capabilities server_capabilities_server_plugin_id_capability_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_capabilities
    ADD CONSTRAINT server_capabilities_server_plugin_id_capability_key UNIQUE (server_plugin_id, capability);


--
-- Name: server_connection_tests server_connection_tests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_connection_tests
    ADD CONSTRAINT server_connection_tests_pkey PRIMARY KEY (id);


--
-- Name: server_credentials server_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_credentials
    ADD CONSTRAINT server_credentials_pkey PRIMARY KEY (id);


--
-- Name: server_plugins server_plugins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_plugins
    ADD CONSTRAINT server_plugins_pkey PRIMARY KEY (id);


--
-- Name: server_plugins server_plugins_server_id_plugin_key_instance_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_plugins
    ADD CONSTRAINT server_plugins_server_id_plugin_key_instance_name_key UNIQUE (server_id, plugin_key, instance_name);


--
-- Name: servers servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_pkey PRIMARY KEY (id);


--
--
-- Name: server_workspaces server_workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_workspaces
    ADD CONSTRAINT server_workspaces_pkey PRIMARY KEY (id);


--
-- Name: server_workspaces server_workspaces_server_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_workspaces
    ADD CONSTRAINT server_workspaces_server_id_name_key UNIQUE (server_id, name);


--
-- Name: ssh_connectors ssh_connectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ssh_connectors
    ADD CONSTRAINT ssh_connectors_pkey PRIMARY KEY (server_id);


--
-- Name: tool_definitions tool_definitions_name_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_definitions
    ADD CONSTRAINT tool_definitions_name_version_key UNIQUE (name, version);


--
-- Name: tool_definitions tool_definitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_definitions
    ADD CONSTRAINT tool_definitions_pkey PRIMARY KEY (id);


--
-- Name: user_ownership_history user_ownership_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ownership_history
    ADD CONSTRAINT user_ownership_history_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: wordpress_networks wordpress_networks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wordpress_networks
    ADD CONSTRAINT wordpress_networks_pkey PRIMARY KEY (id);


--
-- Name: api_tokens_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX api_tokens_user_id_idx ON public.api_tokens USING btree (user_id);


--
-- Name: audit_events_actor_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_actor_user_id_idx ON public.audit_events USING btree (actor_user_id);


--
-- Name: audit_events_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_created_at_idx ON public.audit_events USING btree (created_at DESC);


--
-- Name: audit_events_operation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_operation_idx ON public.audit_events USING btree (operation_id);


--
-- Name: audit_events_server_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_server_id_idx ON public.audit_events USING btree (server_id);


--
-- Name: audit_events_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_session_idx ON public.audit_events USING btree (session_id);


--
-- Name: backups_server_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backups_server_created_idx ON public.backups USING btree (server_id, created_at DESC);


--
-- Name: host_operations_server_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_operations_server_created_idx ON public.host_operations USING btree (server_id, created_at DESC);


--
-- Name: host_sessions_actor_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX host_sessions_actor_started_idx ON public.host_sessions USING btree (actor_user_id, started_at DESC);


--
-- Name: idempotency_keys_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idempotency_keys_lookup_idx ON public.idempotency_keys USING btree (actor_token_id, server_id, tool_name, idempotency_key);


--
-- Name: operational_events_kind_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operational_events_kind_created_at_idx ON public.operational_events USING btree (kind, created_at DESC);


--
-- Name: policy_permissions_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX policy_permissions_lookup_idx ON public.policy_permissions USING btree (policy_id, tool_name);


--
-- Name: rate_limit_events_bucket_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rate_limit_events_bucket_created_at_idx ON public.rate_limit_events USING btree (bucket, created_at DESC);


--
-- Name: server_bindings_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX server_bindings_lookup_idx ON public.server_bindings USING btree (server_id, subject_type, subject_id);


--
-- Name: server_capabilities_fresh_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX server_capabilities_fresh_idx ON public.server_capabilities USING btree (server_plugin_id, expires_at);


--
-- Name: server_capabilities_plugin_capability_idx; Type: INDEX; Schema: public; Owner: -
--

--
-- Name: server_credentials_plugin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX server_credentials_plugin_idx ON public.server_credentials USING btree (server_plugin_id, status);


--
--
-- Name: server_plugins_server_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX server_plugins_server_status_idx ON public.server_plugins USING btree (server_id, status);


--
--
-- Name: tool_definitions_domain_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tool_definitions_domain_action_idx ON public.tool_definitions USING btree (domain, action);


--
-- Name: user_ownership_history_user_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_ownership_history_user_id_created_at_idx ON public.user_ownership_history USING btree (user_id, created_at DESC);


--
-- Name: users_owner_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_owner_user_id_idx ON public.users USING btree (owner_user_id);


--
-- Name: server_bindings server_bindings_subject_exists; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER server_bindings_subject_exists BEFORE INSERT OR UPDATE ON public.server_bindings FOR EACH ROW EXECUTE FUNCTION public.assert_server_binding_subject_exists();


--
-- Name: users users_owner_role_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_owner_role_check BEFORE INSERT OR UPDATE OF owner_user_id ON public.users FOR EACH ROW EXECUTE FUNCTION public.assert_owner_is_admin();


--
-- Name: api_tokens api_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: app_settings app_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_events audit_events_actor_token_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_actor_token_id_fkey FOREIGN KEY (actor_token_id) REFERENCES public.api_tokens(id) ON DELETE SET NULL;


--
-- Name: audit_events audit_events_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: audit_events audit_events_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE SET NULL;


--
-- Name: backup_providers backup_providers_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_providers
    ADD CONSTRAINT backup_providers_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.server_credentials(id) ON DELETE SET NULL;


--
-- Name: backup_providers backup_providers_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_providers
    ADD CONSTRAINT backup_providers_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: backups backups_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backups
    ADD CONSTRAINT backups_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.host_operations(id) ON DELETE SET NULL;


--
-- Name: backups backups_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backups
    ADD CONSTRAINT backups_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.backup_providers(id) ON DELETE SET NULL;


--
-- Name: backups backups_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backups
    ADD CONSTRAINT backups_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: database_artifacts database_artifacts_backup_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_artifacts
    ADD CONSTRAINT database_artifacts_backup_id_fkey FOREIGN KEY (backup_id) REFERENCES public.backups(id) ON DELETE SET NULL;


--
-- Name: database_artifacts database_artifacts_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_artifacts
    ADD CONSTRAINT database_artifacts_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.host_operations(id) ON DELETE SET NULL;


--
-- Name: database_artifacts database_artifacts_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.database_artifacts
    ADD CONSTRAINT database_artifacts_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: deployments deployments_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.host_operations(id) ON DELETE SET NULL;


--
-- Name: deployments deployments_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.hosting_providers(id) ON DELETE SET NULL;


--
-- Name: deployments deployments_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: deployments deployments_source_deployment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployments
    ADD CONSTRAINT deployments_source_deployment_id_fkey FOREIGN KEY (source_deployment_id) REFERENCES public.deployments(id) ON DELETE SET NULL;


--
-- Name: group_memberships group_memberships_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_memberships
    ADD CONSTRAINT group_memberships_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: group_memberships group_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.group_memberships
    ADD CONSTRAINT group_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: groups groups_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: host_operation_logs host_operation_logs_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_operation_logs
    ADD CONSTRAINT host_operation_logs_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.host_operations(id) ON DELETE CASCADE;


--
-- Name: host_operations host_operations_actor_token_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_operations
    ADD CONSTRAINT host_operations_actor_token_id_fkey FOREIGN KEY (actor_token_id) REFERENCES public.api_tokens(id) ON DELETE SET NULL;


--
-- Name: host_operations host_operations_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_operations
    ADD CONSTRAINT host_operations_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: host_operations host_operations_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_operations
    ADD CONSTRAINT host_operations_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: host_operations host_operations_parent_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_operations
    ADD CONSTRAINT host_operations_parent_operation_id_fkey FOREIGN KEY (parent_operation_id) REFERENCES public.host_operations(id) ON DELETE SET NULL;


--
-- Name: host_operations host_operations_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_operations
    ADD CONSTRAINT host_operations_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: host_session_stream host_session_stream_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_session_stream
    ADD CONSTRAINT host_session_stream_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.host_sessions(id) ON DELETE CASCADE;


--
-- Name: host_sessions host_sessions_actor_token_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_sessions
    ADD CONSTRAINT host_sessions_actor_token_id_fkey FOREIGN KEY (actor_token_id) REFERENCES public.api_tokens(id) ON DELETE SET NULL;


--
-- Name: host_sessions host_sessions_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_sessions
    ADD CONSTRAINT host_sessions_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: host_sessions host_sessions_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_sessions
    ADD CONSTRAINT host_sessions_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.server_credentials(id) ON DELETE SET NULL;


--
-- Name: host_sessions host_sessions_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.host_sessions
    ADD CONSTRAINT host_sessions_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: hosting_providers hosting_providers_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosting_providers
    ADD CONSTRAINT hosting_providers_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.server_credentials(id) ON DELETE SET NULL;


--
-- Name: hosting_providers hosting_providers_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hosting_providers
    ADD CONSTRAINT hosting_providers_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: idempotency_keys idempotency_keys_actor_token_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_actor_token_id_fkey FOREIGN KEY (actor_token_id) REFERENCES public.api_tokens(id) ON DELETE CASCADE;


--
-- Name: idempotency_keys idempotency_keys_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: jobs jobs_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE SET NULL;


--
-- Name: policies policies_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policies
    ADD CONSTRAINT policies_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: policy_permissions policy_permissions_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_permissions
    ADD CONSTRAINT policy_permissions_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.policies(id) ON DELETE CASCADE;


--
-- Name: provider_operation_events provider_operation_events_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_operation_events
    ADD CONSTRAINT provider_operation_events_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.host_operations(id) ON DELETE CASCADE;


--
-- Name: restore_history restore_history_backup_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restore_history
    ADD CONSTRAINT restore_history_backup_id_fkey FOREIGN KEY (backup_id) REFERENCES public.backups(id) ON DELETE SET NULL;


--
-- Name: restore_history restore_history_operation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restore_history
    ADD CONSTRAINT restore_history_operation_id_fkey FOREIGN KEY (operation_id) REFERENCES public.host_operations(id) ON DELETE SET NULL;


--
-- Name: restore_history restore_history_rollback_backup_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restore_history
    ADD CONSTRAINT restore_history_rollback_backup_id_fkey FOREIGN KEY (rollback_backup_id) REFERENCES public.backups(id) ON DELETE SET NULL;


--
-- Name: restore_history restore_history_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.restore_history
    ADD CONSTRAINT restore_history_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: server_bindings server_bindings_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_bindings
    ADD CONSTRAINT server_bindings_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: server_bindings server_bindings_policy_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_bindings
    ADD CONSTRAINT server_bindings_policy_id_fkey FOREIGN KEY (policy_id) REFERENCES public.policies(id) ON DELETE RESTRICT;


--
-- Name: server_bindings server_bindings_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_bindings
    ADD CONSTRAINT server_bindings_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: server_capabilities server_capabilities_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_capabilities
    ADD CONSTRAINT server_capabilities_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.server_credentials(id) ON DELETE SET NULL;


--
--
-- Name: server_capabilities server_capabilities_server_plugin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_capabilities
    ADD CONSTRAINT server_capabilities_server_plugin_id_fkey FOREIGN KEY (server_plugin_id) REFERENCES public.server_plugins(id) ON DELETE CASCADE;


--
-- Name: server_connection_tests server_connection_tests_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_connection_tests
    ADD CONSTRAINT server_connection_tests_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.server_credentials(id) ON DELETE SET NULL;


--
-- Name: server_connection_tests server_connection_tests_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_connection_tests
    ADD CONSTRAINT server_connection_tests_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
--
-- Name: server_credentials server_credentials_server_plugin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_credentials
    ADD CONSTRAINT server_credentials_server_plugin_id_fkey FOREIGN KEY (server_plugin_id) REFERENCES public.server_plugins(id) ON DELETE CASCADE;


--
-- Name: server_plugins server_plugins_plugin_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_plugins
    ADD CONSTRAINT server_plugins_plugin_key_fkey FOREIGN KEY (plugin_key) REFERENCES public.plugins(key) ON DELETE RESTRICT;


--
-- Name: server_plugins server_plugins_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_plugins
    ADD CONSTRAINT server_plugins_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: servers servers_owner_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_owner_group_id_fkey FOREIGN KEY (owner_group_id) REFERENCES public.groups(id) ON DELETE SET NULL;


--
-- Name: server_workspaces server_workspaces_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_workspaces
    ADD CONSTRAINT server_workspaces_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: ssh_connectors ssh_connectors_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ssh_connectors
    ADD CONSTRAINT ssh_connectors_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.server_credentials(id) ON DELETE SET NULL;


--
-- Name: ssh_connectors ssh_connectors_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ssh_connectors
    ADD CONSTRAINT ssh_connectors_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: tool_definitions tool_definitions_plugin_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_definitions
    ADD CONSTRAINT tool_definitions_plugin_key_fkey FOREIGN KEY (plugin_key) REFERENCES public.plugins(key) ON DELETE RESTRICT;


--
-- Name: user_ownership_history user_ownership_history_changed_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ownership_history
    ADD CONSTRAINT user_ownership_history_changed_by_user_id_fkey FOREIGN KEY (changed_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_ownership_history user_ownership_history_new_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ownership_history
    ADD CONSTRAINT user_ownership_history_new_owner_user_id_fkey FOREIGN KEY (new_owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_ownership_history user_ownership_history_previous_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ownership_history
    ADD CONSTRAINT user_ownership_history_previous_owner_user_id_fkey FOREIGN KEY (previous_owner_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_ownership_history user_ownership_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ownership_history
    ADD CONSTRAINT user_ownership_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: wordpress_networks wordpress_networks_credential_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wordpress_networks
    ADD CONSTRAINT wordpress_networks_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES public.server_credentials(id) ON DELETE SET NULL;


--
-- Name: wordpress_networks wordpress_networks_primary_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wordpress_networks
    ADD CONSTRAINT wordpress_networks_primary_server_id_fkey FOREIGN KEY (primary_server_id) REFERENCES public.servers(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--
