#!/usr/bin/env bash
# Provisions a compute worker image on Ubuntu 24.04 (CLAUDE.md D14): Node 22, zstd, a default-deny
# inbound firewall and the agent, installed disabled. Idempotent. Run as root next to agent.mjs and
# frostsim-worker.service (cloud/worker/build-snapshot.sh does this on a temporary server).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l

apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg
# NodeSource, not Ubuntu's nodejs: 24.04 ships Node 18, which is end-of-life, below the agent's Node 22
# floor and has no zstd in node:zlib. NodeSource is a signed apt repository, so unattended-upgrades
# keeps Node 22 patched like any other package.
install -d -m 0755 /etc/apt/keyrings
[ -s /etc/apt/keyrings/nodesource.gpg ] \
  || curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
chmod 644 /etc/apt/keyrings/nodesource.gpg
printf '%s\n' 'Types: deb' 'URIs: https://deb.nodesource.com/node_22.x/' 'Suites: nodistro' 'Components: main' \
  'Signed-By: /etc/apt/keyrings/nodesource.gpg' > /etc/apt/sources.list.d/nodesource.sources
apt-get update -qq
apt-get install -y -qq --no-install-recommends nodejs zstd nftables

# Default-deny inbound. The agent only makes outbound HTTPS calls. ICMPv6 neighbour discovery stays
# open because workers are IPv6-only by default and the router cannot reach an address without it.
cat > /etc/nftables.conf <<'EOF'
#!/usr/sbin/nft -f
flush ruleset
table inet filter {
  chain input {
    type filter hook input priority filter; policy drop;
    ct state established,related accept
    iif lo accept
    icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-advert } accept
  }
  chain forward {
    type filter hook forward priority filter; policy drop;
  }
}
EOF
systemctl enable nftables.service
# Syntax check only; each worker applies it at boot. Loading it live could drop this build's SSH session, which conntrack would
# first see mid-stream as a new inbound connection, and the image is powered off right after this script anyway.
nft -c -f /etc/nftables.conf

install -d -m 0700 /etc/frostsim /var/lib/frostsim-worker
install -d -m 0755 /opt/frostsim-worker /var/cache/frostsim/engines
install -m 0644 "$here/agent.mjs" /opt/frostsim-worker/agent.mjs
install -m 0644 "$here/frostsim-worker.service" /etc/systemd/system/frostsim-worker.service
systemctl daemon-reload
systemctl disable frostsim-worker.service 2>/dev/null || true

node --version
node /opt/frostsim-worker/agent.mjs --self-test
echo "Worker image ready. cloud-init enables frostsim-worker.service once /etc/frostsim/worker.env exists."
