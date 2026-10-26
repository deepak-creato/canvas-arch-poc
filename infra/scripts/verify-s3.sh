#!/bin/sh
# POC-002 check: PUT/HEAD/GET/DELETE against each bucket in LocalStack.
set -eu
cd "$(dirname "$0")/../.."
[ -f .env ] && . ./.env

INGEST="${BUCKET_INGEST:-media-ingest-poc}"
DERIVED="${BUCKET_DERIVED:-media-derived-poc}"
PUBLISHED="${BUCKET_PUBLISHED:-media-published-poc}"

# Whole check runs in one container shell; the init hook may finish after "healthy".
docker compose exec -T -e B_INGEST="$INGEST" -e B_DERIVED="$DERIVED" -e B_PUBLISHED="$PUBLISHED" localstack sh -eu -c '
export AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1

# aws-cli 1.x ignores AWS_ENDPOINT_URL for some services (SQS went to queue.amazonaws.com), so pass it explicitly
aws() { command aws --endpoint-url "$AWS_ENDPOINT_URL" "$@"; }
for b in "$B_INGEST" "$B_DERIVED" "$B_PUBLISHED"; do
  i=0
  until aws s3api head-bucket --bucket "$b" >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -gt 30 ] && { echo "FAIL $b: bucket missing"; exit 1; }
    sleep 1
  done
done

listed=$(aws s3api list-buckets --query "Buckets[].Name" --output text)
for b in "$B_INGEST" "$B_DERIVED" "$B_PUBLISHED"; do
  case "$listed" in *"$b"*) ;; *) echo "FAIL $b: not in list-buckets"; exit 1;; esac
done

for b in "$B_INGEST" "$B_DERIVED" "$B_PUBLISHED"; do
  key="verify/$(date +%s%N)-$$.txt"
  body="poc-002-$b"
  printf "%s" "$body" > /tmp/up.txt
  aws s3api put-object --bucket "$b" --key "$key" --body /tmp/up.txt >/dev/null || { echo "FAIL $b: PUT"; exit 1; }
  aws s3api head-object --bucket "$b" --key "$key" >/dev/null || { echo "FAIL $b: HEAD"; exit 1; }
  aws s3api get-object --bucket "$b" --key "$key" /tmp/down.txt >/dev/null || { echo "FAIL $b: GET"; exit 1; }
  [ "$(cat /tmp/down.txt)" = "$body" ] || { echo "FAIL $b: GET content mismatch"; exit 1; }
  aws s3api delete-object --bucket "$b" --key "$key" >/dev/null || { echo "FAIL $b: DELETE"; exit 1; }
  if aws s3api head-object --bucket "$b" --key "$key" >/dev/null 2>&1; then
    echo "FAIL $b: object still present after DELETE"; exit 1
  fi
  echo "OK   $b: PUT HEAD GET DELETE"
done
'
