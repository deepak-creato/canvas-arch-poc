#!/bin/sh
# Runs inside LocalStack after 01-buckets.sh. Safe to run repeatedly.
set -eu

# awslocal is deprecated; use the bundled aws CLI against the local endpoint
export AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1

# aws-cli 1.x ignores AWS_ENDPOINT_URL for some services (SQS went to queue.amazonaws.com), so pass it explicitly
aws() { command aws --endpoint-url "$AWS_ENDPOINT_URL" "$@"; }

REGION=us-east-1
ACCOUNT=000000000000
INGEST="${BUCKET_INGEST:-media-ingest-poc}"
STAGING_PREFIX="${UPLOAD_STAGING_PREFIX:-staging/}"
MAX_RECEIVE="${SQS_MAX_RECEIVE_COUNT:-3}"
Q_LIGHT="${QUEUE_LIGHT_PROCESSING:-light-processing}"
Q_LIGHT_DLQ="${QUEUE_LIGHT_PROCESSING_DLQ:-light-processing-dlq}"
Q_AI="${QUEUE_AI_REQUESTS:-ai-requests}"
Q_AI_DLQ="${QUEUE_AI_REQUESTS_DLQ:-ai-requests-dlq}"
RULE=ingest-staging-created
RULE_ARN="arn:aws:events:$REGION:$ACCOUNT:rule/$RULE"

queue_arn() { echo "arn:aws:sqs:$REGION:$ACCOUNT:$1"; }

# create_queue NAME -> prints URL; creates only if missing
create_queue() {
  if url=$(aws sqs get-queue-url --queue-name "$1" --query QueueUrl --output text 2>/dev/null); then
    echo "queue exists: $1" >&2
  else
    url=$(aws sqs create-queue --queue-name "$1" --query QueueUrl --output text)
    echo "queue created: $1" >&2
  fi
  echo "$url"
}

# Attributes are always re-applied so a re-run converges.
# ensure_dlq NAME
ensure_dlq() {
  url=$(create_queue "$1")
  aws sqs set-queue-attributes --queue-url "$url" \
    --attributes '{"MessageRetentionPeriod":"1209600"}'
}

# ensure_main NAME DLQ_NAME VISIBILITY_SECONDS
ensure_main() {
  url=$(create_queue "$1")
  redrive=$(printf '{"deadLetterTargetArn":"%s","maxReceiveCount":"%s"}' "$(queue_arn "$2")" "$MAX_RECEIVE")
  python3 - "$url" "$3" "$redrive" <<'PY'
import json, os, subprocess, sys
url, visibility, redrive = sys.argv[1:4]
attrs = {"VisibilityTimeout": visibility, "RedrivePolicy": redrive}
subprocess.run(["aws", "--endpoint-url", os.environ["AWS_ENDPOINT_URL"], "sqs", "set-queue-attributes", "--queue-url", url,
                "--attributes", json.dumps(attrs)], check=True)
PY
}

ensure_dlq "$Q_LIGHT_DLQ"
ensure_dlq "$Q_AI_DLQ"
ensure_main "$Q_LIGHT" "$Q_LIGHT_DLQ" 120
ensure_main "$Q_AI" "$Q_AI_DLQ" 60

# S3 -> default EventBridge bus
aws s3api put-bucket-notification-configuration --bucket "$INGEST" \
  --notification-configuration '{"EventBridgeConfiguration":{}}'
echo "bucket notification: $INGEST -> EventBridge"

PATTERN=$(printf '{"source":["aws.s3"],"detail-type":["Object Created"],"detail":{"bucket":{"name":["%s"]},"object":{"key":[{"prefix":"%s"}]}}}' "$INGEST" "$STAGING_PREFIX")
aws events put-rule --name "$RULE" --event-pattern "$PATTERN" --state ENABLED >/dev/null
echo "rule: $RULE (prefix $STAGING_PREFIX)"

aws events put-targets --rule "$RULE" \
  --targets "Id=light-processing,Arn=$(queue_arn "$Q_LIGHT")" >/dev/null
echo "target: $Q_LIGHT"

# Allow EventBridge to send (not enforced by LocalStack; kept for AWS parity)
python3 - "$(aws sqs get-queue-url --queue-name "$Q_LIGHT" --query QueueUrl --output text)" "$(queue_arn "$Q_LIGHT")" "$RULE_ARN" <<'PY'
import json, os, subprocess, sys
url, arn, rule_arn = sys.argv[1:4]
policy = {"Version": "2012-10-17", "Statement": [{
    "Effect": "Allow", "Principal": {"Service": "events.amazonaws.com"},
    "Action": "sqs:SendMessage", "Resource": arn,
    "Condition": {"ArnEquals": {"aws:SourceArn": rule_arn}}}]}
subprocess.run(["aws", "--endpoint-url", os.environ["AWS_ENDPOINT_URL"], "sqs", "set-queue-attributes", "--queue-url", url,
                "--attributes", json.dumps({"Policy": json.dumps(policy)})], check=True)
PY

echo "queues and events ready"
