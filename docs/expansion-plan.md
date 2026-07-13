# Optional Expansion Plan

## Git Pull Requests

Theme and plugin code changes should become pull requests, not direct WordPress file edits.

## Companion WordPress Plugin

An optional plugin can provide richer server maps, diagnostics, and page-builder-aware read models. It should not be required for MVP functionality.

## Hosting Providers

Hosting provider integrations can add cache purge, environment clone, backup trigger, and deploy metadata tools. Each provider action must be exposed as a narrow typed tool.

## External Secrets

Supported future integrations:

- Vault
- SOPS
- External Secrets Operator
- Cloud KMS
