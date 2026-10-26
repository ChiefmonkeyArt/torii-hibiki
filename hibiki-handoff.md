# Hibiki — Handoff

**Repo:** `ChiefmonkeyArt/torii-hibiki` (public). **Route:** `/hibiki/`. **Registry name:** `hibiki`. **Version marker:** `VERSION`, `package.json` and the footer of `web/index.html` (checked by `npm test`).

**Release rule:** land through a merged PR, tag `v<VERSION>` on the merge commit, and the owner installs from the tag:

```bash
cd ~/torii-hibiki 2>/dev/null || { git clone https://github.com/ChiefmonkeyArt/torii-hibiki.git ~/torii-hibiki && cd ~/torii-hibiki; }; git fetch --tags && git checkout v0.1.0 && sudo ./install.sh
```

**VPS layout:** `/apps/hibiki/{current,releases/<ts>}` with five releases kept, plus `/opt/torii/nginx-fragments/hibiki.conf`. No service yet, no data directory, no secrets.

**Live check:** `curl -s https://chiefmonkey.art/torii/apps.json` lists `hibiki` at 0.1.0, and `curl -s https://chiefmonkey.art/hibiki/VERSION` returns `0.1.0`.

**Next:** ADR review, then P1 (see `hibiki-todo.md`).
