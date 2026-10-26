#!/bin/sh
# Runs inside LocalStack once services are ready. Safe to run repeatedly.
set -eu

# awslocal is deprecated; use the bundled aws CLI against the local endpoint
export AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1

# aws-cli 1.x ignores AWS_ENDPOINT_URL for some services (SQS went to queue.amazonaws.com), so pass it explicitly
aws() { command aws --endpoint-url "$AWS_ENDPOINT_URL" "$@"; }

INGEST="${BUCKET_INGEST:-media-ingest-poc}"
DERIVED="${BUCKET_DERIVED:-media-derived-poc}"
PUBLISHED="${BUCKET_PUBLISHED:-media-published-poc}"

CORS='{"CORSRules":[{"AllowedOrigins":["*"],"AllowedMethods":["PUT","GET","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3000}]}'

for b in "$INGEST" "$DERIVED" "$PUBLISHED"; do
  if aws s3api head-bucket --bucket "$b" >/dev/null 2>&1; then
    echo "bucket exists: $b"
  else
    aws s3api create-bucket --bucket "$b" >/dev/null
    echo "bucket created: $b"
  fi
done

# Browser/test-client presigned uploads and reads
for b in "$INGEST" "$PUBLISHED"; do
  aws s3api put-bucket-cors --bucket "$b" --cors-configuration "$CORS"
done

echo "buckets ready"
