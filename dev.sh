#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PNPM_VERSION="9.15.4"
COMPOSE_PROJECT="aibroker"
WPTEST_LABEL="com.aibroker.wptest"
WPTEST_DB_IMAGE="mariadb:11"
WPTEST_WP_IMAGE="wordpress:6-apache"
WPTEST_CLI_IMAGE="wordpress:cli"
WPTEST_WORDPRESS_PATH="/var/www/html"

usage() {
  cat <<'EOF'
AIBroker developer doorway

Usage:
  ./dev.sh deps-status       Show required local dependencies and project status
  ./dev.sh deps-install      Install/update local project dependencies
  ./dev.sh run               Run the full dev stack in the foreground; Ctrl+C stops services
  ./dev.sh run --wptest NAME [--port N] [--keep]
                             Run the full dev stack AND start a named throwaway WordPress
                             test site as a target, staying in the foreground; Ctrl+C stops
                             both (test site data is kept). Pass --keep to leave the test
                             site running after the script exits (the stack is still stopped).
                             Re-running reuses an existing test site (starting it if stopped).
                             Test site data lives in ./data/wptest/NAME and access details
                             are written to ./data/wptest/NAME/config.txt
  ./dev.sh wptest-list       List running/created WordPress test sites
  ./dev.sh wptest-stop NAME  Stop a WordPress test site (keeps data)
  ./dev.sh wptest-rm NAME    Stop and delete a WordPress test site and its data
  ./dev.sh build             Build Docker images
  ./dev.sh run-image         Run previously built Docker images; Ctrl+C stops services
  ./dev.sh test              Run typecheck and tests
  ./dev.sh migrate           Build a one-off API container and run database migrations
  ./dev.sh seed              Build a one-off API container and seed tools/local admin
  ./dev.sh db-setup          Run migrations and seeding in one command
  ./dev.sh down              Stop all AIBroker Docker services
  ./dev.sh logs              Follow full, unfiltered Docker service logs
  ./dev.sh backup            Create a local PostgreSQL backup using AIBROKER_DATABASE_URL
  ./dev.sh k3s-smoke         Run k3s deployment smoke checks
  ./dev.sh help              Show this help

Primary inspection URLs after run/run-image:
  UI:                 http://localhost:3000
  API live health:    http://localhost:8080/health/live
  API ready health:   http://localhost:8080/health/ready
  WordPress:          http://localhost:8081

Console logs hide routine HTTP request starts and successful completions.
Full run output is saved to data/logs/compose-*.log (not automatically rotated).
Use AIBROKER_CONSOLE_LOGS=full ./dev.sh run for unfiltered console output.
EOF
}

have() {
  command -v "$1" >/dev/null 2>&1
}

status_line() {
  local label="$1"
  local state="$2"
  local detail="${3:-}"
  printf "%-28s %-10s %s\n" "$label" "$state" "$detail"
}

require_cmd() {
  if ! have "$1"; then
    echo "Missing required command: $1" >&2
    return 1
  fi
}

docker_compose() {
  docker compose -p "$COMPOSE_PROJECT" "$@"
}

ensure_data_dirs() {
  mkdir -p data/postgres data/wordpress-db
}

