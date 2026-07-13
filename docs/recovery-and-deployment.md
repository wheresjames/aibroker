# Recovery, deployment, and multisite operations

Recovery and database tools are durable, policy-authorized operations. They use the pinned SSH connector and the reviewed remote helper supplied at `scripts/aibroker-recovery`; install it as `/usr/local/lib/aibroker/recovery.sh` on the managed host. The helper is responsible for broker-owned artifact storage, SHA-256 verification, restore staging, serialization-aware WordPress search/replace, and bounded metadata output. It returns JSON containing artifact references rather than archive or database contents. Clients never receive database credentials.

The optional `requiredBackupMaxAgeHours` policy or binding constraint applies only to the destructive tools that advertise it in their catalog schema. When configured, execution requires a recent available or verified backup. When absent, no backup gate is added.

Hosting access uses the reviewed `aibroker_v1` adapter contract. Provider URLs are SSRF-validated, redirects are rejected, bearer credentials stay encrypted, calls use explicit endpoint mappings, and mutation idempotency keys are forwarded. Hosting/Deployment permissions remain independent from server, host-session, and network permissions.

A WordPress network is a distinct record whose primary server is the only valid target for network tools. Each subsite remains an ordinary server with separate policy bindings. A subsite binding therefore cannot authorize a network operation. Super Admin changes are downstream WP-CLI results and never modify broker policy.

The Everything template expands to explicit permissions only when initially created. Running the seeder after an upgrade does not append new tools to an existing bound policy. Administrators must review and deliberately add new permissions.

Every operation records its operation ID, actor, server, tool metadata, optional reason, progress, bounded logs, result/error, provider or backup records, and audit correlation. Interrupted non-session work older than five minutes is returned to the durable queue on worker startup.
