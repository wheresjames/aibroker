# Security Operations

## Admin Authentication

MVP production deployments should require SSO or MFA for admin users before internet exposure. The current API exposes security status so deployment checks can fail closed until SSO/MFA is configured by the chosen identity provider.

## Key Rotation

1. Put AIBroker into write-disabled mode.
2. Export encrypted credential rows for audit.
3. Configure a new key-encryption key.
4. Re-encrypt credentials in a controlled maintenance job.
5. Verify server connection tests.
6. Re-enable writes.

## Credential Rotation

1. Create a replacement WordPress Application Password, SSH key, or deploy token.
2. Store it in AIBroker.
3. Test the connection.
4. Mark the old credential replaced or revoke it at the source.
5. Confirm audit events were created.

## Production Credential Dual Control

Production credential changes should require one admin to submit the change and another admin to approve it. Until dual control is implemented as a separate workflow, restrict production credential changes to global admins and review audit exports.

## Scanning

Recommended commands:

```sh
npm audit --workspaces
trivy image aibroker-api:latest
trivy image aibroker-web:latest
trivy image aibroker-worker:latest
```

## Regression Checks

- No generic shell tool.
- No generic SQL tool.
- No generic WP-CLI tool.
- No direct production publish tool.
- Audit export actions create audit events.