ensure_env() {
  if [[ -f .env ]]; then
    # Phase 1 renamed the environment namespace. Preserve existing local values while
    # upgrading an older checkout's untracked .env in place.
    if grep -q '^WPBROKER_' .env; then
      perl -pi -e 's/^WPBROKER_/AIBROKER_/' .env
      echo "Updated legacy WPBROKER_* keys in .env to AIBROKER_*"
    fi

    local generated
    if ! grep -Eq '^AIBROKER_SESSION_SECRET=.+$' .env; then
      if have openssl; then
        generated="$(openssl rand -hex 32)"
      else
        generated="local_development_session_secret_change_me"
      fi
      printf '\nAIBROKER_SESSION_SECRET=%s\n' "$generated" >> .env
      echo "Added missing AIBROKER_SESSION_SECRET to .env"
    fi
    if ! grep -Eq '^AIBROKER_ENCRYPTION_KEY_BASE64=.+$' .env; then
      if have openssl; then
        generated="$(openssl rand -base64 32)"
      else
        generated="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
      fi
      printf 'AIBROKER_ENCRYPTION_KEY_BASE64=%s\n' "$generated" >> .env
      echo "Added missing AIBROKER_ENCRYPTION_KEY_BASE64 to .env"
    fi
    return
  fi

  local key
  if have openssl; then
    key="$(openssl rand -base64 32)"
  else
    key="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  fi

  cat > .env <<EOF
NODE_ENV=development
AIBROKER_API_PORT=8080
AIBROKER_WEB_PORT=3000
AIBROKER_PUBLIC_URL=http://localhost:8080
AIBROKER_DATABASE_URL=postgres://aibroker:aibroker@postgres:5432/aibroker
AIBROKER_REDIS_URL=redis://redis:6379
AIBROKER_SESSION_SECRET=local_development_session_secret_change_me
AIBROKER_ENCRYPTION_KEY_BASE64=${key}
AIBROKER_ALLOW_PRIVATE_CONNECTOR_TARGETS=true
AIBROKER_MCP_ENABLED=false
AIBROKER_WRITE_TOOLS_ENABLED=false
AIBROKER_PRODUCTION_WRITES_ENABLED=false
AIBROKER_BOOTSTRAP_ADMIN_EMAIL=admin@example.com
AIBROKER_BOOTSTRAP_ADMIN_PASSWORD=change_me_in_local_dev
AIBROKER_BOOTSTRAP_ADMIN_NAME=AIBroker Admin
WORDPRESS_DB_HOST=wordpress-db
WORDPRESS_DB_NAME=wordpress
WORDPRESS_DB_USER=wordpress
WORDPRESS_DB_PASSWORD=wordpress
EOF
  echo "Created local .env"
}

pnpm_cmd() {
  corepack pnpm "$@"
}

ensure_corepack_pnpm() {
  require_cmd node
  require_cmd corepack
  if corepack pnpm --version >/dev/null 2>&1; then
    return
  fi
  corepack prepare "pnpm@${PNPM_VERSION}" --activate
}

deps_status() {
  echo "Local dependency status"
  echo

  if have docker; then
    if docker info >/dev/null 2>&1; then
      status_line "Docker daemon" "ok" "$(docker --version)"
    else
      status_line "Docker daemon" "error" "docker is installed but daemon is not reachable"
    fi
  else
    status_line "Docker" "missing" "install Docker"
  fi

  if have docker && docker compose version >/dev/null 2>&1; then
    status_line "Docker Compose" "ok" "$(docker compose version --short)"
  else
    status_line "Docker Compose" "missing" "install Docker Compose plugin"
  fi

  if have node; then
    status_line "Node.js" "ok" "$(node --version)"
  else
    status_line "Node.js" "missing" "install Node.js LTS"
  fi

  if have corepack; then
    status_line "Corepack" "ok" "$(corepack --version)"
  else
    status_line "Corepack" "missing" "install Node.js with Corepack"
  fi

  if have corepack && corepack pnpm --version >/dev/null 2>&1; then
    status_line "pnpm" "ok" "$(corepack pnpm --version)"
  else
    status_line "pnpm" "missing" "run ./dev.sh deps-install"
  fi

  if have openssl; then
    status_line "OpenSSL" "ok" "$(openssl version | awk '{print $1, $2}')"
  else
    status_line "OpenSSL" "missing" "needed for random local encryption keys"
  fi

  if have curl; then
    status_line "curl" "ok" "$(curl --version | head -n 1)"
  else
    status_line "curl" "missing" "useful for health checks"
  fi

  if [[ -f .env ]]; then
    status_line ".env" "ok" "present"
  else
    status_line ".env" "missing" "run ./dev.sh deps-install or ./dev.sh run"
  fi

  if [[ -d node_modules && -f pnpm-lock.yaml ]]; then
    if have corepack && corepack pnpm install --offline --frozen-lockfile >/dev/null 2>&1; then
      status_line "Node dependencies" "ok" "installed and lockfile satisfied"
    else
      status_line "Node dependencies" "stale" "run ./dev.sh deps-install"
    fi
  else
    status_line "Node dependencies" "missing" "run ./dev.sh deps-install"
  fi

  if have docker && docker info >/dev/null 2>&1; then
    echo
    echo "Docker services"
    docker_compose ps || true
  fi
}

deps_install() {
  ensure_env
  ensure_corepack_pnpm
  pnpm_cmd install

  if have docker && docker info >/dev/null 2>&1; then
    docker_compose pull
  else
    echo "Docker daemon is not reachable; skipped image pulls" >&2
  fi
}

