#!/usr/bin/env bash
# Builds the compute worker snapshot (CLAUDE.md D14) through the hcloud HTTP API: a temporary Ubuntu 24.04
# server runs setup.sh, powers off, is snapshotted (label frostsim=worker-snapshot) and is always deleted.
# Usage: HCLOUD_TOKEN=... HCLOUD_LOCATION=fsn1 cloud/worker/build-snapshot.sh [--dry-run]
# Prints the snapshot id on stdout (use it as HCLOUD_SNAPSHOT_ID); progress goes to stderr.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dry=0
[ "${1:-}" = --dry-run ] && dry=1
: "${HCLOUD_LOCATION:?set HCLOUD_LOCATION, e.g. fsn1}"
[ "$dry" = 1 ] || : "${HCLOUD_TOKEN:?set HCLOUD_TOKEN}"
# The smallest dedicated-vCPU x86 type: the image then fits every larger CCX worker type.
type="${HCLOUD_BUILD_SERVER_TYPE:-ccx13}"
api=https://api.hetzner.cloud/v1
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

log() { echo "$*" >&2; }
# One canned answer carries every field the script reads, so a dry run walks the whole flow.
DRY_ANSWER='{"ssh_key":{"id":1},"server":{"id":2,"status":"off","public_net":{"ipv4":{"ip":"192.0.2.10"}}},"servers":[{"id":2}],"action":{"id":3,"status":"success"},"image":{"id":4},"images":[{"id":4}]}'
hcloud() { # method path [json body]
  if [ "$dry" = 1 ]; then log "DRY $1 $api$2 ${3:-}"; echo "$DRY_ANSWER"; return; fi
  local out retry=()
  # Only idempotent calls retry: a POST retried after a lost answer could make a second server or snapshot.
  case "$1" in GET|DELETE) retry=(--retry 3);; esac
  # The token reaches curl on stdin from printf, a builtin, so it is never in an argv that other local users can read.
  if ! out="$(printf 'Authorization: Bearer %s\n' "$HCLOUD_TOKEN" | curl -sS --fail-with-body --max-time 60 ${retry[@]+"${retry[@]}"} \
    -X "$1" -H @- -H 'Content-Type: application/json' ${3:+--data "$3"} "$api$2")"; then log "hcloud $1 $2 failed: $out"; return 1; fi
  echo "$out"
}
remote() { if [ "$dry" = 1 ]; then log "DRY $*"; else "$@"; fi; }
wait_action() { # action id
  for _ in $(seq 180); do
    status="$(hcloud GET "/actions/$1" | jq -r .action.status)"
    [ "$status" = success ] && return 0
    [ "$status" = error ] && { log "hcloud action $1 failed"; return 1; }
    sleep 5
  done
  log "hcloud action $1 timed out"; return 1
}

# Unique per build, and set before the trap: cleanup finds this build's server and snapshot by it.
name="frostsim-snapshot-$(date -u +%Y%m%d%H%M%S)"
tmp="$(mktemp -d)"
server_id='' key_id='' ok=0
cleanup() {
  local ids id
  # By name too: a create whose answer was lost, or an interrupt before server_id was set, still leaves a billed server.
  ids="$( { [ -n "$server_id" ] && echo "$server_id"; hcloud GET "/servers?name=$name" | jq -r '.servers[]?.id'; } | sort -u)" || true
  for id in $ids; do
    log "Deleting temporary server $id"
    hcloud DELETE "/servers/$id" >/dev/null || log "DELETE /servers/$id failed: delete it by hand"
  done
  [ -n "$key_id" ] && { hcloud DELETE "/ssh_keys/$key_id" >/dev/null || log "DELETE /ssh_keys/$key_id failed"; }
  # A failed build leaves no half-made snapshot. Found by label, so a lost create_image answer is covered as well.
  if [ "$ok" = 0 ]; then
    ids="$(hcloud GET "/images?type=snapshot&label_selector=frostsim-build%3D$name" | jq -r '.images[]?.id')" || true
    for id in $ids; do
      log "Deleting unfinished snapshot $id"
      hcloud DELETE "/images/$id" >/dev/null || log "DELETE /images/$id failed: delete it by hand"
    done
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

labels='{"frostsim":"snapshot-build"}'
# A throwaway key: the snapshot is cleaned of it, and workers take no inbound connections anyway.
ssh-keygen -q -t ed25519 -N '' -C "$name" -f "$tmp/key"
key_id="$(hcloud POST /ssh_keys "$(jq -nc --arg n "$name" --arg k "$(cat "$tmp/key.pub")" --argjson l "$labels" '{name:$n,public_key:$k,labels:$l}')" | jq -r .ssh_key.id)"
created="$(hcloud POST /servers "$(jq -nc --arg n "$name" --arg t "$type" --arg loc "$HCLOUD_LOCATION" --argjson k "$key_id" --argjson l "$labels" \
  '{name:$n,server_type:$t,image:"ubuntu-24.04",location:$loc,ssh_keys:[$k],labels:$l,start_after_create:true}')")"
server_id="$(jq -r .server.id <<<"$created")"
ip="$(jq -r .server.public_net.ipv4.ip <<<"$created")"
wait_action "$(jq -r .action.id <<<"$created")"
log "Temporary server $server_id at $ip"

# A fresh server's host key is unknown; trust it on first use for this build only.
ssh_opts=(-i "$tmp/key" -o "UserKnownHostsFile=$tmp/known_hosts" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes)
if [ "$dry" = 0 ]; then
  for _ in $(seq 60); do ssh "${ssh_opts[@]}" "root@$ip" true 2>/dev/null && break; sleep 5; done
fi
remote ssh "${ssh_opts[@]}" "root@$ip" 'cloud-init status --wait >/dev/null; mkdir -p /root/frostsim-worker'
remote scp "${ssh_opts[@]}" "$here/setup.sh" "$here/agent.mjs" "$here/frostsim-worker.service" "root@$ip:/root/frostsim-worker/"
# cloud-init clean makes each worker run its own user_data and regenerate host keys and machine id.
# The firewall setup.sh installs takes effect at each worker's first boot, not in this session.
remote ssh "${ssh_opts[@]}" "root@$ip" 'bash /root/frostsim-worker/setup.sh && rm -rf /root/frostsim-worker /root/.ssh/authorized_keys && cloud-init clean --logs --machine-id && sync'

wait_action "$(hcloud POST "/servers/$server_id/actions/shutdown" | jq -r .action.id)"
for _ in $(seq 60); do [ "$(hcloud GET "/servers/$server_id" | jq -r .server.status)" = off ] && break; sleep 5; done
[ "$(hcloud GET "/servers/$server_id" | jq -r .server.status)" = off ] || wait_action "$(hcloud POST "/servers/$server_id/actions/poweroff" | jq -r .action.id)"

image="$(hcloud POST "/servers/$server_id/actions/create_image" "$(jq -nc --arg d "frostsim worker $(date -u +%Y-%m-%d)" --arg n "$name" \
  '{type:"snapshot",description:$d,labels:{frostsim:"worker-snapshot","frostsim-build":$n}}')")"
wait_action "$(jq -r .action.id <<<"$image")"
ok=1
log "Snapshot ready; the temporary server is deleted on exit"
jq -r .image.id <<<"$image"
