#!/bin/sh
# M2 exit demo: upload 5 images + 1 video, wait until all six are usable, and show that
# no final-tier work happened. Needs the stack running (make up), curl and jq.
set -eu
cd "$(dirname "$0")/../.."
[ -f .env ] && . ./.env
API=http://127.0.0.1:${HOST_PORT_API:-3000}
OWNER="m2-demo-$(date +%s)"
fail() { echo "FAIL $*"; exit 1; }
psql_q() { docker compose exec -T postgres psql -U "${POSTGRES_USER:-canvas}" -tA -c "$1"; }

ids=""
for f in sample-1.png sample-2.jpg sample-3.webp sample-4.png sample-5.jpg sample.mp4; do
  case "$f" in
    *.png) ct=image/png ;; *.jpg) ct=image/jpeg ;; *.webp) ct=image/webp ;; *.mp4) ct=video/mp4 ;;
  esac
  path=fixtures/$f
  res=$(curl -sf -X POST "$API/v1/uploads" -H 'Content-Type: application/json' -H "X-Owner-Id: $OWNER" \
    -d "{\"sha256\":\"$(sha256sum "$path" | cut -d' ' -f1)\",\"content_type\":\"$ct\",\"size_bytes\":$(stat -c%s "$path"),\"filename\":\"$f\"}")
  id=$(echo "$res" | jq -r .asset_id)
  curl -sf -o /dev/null -X PUT "$(echo "$res" | jq -r .upload_url)" -H "Content-Type: $ct" --data-binary @"$path" \
    || fail "PUT $f"
  curl -sf -o /dev/null -X POST "$API/v1/uploads/$id/complete" -H "X-Owner-Id: $OWNER" || fail "complete $f"
  ids="$ids $id"
  echo "uploaded $f -> $id"
done

end=$(( $(date +%s) + 120 ))
for id in $ids; do
  while :; do
    st=$(curl -sf "$API/v1/assets/$id" -H "X-Owner-Id: $OWNER" | jq -r .processing_status)
    [ "$st" = READY ] && break
    case "$st" in FAILED|REJECTED|EXPIRED) fail "$id ended $st" ;; esac
    [ "$(date +%s)" -gt "$end" ] && fail "$id still $st after 120s"
    sleep 1
  done
  echo "OK   $id READY ($(curl -sf "$API/v1/assets/$id" -H "X-Owner-Id: $OWNER" | jq -r '[.renditions[].kind] | join(",")'))"
done

final=$(psql_q "select count(*) from media_rendition r join media_asset a on a.id=r.asset_id where a.owner_id='$OWNER' and r.tier='FINAL'")
[ "$final" = 0 ] || fail "found $final FINAL renditions"
echo "OK   no FINAL-tier renditions"
transcode=$(psql_q "select count(*) from processing_job j join media_asset a on a.id=j.asset_id where a.owner_id='$OWNER' and j.job_type ilike '%transcode%'")
[ "$transcode" = 0 ] || fail "found $transcode transcode jobs"
echo "OK   no transcode jobs"
echo "M2 exit demo passed: 5 images + 1 video usable"