cleanup_stack() {
  local code=$?
  set +e
  echo
  echo "Stopping AIBroker services..."
  docker_compose down || true
  exit "$code"
}

compose_foreground() {
  local log_file
  mkdir -p data/logs
  log_file="$(mktemp "${ROOT_DIR}/data/logs/compose-$(date +%Y%m%d-%H%M%S)-XXXXXX.log")"
  echo "Full stack log: ${log_file}"
  if [[ "${AIBROKER_CONSOLE_LOGS:-quiet}" == "full" ]]; then
    docker_compose up "$@" 2>&1 | tee -a "$log_file"
  elif have node; then
    echo "Console: routine HTTP requests hidden; use ./dev.sh logs for full service logs."
    docker_compose up --no-color "$@" 2>&1 | tee -a "$log_file" | node scripts/console-log-filter.mjs
  else
    echo "Node.js unavailable; showing full console logs."
    docker_compose up "$@" 2>&1 | tee -a "$log_file"
  fi
}

run_stack() {
  ensure_env
  ensure_data_dirs
  require_cmd docker
  trap cleanup_stack INT TERM EXIT
  compose_foreground --build
}

build_images() {
  ensure_env
  require_cmd docker
  docker_compose build
}

run_images() {
  ensure_env
  ensure_data_dirs
  require_cmd docker
  trap cleanup_stack INT TERM EXIT
  compose_foreground --no-build
}

# Run the full AIBroker stack in the foreground AND bring up a named WordPress
# test site alongside it. Ctrl+C stops the stack (and the test site, unless
# --keep was given). The test site is started first via wptest_create with
# WPT_NOFG=1 so it returns once the site is up instead of taking over the
# foreground; this function then drives the stack and owns cleanup for both.
run_stack_and_wptest() {
  ensure_env
  ensure_data_dirs
  require_cmd docker
  require_cmd curl

  WPT_NOFG=1 wptest_create "$@" || return $?

  combined_cleanup() {
    local code=$?
    set +e
    trap - INT TERM EXIT
    echo
    echo "Stopping AIBroker services..."
    docker_compose down || true
    if [[ -z "${WPT_KEEP:-}" ]]; then
      wptest_stop_containers "$WPT_FG_NAME"
    else
      echo "Leaving WordPress test site '${WPT_FG_NAME}' running (--keep)."
      echo "Stop it with: ./dev.sh wptest-stop ${WPT_FG_NAME}"
    fi
    exit "$code"
  }
  trap combined_cleanup INT TERM EXIT

  echo "------------------------------------------------------------"
  echo "Starting the AIBroker stack with WordPress test site '${WPT_FG_NAME}'."
  echo "Press Ctrl+C to stop everything."
  echo "------------------------------------------------------------"
  compose_foreground --build
  combined_cleanup
}

run_tests() {
  ensure_corepack_pnpm
  pnpm_cmd typecheck
  pnpm_cmd test
}

migrate_db() {
  require_cmd docker
  ensure_env
  ensure_data_dirs
  docker_compose build aibroker-api
  docker_compose run --rm -T aibroker-api corepack pnpm db:migrate
}

seed_db() {
  require_cmd docker
  ensure_env
  ensure_data_dirs
  docker_compose build aibroker-api
  docker_compose run --rm -T aibroker-api corepack pnpm db:seed
}

setup_db() {
  require_cmd docker
  ensure_env
  ensure_data_dirs
  # Build once, then reuse the same image for both one-off commands. Compose starts
  # PostgreSQL and Redis when they are not already running.
  docker_compose build aibroker-api
  docker_compose run --rm -T aibroker-api corepack pnpm db:migrate
  docker_compose run --rm -T aibroker-api corepack pnpm db:seed
}

# ---------------------------------------------------------------------------
# Named WordPress test sites (targets for AIBroker), created with:
#   ./dev.sh run --wptest NAME [--port N]
# Each site is an isolated WordPress + MariaDB pair whose data lives in
# ./data/wptest/NAME, with access details written to config.txt.
# ---------------------------------------------------------------------------

