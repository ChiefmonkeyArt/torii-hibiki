#!/usr/bin/env bash
# install.sh — owner-run installer for Hibiki (web app + feed service).
#
#   git clone https://github.com/ChiefmonkeyArt/torii-hibiki.git && cd torii-hibiki \
#     && git checkout v$(cat VERSION) && sudo ./install.sh [owner-npub]
#
# Lays the release under /apps/hibiki/releases/<ts> (web/, service/, VERSION),
# installs the service's pinned dependencies from package-lock.json without
# running package scripts, writes /etc/hibiki/hibiki.env (secret kept across
# upgrades), installs the hibiki-feed systemd unit (unprivileged user, loopback
# only, memory-capped), writes the nginx fragment (fragment-first contract),
# validates with `nginx -t`, flips /apps/hibiki/current, restarts the service and
# health-checks it, rolling everything back on failure. Then registers the Torii
# Base launcher card and keeps the newest 5 releases. It touches nothing outside
# /apps/hibiki, /etc/hibiki, /var/lib/hibiki, its unit and its nginx fragment.
set -euo pipefail
umask 022

APP="hibiki"
DISPLAY_NAME="Hibiki"
DESCRIPTION="Personal Nostr discovery feed"
APP_ROOT="/apps/${APP}"
RELEASES="${APP_ROOT}/releases"
CURRENT_LINK="${APP_ROOT}/current"
TORII_ROOT="${TORII_ROOT:-/opt/torii}"
FRAGMENT_DIR="${TORII_ROOT}/nginx-fragments"
FRAGMENT_FILE="${FRAGMENT_DIR}/${APP}.conf"
ENV_DIR="/etc/hibiki"
ENV_FILE="${ENV_DIR}/hibiki.env"
DATA_DIR="/var/lib/hibiki"
SVC_USER="hibiki"
UNIT="hibiki-feed"
UNIT_FILE="/etc/systemd/system/${UNIT}.service"
PORT=8795
KEEP_RELEASES=5
SUITE_ENV="${SUITE_ENV:-/opt/torii-suite/checkout/.env}"
CONTINUUM_CFG="${CONTINUUM_CFG:-${TORII_ROOT}/continuum-agent/config.yaml}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '==> %s\n' "$*"; }
die() { printf 'xx  %s\n' "$*" >&2; exit 1; }
envval() { [[ -f "$2" ]] && sed -n "s/^$1=//p" "$2" | tail -n1 | tr -d "\"' \r" || true; }

[[ $EUID -eq 0 ]] || die "run with sudo"

# ---- preflight -------------------------------------------------------------
for f in VERSION web/index.html web/napplet.html web/napplet.js web/shell.js web/rank.js \
         service/package.json service/package-lock.json service/src/server.mjs; do
  [[ -f "$SRC/$f" && ! -L "$SRC/$f" ]] || die "missing or symlinked $f"
done
VERSION="$(head -c 32 "$SRC/VERSION" | tr -d '[:space:]')"
[[ "$VERSION" =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$ ]] || die "invalid VERSION '$VERSION'"
grep -q "v${VERSION}" "$SRC/web/index.html" || die "web/index.html does not show v${VERSION}"
if command -v git >/dev/null 2>&1 && git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$SRC" tag --points-at HEAD 2>/dev/null | grep -qFx "v${VERSION}" \
    || log "warning: HEAD is not tag v${VERSION}; run 'git checkout v${VERSION}' for a tagged install"
fi

NODE="$(command -v node || true)"; NPM="$(command -v npm || true)"
[[ -n "$NODE" && -n "$NPM" ]] || die "node and npm are required (Node 22.13 or newer)"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);
  if(a<22||(a===22&&b<13))process.exit(1);
  if(typeof WebSocket!=="function")process.exit(2);' \
  || die "Node $("$NODE" -v) is too old: Hibiki needs Node 22.13+ (built-in sqlite and WebSocket)"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v openssl >/dev/null 2>&1 || die "openssl is required"

if command -v torii >/dev/null 2>&1; then TORII="torii"
elif [[ -x "${TORII_ROOT}/bin/torii" ]]; then TORII="${TORII_ROOT}/bin/torii"
else die "torii CLI not found — install Torii Base first"; fi

# ---- settings: owner, origin, secret (existing values win) ----------------
OWNER="${1:-${HIBIKI_OWNER:-$(envval HIBIKI_OWNER "$ENV_FILE")}}"
[[ -n "$OWNER" ]] || OWNER="$(envval CONTINUUM_ADMIN_NPUB "$SUITE_ENV")"
[[ -n "$OWNER" || ! -f "$CONTINUUM_CFG" ]] || OWNER="$(sed -n 's/^admin_npub:[[:space:]]*//p' "$CONTINUUM_CFG" | tr -d "\"' \r" | head -n1)"
[[ "$OWNER" =~ ^(npub1[02-9ac-hj-np-z]{58}|[0-9a-f]{64})$ ]] \
  || die "owner npub not found — run: sudo ./install.sh npub1..."

