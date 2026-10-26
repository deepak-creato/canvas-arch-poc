#!/bin/sh
# POC-003 check: S3 -> EventBridge -> SQS routing, redrive config, retry -> DLQ.
set -eu
cd "$(dirname "$0")/../.."
[ -f .env ] && . ./.env

docker compose exec -T \
  -e B_INGEST="${BUCKET_INGEST:-media-ingest-poc}" \
  -e PREFIX="${UPLOAD_STAGING_PREFIX:-staging/}" \
  -e Q_LIGHT="${QUEUE_LIGHT_PROCESSING:-light-processing}" \
  -e Q_LIGHT_DLQ="${QUEUE_LIGHT_PROCESSING_DLQ:-light-processing-dlq}" \
  -e Q_AI="${QUEUE_AI_REQUESTS:-ai-requests}" \
  -e Q_AI_DLQ="${QUEUE_AI_REQUESTS_DLQ:-ai-requests-dlq}" \
  -e MAXRC="${SQS_MAX_RECEIVE_COUNT:-3}" \
  localstack sh -eu <<'INNER'
export AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1

# aws-cli 1.x ignores AWS_ENDPOINT_URL for some services (SQS went to queue.amazonaws.com), so pass it explicitly
aws() { command aws --endpoint-url "$AWS_ENDPOINT_URL" "$@"; }

fail() { echo "FAIL $*"; exit 1; }
qurl() { aws sqs get-queue-url --queue-name "$1" --query QueueUrl --output text; }

# Wait for init hook (may finish after the container is healthy)
i=0
until aws events describe-rule --name ingest-staging-created >/dev/null 2>&1 \
  && qurl "$Q_LIGHT" >/dev/null 2>&1 && qurl "$Q_AI" >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -gt 30 ] && fail "provisioning not ready (rule/queues missing)"
  sleep 1
done

LIGHT=$(qurl "$Q_LIGHT")

