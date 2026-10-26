#!/bin/sh
# Runs inside LocalStack after 02-queues-events.sh. Creates or updates the publish state machine. Safe to run repeatedly.
set -eu

export AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
aws() { command aws --endpoint-url "$AWS_ENDPOINT_URL" "$@"; }

NAME=canvas-publish
ROLE=arn:aws:iam::000000000000:role/poc-sfn
ASL=/opt/stepfunctions/publish.asl.json
Q_PUBLISH="${QUEUE_PUBLISH_TASKS:-publish-tasks}"
Q_TRANSCODE="${QUEUE_TRANSCODE_REQUESTS:-transcode-requests}"

PUBLISH_URL=$(aws sqs get-queue-url --queue-name "$Q_PUBLISH" --query QueueUrl --output text)
TRANSCODE_URL=$(aws sqs get-queue-url --queue-name "$Q_TRANSCODE" --query QueueUrl --output text)
DEF=$(sed -e "s#__PUBLISH_TASKS_URL__#$PUBLISH_URL#g" -e "s#__TRANSCODE_URL__#$TRANSCODE_URL#g" "$ASL")

ARN=$(aws stepfunctions list-state-machines --query "stateMachines[?name=='$NAME'].stateMachineArn | [0]" --output text)
if [ -n "$ARN" ] && [ "$ARN" != "None" ]; then
  aws stepfunctions update-state-machine --state-machine-arn "$ARN" --definition "$DEF" >/dev/null
  echo "state machine updated: $NAME"
else
  aws stepfunctions create-state-machine --name "$NAME" --definition "$DEF" --role-arn "$ROLE" >/dev/null
  echo "state machine created: $NAME"
fi
