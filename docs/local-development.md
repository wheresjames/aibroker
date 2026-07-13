# Local Development

## Prerequisites

- Docker
- Docker Compose
- Node.js LTS
- pnpm through Corepack

## Setup

Copy the example environment:

```sh
cp .env.example .env
```

Generate an encryption key:

```sh
openssl rand -base64 32
```

Set `AIBROKER_ENCRYPTION_KEY_BASE64` in `.env`.

Start local services:

```sh
./dev.sh run
```

The API applies migrations and synchronizes the code-defined plugin/tool catalog before it
starts listening. A fresh database therefore supports adding plugin instances without a
separate seed command; `./dev.sh seed` remains an idempotent maintenance command.

Local app data is stored under `./data`:

- `./data/postgres`
- `./data/wordpress-db`

Stop the stack and delete `./data` to reset the local app. The databases and bootstrap admin will be recreated on the next `./dev.sh run`.

If there is no active admin, the API creates a bootstrap admin on startup and logs the credentials until the password is changed. The default local bootstrap admin comes from:

- `AIBROKER_BOOTSTRAP_ADMIN_EMAIL`
- `AIBROKER_BOOTSTRAP_ADMIN_PASSWORD`
- `AIBROKER_BOOTSTRAP_ADMIN_NAME`

The API prints the configured local bootstrap username and password only while that account
still requires its initial password change. After rotation, subsequent starts do not echo the
credentials.

## URLs

- API: `http://localhost:8080`
- Web UI: `http://localhost:3000`
- Disposable WordPress: `http://localhost:8081`

## Health Checks

```sh
curl http://localhost:8080/health/live
curl http://localhost:8080/health/ready
```
