# AIBroker Production Runbook

## Targets

- Recovery point objective: 15 minutes.
- Recovery time objective: 4 hours.
- Production writes default to disabled.
- Publish actions are governed by tool permissions and recorded as audit events.

## Deploy

1. Build and push API, web, and worker images.
2. Create or update `aibroker-secrets`.
3. Run the migration job.
4. Roll out API, worker, and web deployments.
5. Verify `/health/ready` and `/metrics`.
6. Confirm policy, group, and server-binding administration works in the web UI before enabling MCP traffic.

## Rollback

```sh
kubectl -n aibroker rollout undo deploy/aibroker-api
kubectl -n aibroker rollout undo deploy/aibroker-web
kubectl -n aibroker rollout undo deploy/aibroker-worker
```

If a migration caused the issue, restore from the latest verified backup instead of manually editing production data. The permissions cleanup migration removes the legacy grants table and decorative server owner-group column, so rollback after that point requires a database restore from the pre-migration backup.

## Backup Drill

1. Confirm the backup CronJob is succeeding.
2. Restore the latest backup into an isolated database.
3. Start an isolated AIBroker API against the restored database.
4. Verify users, groups, policies, server bindings, encrypted credentials, and audit events are readable.
5. Record the elapsed restore time.

## Redis Recovery

Redis is allowed to lose cache, session, and rate-limit state. Jobs that can affect writes must be represented in PostgreSQL so they can be inspected or reconstructed.

## Alerts

- Repeated failed admin logins.
- Connector failure spike.
- Production write request.
- Backup failure.
- Audit write failure.
- Worker job failures.
