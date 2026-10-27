#!/usr/bin/env bash
# ADR-0002: one-time setup so the agent can install owner-approved Hibiki
# releases. Run from a tagged clone:  sudo ./ops/install-deploy-access.sh
# Installs: the forced-command hook, the root-owned deploy script, one sudoers
# rule (checked with visudo first) and the hibiki-deploy public key line.
# Idempotent. Prints the host-key fingerprints and the revoke command.
set -euo pipefail
[[ "$(id -u)" -eq 0 ]] || { echo "Run with sudo." >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_USER="${DEPLOY_USER:-${SUDO_USER:-ubuntu}}"
[[ "$DEPLOY_USER" != root ]] || { echo "Run as your normal user with sudo, not as root." >&2; exit 1; }
HOME_DIR="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
[[ -n "$HOME_DIR" ]] || { echo "No such user: $DEPLOY_USER" >&2; exit 1; }
PUB="$(cat "$HERE/hibiki-deploy.pub")"
[[ "$PUB" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+\ hibiki-deploy@github-actions$ ]] || { echo "ops/hibiki-deploy.pub looks wrong" >&2; exit 1; }

echo "==> installing /usr/local/sbin/hibiki-deploy-hook and /usr/local/sbin/hibiki-deploy"
install -m 0755 -o root -g root "$HERE/hibiki-deploy-hook" /usr/local/sbin/hibiki-deploy-hook
install -m 0755 -o root -g root "$HERE/hibiki-deploy" /usr/local/sbin/hibiki-deploy
install -d -m 0755 -o root -g root /opt/torii/src

echo "==> sudoers: $DEPLOY_USER may run /usr/local/sbin/hibiki-deploy (nothing else)"
TMP="$(mktemp)"
echo "$DEPLOY_USER ALL=(root) NOPASSWD: /usr/local/sbin/hibiki-deploy" > "$TMP"
if ! visudo -c -f "$TMP" >/dev/null; then rm -f "$TMP"; echo "sudoers check failed, nothing installed" >&2; exit 1; fi
install -m 0440 -o root -g root "$TMP" /etc/sudoers.d/hibiki-deploy
rm -f "$TMP"

echo "==> authorized_keys: hibiki-deploy key, forced command, no shell or forwarding"
AK="$HOME_DIR/.ssh/authorized_keys"
install -d -m 0700 -o "$DEPLOY_USER" -g "$(id -gn "$DEPLOY_USER")" "$HOME_DIR/.ssh"
touch "$AK"
grep -v 'hibiki-deploy-hook' "$AK" > "$AK.new" || true
printf 'command="/usr/local/sbin/hibiki-deploy-hook",restrict %s\n' "$PUB" >> "$AK.new"
chown "$DEPLOY_USER:$(id -gn "$DEPLOY_USER")" "$AK.new"; chmod 600 "$AK.new"; mv "$AK.new" "$AK"

echo
echo "Done. Host-key fingerprints (the agent's pinned key must match one of these):"
for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done
echo
echo "To revoke at any time:"
echo "  sudo sed -i '/hibiki-deploy-hook/d' $AK && sudo rm -f /etc/sudoers.d/hibiki-deploy"