# find_message URL SUBSTRING SECONDS -> prints receipt handle of first message containing SUBSTRING
find_message() {
  end=$(( $(date +%s) + $3 ))
  while [ "$(date +%s)" -le "$end" ]; do
    out=$(aws sqs receive-message --queue-url "$1" --max-number-of-messages 10 --wait-time-seconds 2 \
      --visibility-timeout 30 --output json || true)
    handle=$(printf '%s' "$out" | python3 -c '
import json, sys
needle = sys.argv[1]
raw = sys.stdin.read().strip()
for m in (json.loads(raw).get("Messages", []) if raw else []):
    if needle in m["Body"]:
        print(m["ReceiptHandle"]); break
' "$2")
    [ -n "$handle" ] && { echo "$handle"; return 0; }
  done
  return 1
}

# 1. Routing: staging prefix reaches light-processing with the right payload
id="$(date +%s%N)-$$"
key="${PREFIX}verify/$id"
printf 'x' > /tmp/obj.txt
aws s3api put-object --bucket "$B_INGEST" --key "$key" --body /tmp/obj.txt >/dev/null
handle=$(find_message "$LIGHT" "$key" 20) || fail "no event on $Q_LIGHT for $key"
body=$(aws sqs receive-message --queue-url "$LIGHT" --max-number-of-messages 1 --visibility-timeout 0 --output json 2>/dev/null || true)
aws sqs delete-message --queue-url "$LIGHT" --receipt-handle "$handle"
echo "OK   routing: $key reached $Q_LIGHT"
aws s3api delete-object --bucket "$B_INGEST" --key "$key" >/dev/null

# 2. Payload shape: re-send nothing; check via a second object so we can read the body
key2="${PREFIX}verify/shape-$id"
aws s3api put-object --bucket "$B_INGEST" --key "$key2" --body /tmp/obj.txt >/dev/null
end=$(( $(date +%s) + 20 )); shape=""
while [ "$(date +%s)" -le "$end" ] && [ -z "$shape" ]; do
  out=$(aws sqs receive-message --queue-url "$LIGHT" --max-number-of-messages 10 --wait-time-seconds 2 \
    --visibility-timeout 30 --output json || true)
  shape=$(printf '%s' "$out" | python3 -c '
import json, sys
needle = sys.argv[1]
raw = sys.stdin.read().strip()
for m in (json.loads(raw).get("Messages", []) if raw else []):
    if needle in m["Body"]:
        e = json.loads(m["Body"])
        ok = e.get("detail-type") == "Object Created" and e["detail"]["bucket"]["name"] == sys.argv[2] and e["detail"]["object"]["key"] == needle
        print("ok" if ok else "bad:" + m["Body"][:200]); break
' "$key2" "$B_INGEST")
done
[ "$shape" = "ok" ] || fail "payload shape wrong or missing: $shape"
echo "OK   payload: detail-type, bucket and key correct"
aws s3api delete-object --bucket "$B_INGEST" --key "$key2" >/dev/null

# 3. Negative: object outside the staging prefix is not routed
nkey="other/verify/$id"
aws s3api put-object --bucket "$B_INGEST" --key "$nkey" --body /tmp/obj.txt >/dev/null
if find_message "$LIGHT" "$nkey" 6 >/dev/null; then fail "object outside $PREFIX was routed: $nkey"; fi
aws s3api delete-object --bucket "$B_INGEST" --key "$nkey" >/dev/null
echo "OK   filter: $nkey not routed"

# 4. Redrive config on the real queues
check_redrive() {
  rp=$(aws sqs get-queue-attributes --queue-url "$(qurl "$1")" --attribute-names RedrivePolicy \
    --query Attributes.RedrivePolicy --output text)
  printf '%s' "$rp" | python3 -c '
import json, sys
rp = json.loads(sys.stdin.read())
assert rp["deadLetterTargetArn"].endswith(":" + sys.argv[1]), rp
assert int(rp["maxReceiveCount"]) == int(sys.argv[2]), rp
' "$2" "$MAXRC" || fail "redrive policy wrong on $1"
  echo "OK   redrive: $1 -> $2 (maxReceiveCount $MAXRC)"
}
check_redrive "$Q_LIGHT" "$Q_LIGHT_DLQ"
check_redrive "$Q_AI" "$Q_AI_DLQ"

# 5. Retry then DLQ, on a temporary pair so live workers cannot interfere
T="poc-verify-$$"
TD=$(aws sqs create-queue --queue-name "$T-dlq" --query QueueUrl --output text)
TDARN=arn:aws:sqs:us-east-1:000000000000:$T-dlq
TQ=$(aws sqs create-queue --queue-name "$T" --query QueueUrl --output text)
python3 - "$TQ" "$TDARN" "$MAXRC" <<'PY'
import json, os, subprocess, sys
url, arn, n = sys.argv[1:4]
attrs = {"VisibilityTimeout": "1", "RedrivePolicy": json.dumps({"deadLetterTargetArn": arn, "maxReceiveCount": n})}
subprocess.run(["aws", "--endpoint-url", os.environ["AWS_ENDPOINT_URL"], "sqs", "set-queue-attributes", "--queue-url", url, "--attributes", json.dumps(attrs)], check=True)
PY
cleanup() { aws sqs delete-queue --queue-url "$TQ" >/dev/null 2>&1 || true; aws sqs delete-queue --queue-url "$TD" >/dev/null 2>&1 || true; }
trap cleanup EXIT
aws sqs send-message --queue-url "$TQ" --message-body "poison-$id" >/dev/null
n=0
while [ "$n" -lt "$MAXRC" ]; do
  got=$(aws sqs receive-message --queue-url "$TQ" --wait-time-seconds 3 --query 'length(Messages || `[]`)' --output text)
  [ "$got" = "1" ] || fail "retry: expected redelivery #$((n+1)), got $got"
  n=$((n+1)); sleep 2
done
echo "OK   retry: message redelivered $MAXRC times after visibility timeout"
aws sqs receive-message --queue-url "$TQ" --wait-time-seconds 1 >/dev/null 2>&1 || true
end=$(( $(date +%s) + 15 )); moved=0
while [ "$(date +%s)" -le "$end" ] && [ "$moved" != "1" ]; do
  moved=$(aws sqs receive-message --queue-url "$TD" --wait-time-seconds 2 --visibility-timeout 0 \
    --query 'length(Messages || `[]`)' --output text)
done
[ "$moved" = "1" ] || fail "message did not reach the DLQ after $MAXRC receives"
echo "OK   dlq: poisoned message moved to DLQ after $MAXRC receives"
INNER