wptest_sanitize_name() {
  local name="${1:-}"
  if [[ -z "$name" ]]; then
    echo "A name is required, e.g. ./dev.sh run --wptest wpserver1" >&2
    return 2
  fi
  if [[ ! "$name" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "Invalid name '$name'. Use letters, numbers, dashes, and underscores only." >&2
    return 2
  fi
  printf '%s' "$name"
}

wptest_paths() {
  local name="$1"
  WPT_NAME="$name"
  WPT_DIR="data/wptest/${name}"
  WPT_DB_DIR="${WPT_DIR}/db"
  WPT_HTML_DIR="${WPT_DIR}/html"
  WPT_CONFIG="${WPT_DIR}/config.txt"
  WPT_NET="aibroker-wptest-${name}"
  WPT_DB="aibroker-wptest-${name}-db"
  WPT_WP="aibroker-wptest-${name}-wp"
}

wptest_secret() {
  if have openssl; then
    openssl rand -hex 16
  else
    LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 32
    echo
  fi
}

wptest_host_ip() {
  # A host IP the AIBroker API container can reach (loopback is not reachable
  # from inside a container, so prefer a LAN/bridge address).
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [[ -n "$ip" ]]; then
    printf '%s' "$ip"
  else
    printf '127.0.0.1'
  fi
}

wptest_free_port() {
  local port="${1:-8090}"
  while (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; do
    exec 3>&- 2>/dev/null || true
    port=$((port + 1))
  done
  printf '%s' "$port"
}

wptest_wait_db() {
  local db="$1" i
  for i in $(seq 1 60); do
    if docker exec "$db" sh -c 'mariadb-admin ping -uroot -p"$MARIADB_ROOT_PASSWORD"' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Database container '$db' did not become ready" >&2
  return 1
}

wptest_wait_http() {
  local url="$1" i code
  for i in $(seq 1 90); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
    if [[ "$code" =~ ^[23] ]]; then
      return 0
    fi
    sleep 1
  done
  echo "WordPress at '$url' did not start responding" >&2
  return 1
}

wptest_wp_cli() {
  # Run wp-cli against the site's files and database over its docker network.
  # The image's wp-config.php reads DB settings from the environment at runtime
  # (getenv_docker), so the same WORDPRESS_DB_* vars must be passed here too.
  # Run as uid 33 (the WordPress container's www-data) so file writes line up.
  docker run --rm --network "$WPT_NET" \
    --user "33:33" -e HOME=/tmp \
    -e WORDPRESS_DB_HOST="$WPT_DB" \
    -e WORDPRESS_DB_NAME="$WPT_DB_NAME" \
    -e WORDPRESS_DB_USER="$WPT_DB_USER" \
    -e WORDPRESS_DB_PASSWORD="$WPT_DB_PW" \
    -v "${ROOT_DIR}/${WPT_HTML_DIR}:/var/www/html" \
    "$WPTEST_CLI_IMAGE" "$@"
}

wptest_configure_rest_routes() {
  # WordPress's default empty permalink structure serves the site HTML for /wp-json paths.
  # Configure and flush rewrite rules so the test site's advertised REST URL actually
  # returns JSON. Run this for fresh and reused sites so older fixtures self-repair.
  wptest_wp_cli wp rewrite structure '/%postname%/' --hard >/dev/null
}

wptest_print_config() {
  if [[ -f "$WPT_CONFIG" ]]; then
    wptest_ensure_config_wordpress_path
    wptest_ensure_config_connector_url
    cat "$WPT_CONFIG"
  else
    echo "(config.txt is missing at ${WPT_CONFIG})"
  fi
}

wptest_ensure_config_connector_url() {
  [[ -f "$WPT_CONFIG" ]] || return 0
  local port connector_url temp_config
  port="$(awk '/^Port:/{sub(/^Port:[[:space:]]*/,"");print;exit}' "$WPT_CONFIG")"
  [[ -n "$port" ]] || return 0
  connector_url="http://host.docker.internal:${port}"
  temp_config="${WPT_CONFIG}.tmp"
  awk -v connector_url="$connector_url" '
    /^\[/ { in_register=($0 == "[Register in AIBroker UI]    (UI: Sites -> Add site)") }
    /^AIBroker connector URL:/ {
      printf "AIBroker connector URL: %s\n", connector_url
      added_connector=1
      next
    }
    in_register && /^base_url:[[:space:]]/ {
      printf "base_url:               %s\n", connector_url
      next
    }
    { print }
    /^Browse from this host:/ && !added_connector {
      printf "AIBroker connector URL: %s\n", connector_url
      added_connector=1
    }
  ' "$WPT_CONFIG" > "$temp_config"
  mv "$temp_config" "$WPT_CONFIG"
}

wptest_ensure_config_wordpress_path() {
  [[ -f "$WPT_CONFIG" ]] || return 0
  grep -q '^wordpress_path:' "$WPT_CONFIG" && return 0

  local temp_config="${WPT_CONFIG}.tmp"
  awk -v wordpress_path="$WPTEST_WORDPRESS_PATH" '
    { print }
    /^base_url:[[:space:]]/ && !added {
      printf "wordpress_path:         %s\n", wordpress_path
      added=1
    }
    END {
      if (!added) {
        print ""
        print "[WordPress plugin]"
        printf "wordpress_path:         %s\n", wordpress_path
      }
    }
  ' "$WPT_CONFIG" > "$temp_config"
  mv "$temp_config" "$WPT_CONFIG"
}

wptest_state_port() {
  docker port "$WPT_WP" 80 2>/dev/null | head -n1 | sed 's/.*://'
}

wptest_fg_cleanup() {
  local code=$?
  set +e
  trap - INT TERM EXIT
  wptest_stop_containers "$WPT_FG_NAME"
  exit "$code"
}

wptest_stop_containers() {
  local name="$1"
  if [[ -z "$name" ]]; then
    echo "No WordPress test site name recorded for cleanup." >&2
    return 0
  fi
  wptest_paths "$name"
  echo
  echo "Stopping WordPress test site '${name}' (data preserved)..."
  docker stop "$WPT_WP" >/dev/null 2>&1 || true
  docker stop "$WPT_DB" >/dev/null 2>&1 || true
  echo "Stopped. Restart with: ./dev.sh run --wptest ${name}"
}

wptest_create() {
  require_cmd docker
  require_cmd curl

  local name port="" keep=""
  name="$(wptest_sanitize_name "${1:-}")" || return 2
  shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port)
        port="${2:-}"
        shift 2
        ;;
      --keep|--detach|-d)
        keep=1
        shift
        ;;
      *)
        echo "Unknown option for --wptest: $1" >&2
        return 2
        ;;
    esac
  done

  wptest_paths "$name"

  # Detect an existing site so re-runs reuse it instead of rebuilding.
  local existed="" was_running=""
  if docker inspect "$WPT_WP" >/dev/null 2>&1; then
    existed=1
    if [[ "$(docker inspect -f '{{.State.Running}}' "$WPT_WP" 2>/dev/null)" == "true" ]]; then
      was_running=1
    fi
  fi

  if [[ -n "$was_running" ]]; then
    # Already up (e.g. previously started with --keep); reuse it. The current
    # invocation still owns shutdown unless --keep was explicitly passed again.
    echo "WordPress test site '${name}' is already running; reusing it."
    echo
    wptest_print_config
  elif [[ -n "$existed" ]]; then
    echo "Starting existing WordPress test site '${name}'..."
    docker start "$WPT_DB" >/dev/null 2>&1 || true
    docker start "$WPT_WP" >/dev/null 2>&1 || true
    local sport
    sport="$(wptest_state_port)"
    if [[ -n "$sport" ]]; then
      wptest_wait_http "http://127.0.0.1:${sport}/" >/dev/null 2>&1 || true
    fi
    echo
    wptest_print_config
  else
    wptest_fresh_create "$name" "$port"
  fi

  # Record state so a caller that manages the site's lifetime itself (e.g. the
  # combined stack run) can stop it on exit and honor --keep.
  WPT_FG_NAME="$name"
  WPT_FG_WP="$WPT_WP"
  WPT_FG_DB="$WPT_DB"
  WPT_KEEP="${keep:-}"

  if [[ -n "${WPT_NOFG:-}" ]]; then
    # Caller brings the site up and owns the foreground/cleanup; just return.
    return 0
  fi

  if [[ -n "$keep" ]]; then
    echo
    echo "Leaving '${name}' running (--keep). Stop it with: ./dev.sh wptest-stop ${name}"
    return 0
  fi

  # Default: tie the site's lifetime to this script, like the main dev stack.
  trap wptest_fg_cleanup INT TERM EXIT
  echo
  echo "Test site '${name}' is running. Press Ctrl+C to stop it and exit."
  echo "(Add --keep to leave it running after the script exits.)"
  echo "------------------------------------------------------------"
  docker logs -f "$WPT_WP" 2>&1 || true
}

wptest_fresh_create() {
  local name="$1" port="$2"

  if [[ -z "$port" ]]; then
    port="$(wptest_free_port 8090)"
  fi

  local host_ip base_url
  host_ip="$(wptest_host_ip)"
  base_url="http://${host_ip}:${port}"

  local db_root_pw db_pw admin_pw admin_user admin_email db_name db_user
  db_root_pw="$(wptest_secret)"
  db_pw="$(wptest_secret)"
  admin_pw="$(wptest_secret)"
  admin_user="admin"
  admin_email="admin@example.com"
  db_name="wordpress"
  db_user="wordpress"

  # If the MariaDB data dir is already initialized but the containers are gone (this run
  # reached wptest_fresh_create), MariaDB will NOT re-seed the user password on a non-empty
  # data dir — it keeps the original. The generated password above would then mismatch
  # the data dir's grant and WordPress could not connect ("Error establishing a database
  # connection"). Reuse the persisted credentials from config.txt so the new containers
  # match the existing database (and skip the install steps below).
  local reuse=0
  if [[ -d "${WPT_DB_DIR}/mysql" ]]; then
    if [[ -f "$WPT_CONFIG" ]]; then
      local prev_db_pw prev_db_root_pw prev_admin_pw
      prev_db_pw="$(awk '/^\[Database/{f=1;next} /^\[/{f=0} f&&/^Password:/{sub(/^Password:[[:space:]]*/,"");print;exit}' "$WPT_CONFIG")"
      if [[ -n "$prev_db_pw" ]]; then
        db_pw="$prev_db_pw"
        prev_db_root_pw="$(awk '/^\[Database/{f=1;next} /^\[/{f=0} f&&/^Root password:/{sub(/^Root password:[[:space:]]*/,"");print;exit}' "$WPT_CONFIG")"
        db_root_pw="${prev_db_root_pw:-$(wptest_secret)}"
        prev_admin_pw="$(awk '/^\[WordPress admin login/{f=1;next} /^\[/{f=0} f&&/^Password:/{sub(/^Password:[[:space:]]*/,"");print;exit}' "$WPT_CONFIG")"
        admin_pw="${prev_admin_pw:-$(wptest_secret)}"
        reuse=1
        echo "Reusing existing database credentials from ${WPT_CONFIG} (database already initialized)."
      fi
    fi
    if [[ "$reuse" -ne 1 ]]; then
      echo "Database at ${WPT_DB_DIR} is initialized but ${WPT_CONFIG} is missing/unreadable;" >&2
      echo "cannot recover the original password. Resetting the database for a fresh install." >&2
      echo "(Use ./dev.sh wptest-rm ${name} to remove a site cleanly.)" >&2
      rm -rf "${WPT_DB_DIR:?}/".* "${WPT_DB_DIR:?}/"* 2>/dev/null || true
    fi
  fi

  # Globals so wptest_wp_cli can pass the same DB env the WordPress container uses.
  WPT_DB_NAME="$db_name"
  WPT_DB_USER="$db_user"
  WPT_DB_PW="$db_pw"

  mkdir -p "$WPT_DB_DIR" "${WPT_HTML_DIR}/wp-content/mu-plugins"

  # WordPress only allows REST application passwords over HTTPS by default. These are
  # throwaway HTTP test sites, so enable them via a must-use plugin. Write it through a
  # container (as root) so it succeeds even when a previous run chowned the tree to
  # www-data and the host user can no longer write into it.
  docker run --rm -i -v "${ROOT_DIR}/${WPT_HTML_DIR}:/var/www/html" alpine:3 \
    sh -c 'mkdir -p /var/www/html/wp-content/mu-plugins && cat > /var/www/html/wp-content/mu-plugins/aibroker-testconfig.php' <<'PHP'
<?php
/**
 * AIBroker local test helper.
 * Allows REST API application passwords over plain HTTP for throwaway local test sites
 * created by `./dev.sh run --wptest`. Never use this on a real site.
 */
add_filter('wp_is_application_passwords_available', '__return_true');

// The browser reaches this fixture through localhost while AIBroker containers use
// host.docker.internal. Keep redirects and REST routes on whichever safe local Host was
// used for the request instead of forcing the installation-time LAN address.
function aibroker_test_dynamic_url($pre) {
    if (empty($_SERVER['HTTP_HOST'])) {
        return $pre;
    }
    $host = preg_replace('/[^A-Za-z0-9.\-:\[\]]/', '', $_SERVER['HTTP_HOST']);
    return (is_ssl() ? 'https://' : 'http://') . $host;
}
add_filter('pre_option_home', 'aibroker_test_dynamic_url');
add_filter('pre_option_siteurl', 'aibroker_test_dynamic_url');
PHP

  echo "Creating docker network ${WPT_NET}..."
  docker network create "$WPT_NET" >/dev/null 2>&1 || true

  echo "Starting database ${WPT_DB}..."
  docker run -d --name "$WPT_DB" \
    --label "${WPTEST_LABEL}=1" --label "${WPTEST_LABEL}.name=${name}" --label "${WPTEST_LABEL}.role=db" \
    --network "$WPT_NET" \
    -e MARIADB_DATABASE="$db_name" \
    -e MARIADB_USER="$db_user" \
    -e MARIADB_PASSWORD="$db_pw" \
    -e MARIADB_ROOT_PASSWORD="$db_root_pw" \
    -v "${ROOT_DIR}/${WPT_DB_DIR}:/var/lib/mysql" \
    "$WPTEST_DB_IMAGE" >/dev/null

  wptest_wait_db "$WPT_DB"

  echo "Starting WordPress ${WPT_WP} on port ${port}..."
  docker run -d --name "$WPT_WP" \
    --label "${WPTEST_LABEL}=1" --label "${WPTEST_LABEL}.name=${name}" --label "${WPTEST_LABEL}.role=wp" \
    --network "$WPT_NET" \
    -e WORDPRESS_DB_HOST="$WPT_DB" \
    -e WORDPRESS_DB_NAME="$db_name" \
    -e WORDPRESS_DB_USER="$db_user" \
    -e WORDPRESS_DB_PASSWORD="$db_pw" \
    -e WORDPRESS_CONFIG_EXTRA="define('WP_ENVIRONMENT_TYPE', 'local');" \
    -p "${port}:80" \
    -v "${ROOT_DIR}/${WPT_HTML_DIR}:/var/www/html" \
    "$WPTEST_WP_IMAGE" >/dev/null

  echo "Waiting for WordPress to respond..."
  wptest_wait_http "http://127.0.0.1:${port}/"

  # The pre-seeded mu-plugin dir is host-owned; hand the tree back to www-data (uid 33)
  # so WordPress can write uploads and other runtime files.
  docker run --rm -v "${ROOT_DIR}/${WPT_HTML_DIR}:/var/www/html" alpine:3 \
    chown -R 33:33 /var/www/html >/dev/null 2>&1 || true

  if [[ "$reuse" -eq 1 ]]; then
    echo "Configuring WordPress REST routes..."
    wptest_configure_rest_routes
    echo "WordPress is already installed; skipping install and REST credential setup."
    echo
    echo "WordPress test site '${name}' is ready (reused existing data)."
    echo "Access/configuration details in ${WPT_CONFIG}"
    echo "------------------------------------------------------------"
    wptest_print_config
    return
  fi

  echo "Installing WordPress..."
  wptest_wp_cli wp core install \
    --url="$base_url" \
    --title="AIBroker Test ${name}" \
    --admin_user="$admin_user" \
    --admin_password="$admin_pw" \
    --admin_email="$admin_email" \
    --skip-email >/dev/null

  echo "Configuring WordPress REST routes..."
  wptest_configure_rest_routes

  echo "Creating REST application password..."
  local app_pw
  app_pw="$(wptest_wp_cli wp user application-password create "$admin_user" aibroker-rest --porcelain 2>/dev/null | tr -d '\r\n')"
  if [[ -z "$app_pw" ]]; then
    app_pw="(failed to create; run: ./dev.sh wptest-rm ${name} and retry)"
  fi

  wptest_write_config "$name" "$host_ip" "$port" "$base_url" \
    "$admin_user" "$admin_pw" "$admin_email" "$app_pw" \
    "$db_name" "$db_user" "$db_pw" "$db_root_pw"

  echo
  echo "WordPress test site '${name}' is ready."
  echo "Access/configuration details written to ${WPT_CONFIG}"
  echo "------------------------------------------------------------"
  cat "$WPT_CONFIG"
}

wptest_write_config() {
  local name="$1" host_ip="$2" port="$3" base_url="$4" \
    admin_user="$5" admin_pw="$6" admin_email="$7" app_pw="$8" \
    db_name="$9" db_user="${10}" db_pw="${11}" db_root_pw="${12}"

  local connector_url="http://host.docker.internal:${base_url##*:}"
  cat > "$WPT_CONFIG" <<EOF
# AIBroker test WordPress site: ${name}
# Generated by \`./dev.sh run --wptest ${name}\` on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# THROWAWAY TEST SITE - do not store real data or credentials here.

[Access]
Site URL (base_url):    ${base_url}
Browse from this host:  http://localhost:${port}
AIBroker connector URL: ${connector_url}
Host IP:                ${host_ip}
Port:                   ${port}
REST API base:          ${base_url}/wp-json

[WordPress admin login]
Login URL:              http://localhost:${port}/wp-admin
Username:               ${admin_user}
Password:               ${admin_pw}
Email:                  ${admin_email}

[AIBroker REST credential]   (UI: Sites -> REST credential)
WordPress username:     ${admin_user}
Application password:    ${app_pw}

[Register in AIBroker UI]    (UI: Sites -> Add site)
name:                   ${name}
slug:                   ${name}
environment:            local
base_url:               ${connector_url}
wordpress_path:         ${WPTEST_WORDPRESS_PATH}

[Database (MariaDB container)]
Container:              ${WPT_DB}
Database:               ${db_name}
Username:               ${db_user}
Password:               ${db_pw}
Root password:          ${db_root_pw}

[Containers and data]
WordPress container:    ${WPT_WP}
Docker network:         ${WPT_NET}
Data directory:         ./${WPT_DIR}
  WordPress files:      ./${WPT_HTML_DIR}
  Database files:       ./${WPT_DB_DIR}

[Manage]
Stop (keep data):       ./dev.sh wptest-stop ${name}
Remove (delete data):   ./dev.sh wptest-rm ${name}
List sites:             ./dev.sh wptest-list
EOF
}

wptest_list() {
  require_cmd docker
  echo "WordPress test sites (containers):"
  docker ps -a \
    --filter "label=${WPTEST_LABEL}.role=wp" \
    --format 'table {{.Label "'"${WPTEST_LABEL}"'.name"}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || true
  echo
  if [[ -d data/wptest ]]; then
    echo "Data directories under ./data/wptest:"
    ls -1 data/wptest 2>/dev/null | sed 's/^/  /' || true
  fi
}

wptest_stop() {
  require_cmd docker
  local name
  name="$(wptest_sanitize_name "${1:-}")" || return 2
  wptest_paths "$name"
  wptest_stop_containers "$name"
}

wptest_remove() {
  require_cmd docker
  local name
  name="$(wptest_sanitize_name "${1:-}")" || return 2
  wptest_paths "$name"
  echo "Removing WordPress test site '${name}' and its data..."
  docker rm -f "$WPT_WP" >/dev/null 2>&1 || true
  docker rm -f "$WPT_DB" >/dev/null 2>&1 || true
  docker network rm "$WPT_NET" >/dev/null 2>&1 || true
  # Data files are owned by container users; fall back to a container to delete them.
  if ! rm -rf "$WPT_DIR" 2>/dev/null; then
    docker run --rm -v "${ROOT_DIR}/data/wptest:/wptest" alpine:3 rm -rf "/wptest/${name}" >/dev/null 2>&1 || true
  fi
  echo "Removed."
}

case "${1:-help}" in
  deps-status|status)
    deps_status
    ;;
  deps-install|install|update)
    deps_install
    ;;
  run)
    shift
    if [[ "${1:-}" == "--wptest" ]]; then
      shift
      run_stack_and_wptest "$@"
    else
      run_stack
    fi
    ;;
  wptest-list)
    wptest_list
    ;;
  wptest-stop)
    wptest_stop "${2:-}"
    ;;
  wptest-rm|wptest-remove)
    wptest_remove "${2:-}"
    ;;
  build)
    build_images
    ;;
  run-image|run-images)
    run_images
    ;;
  test)
    run_tests
    ;;
  migrate)
    migrate_db
    ;;
  seed)
    seed_db
    ;;
  db-setup|setup-db)
    setup_db
    ;;
  down|stop)
    require_cmd docker
    docker_compose down
    ;;
  logs)
    require_cmd docker
    docker_compose logs -f
    ;;
  backup)
    ./scripts/backup-postgres.sh
    ;;
  k3s-smoke)
    ./scripts/k3s-smoke.sh
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "Unknown command: $1" >&2
    echo >&2
    usage >&2
    exit 2
    ;;
esac
