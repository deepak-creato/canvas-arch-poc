#!/bin/sh
# One-shot health report across containers, LocalStack, Postgres, Redis, API, buckets, queues and migrations.
set -u
cd "$(dirname "$0")/../.."
[ -f .env ] && { set -a; . ./.env; set +a; }

fails=0
check() { # check LABEL COMMAND...
  label=$1; shift
  if "$@" >/dev/null 2>&1; then echo "OK   $label"; else echo "FAIL $label"; fails=$((fails+1)); fi
}
ls_exec() { docker compose exec -T localstack "$@"; }
aws_l() { ls_exec env AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1 aws --endpoint-url http://localhost:4566 "$@"; }

# Containers: running and healthy
for s in $(docker compose config --services); do
  [ "$s" = migrate ] && continue
  st=$(docker compose ps "$s" --format '{{.Health}}' 2>/dev/null)
  check "container $s healthy" test "$st" = healthy
done
mig=$(docker compose ps -a migrate --format '{{.ExitCode}}' 2>/dev/null)
check "container migrate exited 0" test "$mig" = 0

# LocalStack services
for svc in s3 sqs events stepfunctions sts; do
  check "localstack $svc" sh -c "docker compose exec -T localstack python3 -c \"import json,sys,urllib.request as u;s=json.load(u.urlopen('http://localhost:4566/_localstack/health'))['services'];sys.exit(0 if s.get('$svc') in ('available','running') else 1)\""
done

# Data stores and API
check "postgres select 1" docker compose exec -T postgres psql -U "${POSTGRES_USER:-canvas}" -d "${POSTGRES_DB:-canvas}" -tAc 'select 1'
check "redis PONG" sh -c 'docker compose exec -T redis redis-cli ping | grep -q PONG'
check "canvas-api /healthz" docker compose exec -T canvas-api wget -qO- http://127.0.0.1:3000/healthz
check "mock-transcoder /healthz" docker compose exec -T mock-transcoder wget -qO- http://127.0.0.1:3103/healthz
check "gc-worker /healthz" docker compose exec -T gc-worker wget -qO- http://127.0.0.1:3104/healthz

# Provisioned resources
for b in "${BUCKET_INGEST:-media-ingest-poc}" "${BUCKET_DERIVED:-media-derived-poc}" "${BUCKET_PUBLISHED:-media-published-poc}"; do
  check "bucket $b" aws_l s3api head-bucket --bucket "$b"
done
for q in "${QUEUE_LIGHT_PROCESSING:-light-processing}" "${QUEUE_LIGHT_PROCESSING_DLQ:-light-processing-dlq}" \
         "${QUEUE_AI_REQUESTS:-ai-requests}" "${QUEUE_AI_REQUESTS_DLQ:-ai-requests-dlq}"; do
  check "queue $q" aws_l sqs get-queue-url --queue-name "$q"
done
n=$(docker compose exec -T postgres psql -U "${POSTGRES_USER:-canvas}" -d "${POSTGRES_DB:-canvas}" -tAc 'select count(*) from schema_migrations' 2>/dev/null)
expected=$(ls db/migrations/*.sql 2>/dev/null | wc -l)
check "migrations applied ($n of $expected)" test "$n" = "$expected"

if [ "$fails" -gt 0 ]; then echo "health: $fails check(s) failed"; exit 1; fi
echo "health: all ok"
