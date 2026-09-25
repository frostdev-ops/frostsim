#!/usr/bin/env bash
# Builds the EC2 compute worker image (CLAUDE.md D14), the counterpart of build-snapshot.sh: a temporary Ubuntu 24.04
# instance runs setup.sh from its user data (no SSH, so the no-inbound worker security group works), cleans cloud-init
# and powers off; the stopped instance becomes an AMI tagged frostsim=worker-image and is always terminated.
# Usage: AWS_REGION=us-east-1 AWS_SUBNET=subnet-... AWS_SECURITY_GROUP_ID=sg-... cloud/worker/build-ami.sh
# Uses the caller's own AWS CLI credentials, not the account server's (which may only launch frostsim=worker instances).
# Prints the AMI id on stdout (use it as AWS_AMI_ID); progress goes to stderr.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
: "${AWS_REGION:?set AWS_REGION, e.g. us-east-1}"
: "${AWS_SUBNET:?set AWS_SUBNET to a subnet id}"
: "${AWS_SECURITY_GROUP_ID:?set AWS_SECURITY_GROUP_ID}"
# x86 and small: the image fits every worker type in AWS_INSTANCE_TYPES. On-demand, a few minutes.
type="${AWS_BUILD_INSTANCE_TYPE:-c7a.large}"
export AWS_REGION
log() { echo "$*" >&2; }

name="frostsim-ami-$(date -u +%Y%m%d%H%M%S)"
tmp="$(mktemp -d)"
instance='' image='' ok=0
cleanup() {
  # Tagged frostsim=ami-build, never frostsim=worker, so the autoscaler does not reap it as an orphan meanwhile.
  [ -n "$instance" ] && { log "Terminating build instance $instance"; aws ec2 terminate-instances --instance-ids "$instance" >/dev/null \
    || log "terminate $instance failed: terminate it by hand"; }
  [ "$ok" = 0 ] && [ -n "$image" ] && { log "Deregistering unfinished image $image"; aws ec2 deregister-image --image-id "$image" \
    || log "deregister $image failed"; }
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

base="$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query Parameter.Value --output text)"
log "Base image $base (Ubuntu 24.04)"

# The worker files ride in the user data as a gzipped tarball. The console carries the result marker.
{
  echo '#!/bin/bash'
  echo 'exec > >(tee /dev/console) 2>&1'
  echo 'mkdir -p /root/frostsim-worker && cd /root/frostsim-worker'
  echo "base64 -d <<'TARBALL' | tar -xz"
  tar -C "$here" -cf - agent.mjs setup.sh frostsim-worker.service | gzip -9 | base64
  echo 'TARBALL'
  # cloud-init clean makes each worker run its own user data and regenerate host keys and machine id.
  echo 'if bash setup.sh; then result=OK; else result=FAILED; fi'
  echo 'cd / && rm -rf /root/frostsim-worker && cloud-init clean --logs --machine-id && sync'
  echo 'echo "FROSTSIM-IMAGE-$result"'
  echo 'shutdown -h now'
} > "$tmp/user-data"
size="$(wc -c < "$tmp/user-data")"
[ "$size" -le 16384 ] || { log "User data is $size bytes; EC2 allows 16384"; exit 1; }

instance="$(aws ec2 run-instances --image-id "$base" --instance-type "$type" --subnet-id "$AWS_SUBNET" \
  --security-group-ids "$AWS_SECURITY_GROUP_ID" --user-data "file://$tmp/user-data" \
  --instance-initiated-shutdown-behavior stop --metadata-options HttpTokens=required \
  --tag-specifications "ResourceType=instance,Tags=[{Key=frostsim,Value=ami-build},{Key=Name,Value=$name}]" \
  --query 'Instances[0].InstanceId' --output text)"
log "Build instance $instance ($type); waiting for setup.sh to finish and power off"

for _ in $(seq 120); do
  state="$(aws ec2 describe-instances --instance-ids "$instance" --query 'Reservations[0].Instances[0].State.Name' --output text)"
  [ "$state" = stopped ] && break
  sleep 10
done
[ "$state" = stopped ] || { log "Build instance did not stop within 20 minutes (state $state)"; exit 1; }

console="$(aws ec2 get-console-output --instance-id "$instance" --latest --output text --query Output || true)"
if ! grep -q 'FROSTSIM-IMAGE-OK' <<<"$console"; then
  grep -E 'Sandbox self-test|FROSTSIM-IMAGE|Error|error' <<<"$console" | tail -20 >&2 || true
  log "setup.sh did not report success; no image made"
  exit 1
fi

image="$(aws ec2 create-image --instance-id "$instance" --name "$name" --description "frostsim worker $(date -u +%Y-%m-%d)" \
  --tag-specifications "ResourceType=image,Tags=[{Key=frostsim,Value=worker-image}]" \
  "ResourceType=snapshot,Tags=[{Key=frostsim,Value=worker-image}]" --query ImageId --output text)"
log "Image $image; waiting until it is available"
aws ec2 wait image-available --image-ids "$image"
ok=1
log "Image ready; the build instance is terminated on exit"
echo "$image"