DOMAIN="${TORII_DOMAIN:-$(envval TORII_DOMAIN "$SUITE_ENV")}"
[[ -n "$DOMAIN" ]] || DOMAIN="$(sed -n 's/^[[:space:]]*server_name[[:space:]]\+\([^ ;]*\).*/\1/p' /etc/nginx/sites-available/torii.conf 2>/dev/null | head -n1)"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "domain not found — run with TORII_DOMAIN=example.com"
ORIGIN="https://${DOMAIN}"

SECRET="$(envval HIBIKI_SECRET "$ENV_FILE")"
[[ "$SECRET" =~ ^[0-9a-f]{64,}$ ]] || SECRET="$(openssl rand -hex 32)"

# ---- release -----------------------------------------------------------------
RELEASE_DIR="${RELEASES}/$(date -u +%Y%m%d-%H%M%S)"
install -d -m 0755 "$RELEASES" "$RELEASE_DIR" "$RELEASE_DIR/web/fonts" "$RELEASE_DIR/service/src"
install -m 0644 "$SRC/VERSION" "$RELEASE_DIR/VERSION"
install -m 0644 "$SRC"/web/*.html "$SRC"/web/*.js "$SRC"/web/*.css "$RELEASE_DIR/web/"
install -m 0644 "$SRC"/web/fonts/* "$RELEASE_DIR/web/fonts/"
install -m 0644 "$SRC"/service/package.json "$SRC"/service/package-lock.json "$RELEASE_DIR/service/"
install -m 0644 "$SRC"/service/src/*.mjs "$RELEASE_DIR/service/src/"
log "installing service dependencies (pinned, no package scripts)"
( cd "$RELEASE_DIR/service" && "$NPM" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error ) \
  || { rm -rf "$RELEASE_DIR"; die "npm ci failed"; }
chown -R root:root "$RELEASE_DIR"; chmod -R a+rX,go-w "$RELEASE_DIR"
log "release ${RELEASE_DIR} (v${VERSION})"

# ---- user, data, env, unit ---------------------------------------------------
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
install -d -m 0700 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"
install -d -m 0750 -o root -g "$SVC_USER" "$ENV_DIR"
ENV_NEW="$(mktemp)"
cat > "$ENV_NEW" <<ENV
# ${ENV_FILE} — written by install.sh. Owner and secret are kept across upgrades.
HIBIKI_OWNER=${OWNER}
HIBIKI_SECRET=${SECRET}
HIBIKI_PORT=${PORT}
HIBIKI_DATA=${DATA_DIR}
HIBIKI_ORIGIN=${ORIGIN}
HIBIKI_PRIMARY_RELAY=${HIBIKI_PRIMARY_RELAY:-$(envval HIBIKI_PRIMARY_RELAY "$ENV_FILE" | grep . || echo ws://127.0.0.1:7777)}
HIBIKI_PUBLIC_RELAY=${HIBIKI_PUBLIC_RELAY:-$(envval HIBIKI_PUBLIC_RELAY "$ENV_FILE" | grep . || echo "wss://relay.${DOMAIN}")}
ENV
install -m 0640 -o root -g "$SVC_USER" "$ENV_NEW" "$ENV_FILE"; rm -f "$ENV_NEW"

UNIT_BACKUP=""
if [[ -f "$UNIT_FILE" ]]; then UNIT_BACKUP="$(mktemp)"; cp -p "$UNIT_FILE" "$UNIT_BACKUP"; fi
cat > "$UNIT_FILE" <<UNITEOF
# ${UNIT_FILE} — Hibiki feed service. Written by install.sh; do not edit.
[Unit]
Description=Hibiki feed service (reads your circle, ranks public features, proxies media)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SVC_USER}
Group=${SVC_USER}
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${CURRENT_LINK}/service
ExecStart=${NODE} --disable-warning=ExperimentalWarning src/server.mjs
Restart=on-failure
RestartSec=5
MemoryMax=320M
Environment=NODE_OPTIONS=--max-old-space-size=192
TasksMax=64
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
SystemCallArchitectures=native
UMask=0077
ReadWritePaths=${DATA_DIR}

[Install]
WantedBy=multi-user.target
UNITEOF
chmod 0644 "$UNIT_FILE"
systemctl daemon-reload

# ---- nginx fragment (fragment-first) -----------------------------------------
install -d -m 0755 "$FRAGMENT_DIR"
FRAG_BACKUP=""
if [[ -f "$FRAGMENT_FILE" ]]; then FRAG_BACKUP="$(mktemp)"; cp -p "$FRAGMENT_FILE" "$FRAG_BACKUP"; fi
COMMON='add_header X-Content-Type-Options "nosniff" always; add_header Referrer-Policy "no-referrer" always; add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;'
cat > "${FRAGMENT_FILE}.new" <<NGINX
# ${FRAGMENT_FILE} — ${DISPLAY_NAME}. Written by install.sh; do not edit.
location = /${APP} { return 301 /${APP}/; }
location ~ ^/${APP}/(api|img|media)/ {
    proxy_pass http://127.0.0.1:${PORT};
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_buffering off;
    proxy_read_timeout 120s;
    client_max_body_size 128k;
}
location = /${APP}/index.html {
    alias ${CURRENT_LINK}/web/index.html;
    add_header Cache-Control "no-cache" always;
    add_header Content-Security-Policy "SHELL_CSP_VALUE" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    ${COMMON}
}
location = /${APP}/napplet.html {
    alias ${CURRENT_LINK}/web/napplet.html;
    add_header Cache-Control "no-cache" always;
    add_header Content-Security-Policy "NAPPLET_CSP_VALUE" always;
    ${COMMON}
}
location /${APP}/fonts/ {
    alias ${CURRENT_LINK}/web/fonts/;
    add_header Access-Control-Allow-Origin "*" always;
    add_header Cache-Control "public, max-age=2592000" always;
    ${COMMON}
}
location /${APP}/ {
    alias ${CURRENT_LINK}/web/;
    index index.html;
    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css text/javascript application/javascript;
    add_header Cache-Control "no-cache" always;
    ${COMMON}
}
NGINX
# The CSP strings are kept in one place (tools/headers.mjs mirrors them; tests
# check they match). Substituted here so the heredoc stays readable.
SHELL_CSP="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
NAPPLET_CSP="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts"
sed -i -e "s|SHELL_CSP_VALUE|${SHELL_CSP}|" -e "s|NAPPLET_CSP_VALUE|${NAPPLET_CSP}|" "${FRAGMENT_FILE}.new"
mv -f "${FRAGMENT_FILE}.new" "$FRAGMENT_FILE"

PREV_RELEASE="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
rollback() {
  log "rolling back: $1"
  if [[ -n "$FRAG_BACKUP" ]]; then install -m 0644 "$FRAG_BACKUP" "$FRAGMENT_FILE"; else rm -f "$FRAGMENT_FILE"; fi
  if [[ -n "$UNIT_BACKUP" ]]; then install -m 0644 "$UNIT_BACKUP" "$UNIT_FILE"; else systemctl disable --now "$UNIT" >/dev/null 2>&1 || true; rm -f "$UNIT_FILE"; fi
  systemctl daemon-reload
  if [[ -n "$PREV_RELEASE" && -d "$PREV_RELEASE" ]]; then
    ln -sfn "$PREV_RELEASE" "${CURRENT_LINK}.new" && mv -Tf "${CURRENT_LINK}.new" "$CURRENT_LINK"
    [[ -z "$UNIT_BACKUP" ]] || systemctl restart "$UNIT" || true
  else rm -f "$CURRENT_LINK"; fi
  rm -rf "$RELEASE_DIR"
  nginx -t >/dev/null 2>&1 && "$TORII" reload >/dev/null 2>&1 || true
  die "$1; fragment, unit and release rolled back"
}

if ! nginx -t >/dev/null 2>&1; then nginx -t || true; rollback "nginx -t failed"; fi

# ---- flip, start, health-check -----------------------------------------------
ln -sfn "$RELEASE_DIR" "${CURRENT_LINK}.new" && mv -Tf "${CURRENT_LINK}.new" "$CURRENT_LINK"
systemctl enable "$UNIT" >/dev/null 2>&1
systemctl restart "$UNIT"
HEALTH=""
for _ in $(seq 1 20); do
  HEALTH="$(curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/${APP}/api/health" 2>/dev/null || true)"
  [[ "$HEALTH" == *"\"version\":\"${VERSION}\""* ]] && break
  HEALTH=""; sleep 1
done
if [[ -z "$HEALTH" ]]; then journalctl -u "$UNIT" -n 30 --no-pager || true; rollback "${UNIT} did not report v${VERSION}"; fi
rm -f "$FRAG_BACKUP" "$UNIT_BACKUP"

log "registering launcher card '${APP}' v${VERSION}"
"$TORII" register "$APP" --display "$DISPLAY_NAME" --desc "$DESCRIPTION" --version "$VERSION"
"$TORII" reload

CUR="$(readlink -f "$CURRENT_LINK")"
find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*-[0-9]*' -printf '%f\n' | sort -r \
  | tail -n +$((KEEP_RELEASES + 1)) | while IFS= read -r d; do
      [[ "$RELEASES/$d" == "$CUR" ]] || rm -rf -- "${RELEASES:?}/$d"
    done

log "done: ${DISPLAY_NAME} v${VERSION} live at ${ORIGIN}/${APP}/ (owner ${OWNER:0:12}…)"
