#!/bin/sh
# End-to-end demonstration of the plan section 8 checklist, through the public API only.
# Needs the stack running (make up), curl and jq. `make demo` wipes volumes and bootstraps first.
# Exits non-zero at the first failed check.
set -eu
cd "$(dirname "$0")/../.."
[ -f .env ] && . ./.env
API=http://127.0.0.1:${HOST_PORT_API:-3000}
GC=http://127.0.0.1:${HOST_PORT_GC:-3104}
OWNER="demo-$(date +%s)"
TMP=$(mktemp -d)
RESTORE=0
# Put canvas-api and gc-worker back on the normal grace periods, even after a failure.
cleanup() {
  rm -rf "$TMP"
  [ "$RESTORE" = 1 ] && docker compose up -d --wait --no-deps canvas-api gc-worker >/dev/null 2>&1
  return 0
}
trap cleanup EXIT

pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*"; exit 1; }
psql_q() { docker compose exec -T postgres psql -U "${POSTGRES_USER:-canvas}" -tA -c "$1"; }

# api METHOD PATH [JSON] [owner] [extra curl args...] -> body in $TMP/body, status in $CODE
api() {
  m=$1; p=$2; b=${3:-}; o=${4:-$OWNER}
  if [ -n "$b" ]; then
    CODE=$(curl -s -o "$TMP/body" -w '%{http_code}' -X "$m" "$API$p" -H "X-Owner-Id: $o" -H 'Content-Type: application/json' ${IDEM:+-H "Idempotency-Key: $IDEM"} -d "$b")
  else
    CODE=$(curl -s -o "$TMP/body" -w '%{http_code}' -X "$m" "$API$p" -H "X-Owner-Id: $o" ${IDEM:+-H "Idempotency-Key: $IDEM"})
  fi
}
field() { jq -r "$1" "$TMP/body"; }
expect_code() { [ "$CODE" = "$1" ] || { cat "$TMP/body"; echo; fail "$2: expected HTTP $1, got $CODE"; }; }

ctype() { case "$1" in *.png) echo image/png ;; *.jpg) echo image/jpeg ;; *.webp) echo image/webp ;; *.mp4) echo video/mp4 ;; esac; }

# upload OWNER FILE -> prints asset id; waits until READY
upload() {
  o=$1; f=$2; path=fixtures/$f; ct=$(ctype "$f")
  api POST /v1/uploads "{\"sha256\":\"$(sha256sum "$path" | cut -d' ' -f1)\",\"content_type\":\"$ct\",\"size_bytes\":$(stat -c%s "$path"),\"filename\":\"$f\"}" "$o"
  [ "$CODE" = 200 ] || fail "upload $f: HTTP $CODE"
  id=$(field .asset_id)
  if [ "$(field '.deduplicated // false')" != true ]; then
    curl -sf -o /dev/null -X PUT "$(field .upload_url)" -H "Content-Type: $ct" --data-binary @"$path" || fail "PUT $f"
    curl -sf -o /dev/null -X POST "$API/v1/uploads/$id/complete" -H "X-Owner-Id: $o" || fail "complete $f"
  fi
  end=$(( $(date +%s) + 150 ))
  while :; do
    api GET "/v1/assets/$id" "" "$o"
    st=$(field .processing_status)
    [ "$st" = READY ] && break
    case "$st" in FAILED|REJECTED|EXPIRED) fail "$f ended $st" ;; esac
    [ "$(date +%s)" -gt "$end" ] && fail "$f still $st after 150s"
    sleep 1
  done
  echo "$id"
}

doc() { # doc SHIFT ID...   -> canvas JSON
  shift_=$1; shift
  els=""; i=0
  for id in "$@"; do els="$els${els:+,}{\"id\":\"e$i\",\"type\":\"media\",\"asset_id\":\"$id\",\"x\":$((shift_ + i)),\"y\":0,\"width\":100,\"height\":100}"; i=$((i + 1)); done
  echo "{\"version\":1,\"canvas\":{\"width\":1080,\"height\":1080},\"elements\":[$els]}"
}
jobs_n() { psql_q "select count(*) from processing_job j join media_asset a on a.id=j.asset_id where a.owner_id='$OWNER'"; }
retention() { psql_q "select retention_status from media_asset where id='$1'"; }
object_exists() { # asset id
  key=$(psql_q "select original_key from media_asset where id='$1'")
  docker compose exec -T -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_DEFAULT_REGION=us-east-1 localstack aws --endpoint-url http://localhost:4566 s3api head-object --bucket "${BUCKET_INGEST:-media-ingest-poc}" --key "$key" >/dev/null 2>&1
}

