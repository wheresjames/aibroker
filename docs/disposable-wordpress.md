# Disposable WordPress

The local Docker Compose stack includes a disposable WordPress instance for integration testing.

## Services

- WordPress: `http://localhost:8081`
- Database: `wordpress-db`

## Initial Setup

1. Start Docker Compose.
2. Open `http://localhost:8081`.
3. Complete the WordPress installer.
4. Create a dedicated WordPress user for AIBroker.
5. Create a WordPress Application Password for that user.
6. Register the server in AIBroker using the REST base URL `http://wordpress` from inside Docker, or `http://localhost:8081` from the host.

The development-only **Sandbox** page also exposes this target's complete connection
configuration without registering it automatically. Use **Register this test server** only
when you want the shortcut; manual registration remains the recommended way to learn which
server and plugin fields are required.

For a fresh named target, run `./dev.sh run --wptest server1 --keep`. Its generated config is
written below `data/wptest/server1/`, including the WordPress path. Secrets entered into
AIBroker follow the same encrypted credential path as production credentials.
