#!/bin/sh
# POC-005 check: Step Functions features the publish workflow will need, on a temporary state machine.
set -eu
cd "$(dirname "$0")/../.."

ASL=$(cat infra/stepfunctions/smoke.asl.json)

docker compose exec -T -e ASL="$ASL" localstack sh -eu <<'INNER'
export AWS_ENDPOINT_URL=http://localhost:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_DEFAULT_REGION=us-east-1
aws() { command aws --endpoint-url "$AWS_ENDPOINT_URL" "$@"; }
fail() { echo "FAIL $*"; exit 1; }

acct=$(aws sts get-caller-identity --query Account --output text)
[ "$acct" = "000000000000" ] || fail "account is $acct, not the LocalStack account (refusing to continue)"
echo "OK   local account 000000000000 (not real AWS)"

n="poc-sfn-smoke-$$"
Q=$(aws sqs create-queue --queue-name "$n" --query QueueUrl --output text)
SM=""
cleanup() {
  [ -n "$SM" ] && aws stepfunctions delete-state-machine --state-machine-arn "$SM" >/dev/null 2>&1 || true
  aws sqs delete-queue --queue-url "$Q" >/dev/null 2>&1 || true
}
trap cleanup EXIT

DEF=$(printf '%s' "$ASL" | sed "s#__QUEUE_URL__#$Q#")
SM=$(aws stepfunctions create-state-machine --name "$n" --definition "$DEF" \
  --role-arn arn:aws:iam::000000000000:role/poc-sfn --query stateMachineArn --output text) \
  || fail "create-state-machine"
echo "OK   state machine created"

# run_exec NAME ACTION -> waits for the task token, answers it (success|failure), prints final status
run_exec() {
  ex=$(aws stepfunctions start-execution --state-machine-arn "$SM" --name "$1-$$" --query executionArn --output text)
  token=""; i=0
  while [ -z "$token" ] && [ "$i" -lt 30 ]; do
    msg=$(aws sqs receive-message --queue-url "$Q" --wait-time-seconds 2 --output json || true)
    token=$(printf '%s' "$msg" | python3 -c '
import json, sys
raw = sys.stdin.read().strip()
msgs = json.loads(raw).get("Messages", []) if raw else []
print(json.loads(msgs[0]["Body"])["token"] if msgs else "")')
    i=$((i+1))
  done
  [ -n "$token" ] || { echo "FAIL $1: no task token message arrived on the queue (waitForTaskToken integration)"; return 1; }
  if [ "$2" = success ]; then
    aws stepfunctions send-task-success --task-token "$token" --task-output '{"ok":true}'
  else
    aws stepfunctions send-task-failure --task-token "$token" --error PocError --cause smoke
  fi
  j=0; status=RUNNING
  while [ "$status" = RUNNING ] && [ "$j" -lt 30 ]; do
    sleep 1
    status=$(aws stepfunctions describe-execution --execution-arn "$ex" --query status --output text)
    j=$((j+1))
  done
  echo "$ex $status"
}

res=$(run_exec success success) || fail "success execution: $res"
exA=${res% *}; stA=${res##* }
[ "$stA" = SUCCEEDED ] || fail "success execution ended $stA"
states=$(aws stepfunctions get-execution-history --execution-arn "$exA" --output json | python3 -c '
import json, sys
ev = json.load(sys.stdin)["events"]
print(" ".join(e["stateEnteredEventDetails"]["name"] for e in ev if e["type"].endswith("StateEntered")))')
case "$states" in
  *Pause*FanOut*AwaitCallback*) ;;
  *) fail "history missing expected transitions: $states";;
esac
case "$states" in *Caught*) fail "success path went through Caught";; esac
echo "OK   callback success: Wait -> Parallel -> task token -> SUCCEEDED ($states)"

res=$(run_exec failure failure) || fail "failure execution: $res"
exB=${res% *}; stB=${res##* }
[ "$stB" = SUCCEEDED ] || fail "failure execution ended $stB (Catch not applied)"
aws stepfunctions get-execution-history --execution-arn "$exB" --output json | grep -q Caught \
  || fail "failure execution did not reach Caught"
echo "OK   callback failure: send-task-failure -> Catch -> Caught -> SUCCEEDED"
INNER