echo "== Demo as owner $OWNER =="

# 1. Upload mix
IMG1=$(upload "$OWNER" sample-1.png); IMG2=$(upload "$OWNER" sample-2.jpg); IMG3=$(upload "$OWNER" sample-3.webp)
IMG4=$(upload "$OWNER" sample-4.png); IMG5=$(upload "$OWNER" sample-5.jpg); VID=$(upload "$OWNER" sample.mp4)
[ "$(psql_q "select count(*) from media_rendition r join media_asset a on a.id=r.asset_id where a.owner_id='$OWNER' and r.tier='FINAL'")" = 0 ] || fail "final renditions exist after upload"
pass "upload mix: 5 images + 1 video READY, zero final-tier work"

# 2. Dedup
n=$(jobs_n); again=$(upload "$OWNER" sample-1.png)
[ "$again" = "$IMG1" ] && [ "$(jobs_n)" = "$n" ] || fail "dedup: same owner got a new asset or new jobs"
other=$(upload "demo-other-$$" sample-1.png)
[ "$other" != "$IMG1" ] || fail "dedup crossed owners"
pass "owner-scoped dedup: same owner reuses the asset, another owner does not"

# 3. Draft, 20 saves without processing, optimistic concurrency
api POST /v1/drafts "{\"document\":$(doc 0 "$IMG1" "$IMG2" "$VID")}"; expect_code 201 "create draft A"
A=$(field .draft_id); n=$(jobs_n); head=1
for i in $(seq 1 20); do
  api PUT "/v1/drafts/$A" "{\"base_revision\":$head,\"document\":$(doc "$i" "$IMG1" "$IMG2" "$VID")}"; expect_code 200 "save $i"
  head=$(field .head_revision)
done
[ "$head" = 21 ] && [ "$(jobs_n)" = "$n" ] || fail "20 saves: head=$head, jobs changed"
pass "edit without processing: 20 revisions, no new media jobs"
api PUT "/v1/drafts/$A" "{\"base_revision\":3,\"document\":$(doc 99 "$IMG1")}"; expect_code 409 "stale save"
[ "$(field .code)" = REVISION_CONFLICT ] || fail "stale save code $(field .code)"
pass "optimistic concurrency: stale save returns 409 REVISION_CONFLICT"

# 4. Mock AI
api POST "/v1/drafts/$A/ai-layouts" "{\"asset_ids\":[\"$IMG1\",\"$IMG2\"],\"seed\":7}"; GEN=$(field .generation_id)
end=$(( $(date +%s) + 30 ))
while :; do api GET "/v1/ai-layouts/$GEN"; [ "$(field .status)" = READY ] && break; [ "$(date +%s)" -gt "$end" ] && fail "AI layout not READY"; sleep 1; done
for id in $(jq -r '.. | .asset_id? // empty' "$TMP/body" | sort -u); do [ "$id" = "$IMG1" ] || [ "$id" = "$IMG2" ] || fail "AI layout references unknown asset $id"; done
n=$(jobs_n)
api POST "/v1/drafts/$A/ai-layouts" "{\"asset_ids\":[\"$IMG1\",\"$IMG2\"],\"seed\":7}"
[ "$(field .cached)" = true ] && [ "$(jobs_n)" = "$n" ] || fail "AI repeat was not served from cache"
api POST "/v1/drafts/$A/ai-layouts/$GEN/accept" '{"base_revision":21}'; expect_code 200 "accept AI layout"
[ "$(field .revision.source)" = AI_GENERATION ] || fail "accepted layout is not an AI_GENERATION revision"
pass "mock AI: known assets only, repeat cached, accepted result is revision 22"

# 5. Publish: draft with the image + video
api POST /v1/drafts "{\"document\":$(doc 0 "$IMG5" "$VID")}"; C=$(field .draft_id)
IDEM="demo-$OWNER"; export IDEM
api POST "/v1/drafts/$C/publications" '{"revision":1}'; PUB=$(field .publication_id); [ -n "$PUB" ] && [ "$PUB" != null ] || fail "publish: $(cat "$TMP/body")"
api POST "/v1/drafts/$C/publications" '{"revision":1}'
[ "$(field .publication_id)" = "$PUB" ] || fail "same key returned another publication"
IDEM="other-$OWNER" api POST "/v1/drafts/$C/publications" '{"revision":1}'; expect_code 409 "second publish with another key"
unset IDEM
pass "publish idempotency: same key same publication, other key rejected"

