# Security Foundation

AIBroker establishes these baseline controls:

- Environment configuration validation.
- Hashed admin passwords.
- Hashed API tokens.
- AES-256-GCM credential encryption.
- Secret redaction helpers for logs and audit summaries.
- Append-only audit event writer.
- SSRF guard helpers for connector target validation.
- Global feature flags for MCP, write tools, and production writes.
- Reusable policy/group/server-binding authorization with deny-wins evaluation.

The MCP endpoint and write tools should remain disabled until operators have created the intended policies, groups, and server bindings.
