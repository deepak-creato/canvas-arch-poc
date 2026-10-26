#!/bin/sh
# Checks everything that would make `make up` fail late or unclearly. Lists all problems.
set -u
cd "$(dirname "$0")/../.."

problems=0
bad() { echo "FAIL $*"; problems=$((problems+1)); }
ok() { echo "OK   $*"; }

# Docker and Compose
if ! command -v docker >/dev/null 2>&1; then
  bad "docker not found"
elif ! docker info >/dev/null 2>&1; then
  bad "docker daemon not reachable (is it running, and is your user in the docker group?)"
else
  ok "docker daemon reachable"
  cv=$(docker compose version --short 2>/dev/null || true)
  if [ -z "$cv" ]; then
    bad "docker compose v2 not found"
  else
    major=$(echo "${cv#v}" | cut -d. -f1); minor=$(echo "${cv#v}" | cut -d. -f2)
    if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 20 ]; }; then
      bad "docker compose $cv is too old (need 2.20 or newer for --wait with one-shot services)"
    else
      ok "docker compose $cv"
    fi
  fi
fi

# .env
if [ ! -f .env ]; then
  bad ".env missing (run: cp .env.example .env)"
else
  set -a; . ./.env; set +a
  for v in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION AWS_ENDPOINT_URL S3_PUBLIC_ENDPOINT \
           DATABASE_URL REDIS_URL BUCKET_INGEST BUCKET_DERIVED BUCKET_PUBLISHED \
           QUEUE_LIGHT_PROCESSING QUEUE_AI_REQUESTS LOCALSTACK_IMAGE_TAG; do
    eval "val=\${$v:-}"
    [ -n "$val" ] || bad ".env: $v is empty or missing"
  done
  if [ "${AWS_ACCESS_KEY_ID:-}" != "test" ] || [ "${AWS_SECRET_ACCESS_KEY:-}" != "test" ]; then
    bad ".env: AWS keys must be the fake value 'test' (this POC never uses real AWS credentials)"
  else
    ok "fake AWS credentials"
  fi
  # LocalStack 2026.x refuses to start without an auth token (a LocalStack account token, not an AWS credential)
  if [ -z "${LOCALSTACK_AUTH_TOKEN:-}" ]; then
    bad ".env: LOCALSTACK_AUTH_TOKEN is empty; LocalStack exits with 'License activation failed'. Get a token at https://app.localstack.cloud and put it in .env (never commit it)"
  else
    ok "LocalStack auth token set"
  fi

  # Host ports: free, or already ours
  if [ -n "$(docker compose ps -q 2>/dev/null)" ]; then
    ok "stack already running; skipping port check"
  else
    for pair in HOST_PORT_LOCALSTACK:4566 HOST_PORT_POSTGRES:5433 HOST_PORT_REDIS:6380 HOST_PORT_API:3000 HOST_PORT_TRANSCODER:3103; do
      var=${pair%%:*}; def=${pair##*:}
      eval "port=\${$var:-$def}"
      if ss -ltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]${port}\$"; then
        bad "host port $port is in use; set $var in .env to a free port"
      fi
    done
    [ "$problems" -eq 0 ] && ok "host ports free"
  fi
fi

if [ "$problems" -gt 0 ]; then
  echo "preflight: $problems problem(s)"
  exit 1
fi
echo "preflight: ok"