end=$(( $(date +%s) + 120 ))
while :; do st=$(psql_q "select status from publication where id='$PUB'"); [ "$st" = AWAITING_CANVAS ] && break; [ "$st" = FAILED ] && fail "publication FAILED"; [ "$(date +%s)" -gt "$end" ] && fail "stuck in $st"; sleep 1; done
api POST "/v1/publications/$PUB/canvas-upload" "{\"content_type\":\"image/png\",\"size_bytes\":$(stat -c%s fixtures/canvas-render.png)}"; expect_code 200 "canvas-upload"
curl -sf -o /dev/null -X PUT "$(field .upload_url)" -H "Content-Type: image/png" --data-binary @fixtures/canvas-render.png || fail "PUT canvas"
api POST "/v1/publications/$PUB/canvas-uploaded" '{"content_type":"image/png"}'; expect_code 202 "canvas-uploaded"
end=$(( $(date +%s) + 60 ))
while :; do st=$(psql_q "select status from publication where id='$PUB'"); [ "$st" = LIVE ] && break; [ "$st" = FAILED ] && fail "publication FAILED"; [ "$(date +%s)" -gt "$end" ] && fail "stuck in $st"; sleep 1; done
api GET "/v1/publications/$PUB"
curl -sf "$(field .manifest_url)" | jq -e ".publication_id == \"$PUB\"" >/dev/null || fail "manifest missing or wrong"
[ "$(field '.finals | length')" = 1 ] || fail "expected one mock final video"
pass "publish: mock final, canvas uploaded, manifest written, publication LIVE"

# 6. Cross-draft reuse, discard and restore
api POST /v1/drafts "{\"document\":$(doc 0 "$IMG1")}"; B=$(field .draft_id)
api DELETE "/v1/drafts/$A"; expect_code 200 "discard A"
api POST "/v1/drafts/$A/restore"; expect_code 200 "restore A"
[ "$(field .head_revision)" = 22 ] || fail "restored draft lost revisions"
pass "discard and restore within grace: revisions and media intact, no re-upload"

# 7. GC with short graces
echo "-- restarting canvas-api and gc-worker with 1s grace periods"
RESTORE=1
DRAFT_PURGE_GRACE_SECONDS=1 GC_ORPHAN_GRACE_SECONDS=1 GC_UNATTACHED_GRACE_SECONDS=1 GC_REVISION_KEEP_LAST=1000 GC_REVISION_MIN_AGE_SECONDS=0 \
  docker compose up -d --wait --no-deps canvas-api gc-worker >/dev/null 2>&1 || fail "could not restart services"
api DELETE "/v1/drafts/$A"; expect_code 200 "discard A for purge"
# A cycle handles at most GC_BATCH_SIZE rows per step, and it covers every owner, so on a used
# database it can take several runs to reach this owner's assets. Run until they are gone.
n=0
while :; do
  sleep 2
  curl -sf -X POST "$GC/run" >/dev/null || fail "gc run"
  done_=1
  for id in $IMG2 $IMG3 $IMG4; do [ "$(retention "$id")" = DELETED ] || done_=0; done
  [ "$done_" = 1 ] && break
  n=$((n + 1)); [ "$n" -gt 40 ] && fail "GC did not delete this owner's unreferenced assets after $n runs"
done
# Scope of the assertions: this owner only (the GC ran on everything).
for id in $IMG2 $IMG3 $IMG4; do
  [ "$(retention "$id")" = DELETED ] || fail "asset $id should be DELETED, is $(retention "$id")"
  object_exists "$id" && fail "object of deleted asset $id still in S3"
done
for id in $IMG1 $IMG5 $VID; do
  case "$(retention "$id")" in REFERENCED|PUBLISHED) ;; *) fail "asset $id was $(retention "$id")" ;; esac
  object_exists "$id" || fail "object of live asset $id is gone"
done
api GET "/v1/drafts/$B"; expect_code 200 "draft B readable"
api GET "/v1/publications/$PUB"; [ "$(field .status)" = LIVE ] || fail "publication no longer LIVE"
api PUT "/v1/drafts/$B" "{\"base_revision\":1,\"document\":$(doc 0 "$IMG2")}"; expect_code 422 "reference to a deleted asset"
pass "GC: unreferenced media deleted, shared and published media intact, deleted asset cannot be referenced"

echo "Demo passed: $OWNER"
