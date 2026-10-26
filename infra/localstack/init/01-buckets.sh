#!/bin/sh
# Runs inside LocalStack once services are ready. Safe to run repeatedly.
set -eu

INGEST="${BUCKET_INGEST:-media-ingest-poc}"
DERIVED="${BUCKET_DERIVED:-media-derived-poc}"
PUBLISHED="${BUCKET_PUBLISHED:-media-published-poc}"

CORS='{"CORSRules":[{"AllowedOrigins":["*"],"AllowedMethods":["PUT","GET","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3000}]}'

for b in "$INGEST" "$DERIVED" "$PUBLISHED"; do
  if awslocal s3api head-bucket --bucket "$b" >/dev/null 2>&1; then
    echo "bucket exists: $b"
  else
    awslocal s3api create-bucket --bucket "$b" >/dev/null
    echo "bucket created: $b"
  fi
done

# Browser/test-client presigned uploads and reads
for b in "$INGEST" "$PUBLISHED"; do
  awslocal s3api put-bucket-cors --bucket "$b" --cors-configuration "$CORS"
done

echo "buckets ready"
