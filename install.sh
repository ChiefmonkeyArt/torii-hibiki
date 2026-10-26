#!/usr/bin/env bash
# install.sh — owner-run installer for the Hibiki preview (static, no service).
#
#   git clone https://github.com/ChiefmonkeyArt/torii-hibiki.git && cd torii-hibiki \
#     && git checkout v$(cat VERSION) && sudo ./install.sh
#
# Lays web/index.html + VERSION under /apps/hibiki/releases/<ts>, flips
# /apps/hibiki/current atomically, writes the nginx fragment (fragment-first
# contract), validates with `nginx -t` (rolling back on failure), registers the
# Torii Base launcher card, reloads nginx and keeps the newest 5 releases.
# It touches nothing outside /apps/hibiki and its own nginx fragment.
set -euo pipefail
umask 022

APP="hibiki"
DISPLAY_NAME="Hibiki"
DESCRIPTION="Personal Nostr discovery feed — preview"
APP_ROOT="/apps/${APP}"
RELEASES="${APP_ROOT}/releases"
CURRENT_LINK="${APP_ROOT}/current"
TORII_ROOT="${TORII_ROOT:-/opt/torii}"
FRAGMENT_DIR="${TORII_ROOT}/nginx-fragments"
FRAGMENT_FILE="${FRAGMENT_DIR}/${APP}.conf"
KEEP_RELEASES=5
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '==> %s\n' "$*"; }
die() { printf 'xx  %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo"
for f in web/index.html VERSION; do
  [[ -f "$SRC/$f" && ! -L "$SRC/$f" ]] || die "missing or symlinked $f"
done
VERSION="$(head -c 32 "$SRC/VERSION" | tr -d '[:space:]')"
[[ "$VERSION" =~ ^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$ ]] || die "invalid VERSION '$VERSION'"
grep -q "v${VERSION}" "$SRC/web/index.html" || die "web/index.html does not show v${VERSION}"
if command -v git >/dev/null 2>&1 && git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  TAG_AT_HEAD="$(git -C "$SRC" tag --points-at HEAD 2>/dev/null | grep -Fx "v${VERSION}" || true)"
  [[ -n "$TAG_AT_HEAD" ]] || log "warning: HEAD is not tag v${VERSION}; run 'git checkout v${VERSION}' for a tagged install"
fi

if command -v torii >/dev/null 2>&1; then TORII="torii"
elif [[ -x "${TORII_ROOT}/bin/torii" ]]; then TORII="${TORII_ROOT}/bin/torii"
else die "torii CLI not found — install Torii Base first"; fi

RELEASE_DIR="${RELEASES}/$(date -u +%Y%m%d-%H%M%S)"
install -d -m 0755 "$RELEASES" "$RELEASE_DIR"
install -m 0644 "$SRC/web/index.html" "$RELEASE_DIR/index.html"
install -m 0644 "$SRC/VERSION" "$RELEASE_DIR/VERSION"
chown -R root:www-data "$RELEASE_DIR"
log "release ${RELEASE_DIR} (v${VERSION})"

PREV_RELEASE="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
ln -sfn "$RELEASE_DIR" "${CURRENT_LINK}.new" && mv -Tf "${CURRENT_LINK}.new" "$CURRENT_LINK"

install -d -m 0755 "$FRAGMENT_DIR"
BACKUP=""
if [[ -f "$FRAGMENT_FILE" ]]; then BACKUP="$(mktemp)"; cp -p "$FRAGMENT_FILE" "$BACKUP"; fi
cat > "${FRAGMENT_FILE}.new" <<NGINX
# ${FRAGMENT_FILE} — ${DISPLAY_NAME} preview. Written by install.sh; do not edit.
location = /${APP} { return 301 /${APP}/; }
location /${APP}/ {
    alias /apps/${APP}/current/;
    index index.html;
    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css;
    add_header Cache-Control "no-cache" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
}
NGINX
mv -f "${FRAGMENT_FILE}.new" "$FRAGMENT_FILE"

if ! nginx -t >/dev/null 2>&1; then
  nginx -t || true
  if [[ -n "$BACKUP" ]]; then install -m 0644 "$BACKUP" "$FRAGMENT_FILE"; else rm -f "$FRAGMENT_FILE"; fi
  if [[ -n "$PREV_RELEASE" && -d "$PREV_RELEASE" ]]; then
    ln -sfn "$PREV_RELEASE" "${CURRENT_LINK}.new" && mv -Tf "${CURRENT_LINK}.new" "$CURRENT_LINK"
  else rm -f "$CURRENT_LINK"; fi
  rm -rf "$RELEASE_DIR"
  die "nginx -t failed; fragment and release rolled back"
fi
if [[ -n "$BACKUP" ]]; then rm -f "$BACKUP"; fi

log "registering launcher card '${APP}' v${VERSION}"
"$TORII" register "$APP" --display "$DISPLAY_NAME" --desc "$DESCRIPTION" --version "$VERSION"
"$TORII" reload

CUR="$(readlink -f "$CURRENT_LINK")"
find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*-[0-9]*' -printf '%f\n' | sort -r \
  | tail -n +$((KEEP_RELEASES + 1)) | while IFS= read -r d; do
      [[ "$RELEASES/$d" == "$CUR" ]] || rm -rf -- "${RELEASES:?}/$d"
    done

log "done: ${DISPLAY_NAME} v${VERSION} live at /${APP}/"
