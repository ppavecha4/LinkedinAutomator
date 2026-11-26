#!/usr/bin/env bash
# setup.sh — prepare a fresh Ubuntu 24.04 server. Run ONCE, as root: sudo bash scripts/server/setup.sh
#
# Installs Docker and the basics, turns on automatic security updates, allows SSH with keys only,
# blocks repeated login attempts and adds swap. It does not open any port: the cloud firewall
# (docs/new-server.md) is what decides who can reach the server.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root: sudo bash $0" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

echo "== updates and packages"
apt-get update -y
apt-get upgrade -y
apt-get install -y docker.io docker-compose-v2 docker-buildx git fail2ban unattended-upgrades python3 openssl curl
systemctl enable --now docker

echo "== automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

echo "== 2 GB swap (memory spikes during builds)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== container logs cannot fill the disk"
if [ ! -f /etc/docker/daemon.json ]; then
  echo '{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "5" } }' > /etc/docker/daemon.json
  systemctl restart docker
fi

echo "== SSH: keys only"
# Never lock ourselves out: only switch passwords off once a key is in place.
KEYS=0
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do [ -s "$f" ] && KEYS=1; done
if [ "$KEYS" = 1 ]; then
  # sshd uses the FIRST value it reads, so this file must sort before cloud-init's.
  cat > /etc/ssh/sshd_config.d/10-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
X11Forwarding no
MaxAuthTries 4
EOF
  sshd -t
  systemctl reload ssh
else
  echo "   !! no SSH key found for any user: password login left on. Add your key, then run this again."
fi
systemctl enable --now fail2ban

echo
echo "Done. Next: sudo bash scripts/server/make_env.sh <your-domain> <your-login-email>"
