# ADR-0002: Owner-approved Hibiki deploys run by the agent

- **Status:** Proposed (2026-10-27)
- **Applies to:** the owner's own node, `chiefmonkey.art`, only. Other operators are never touched.
- **Relates to:** Torii Quest ADR-0101 (deploy-only key with a forced command), ADR-0102 (admin key), ADR-0106 (never force-update; deploys are manual only).

## Context

Every Hibiki release ends with the owner pasting the install command into an SSH terminal. The standing rule is that the VPS, the tag and main must match. Doing it by hand slows each release, and releases can stack up between installs.

Other Torii sessions reach this VPS through two keys stored in the torii-quest repo's GitHub secrets:

- **The deploy key** can only start Quest's update service.
- **The `torii-admin` key** can read diagnostics and write to Quest-owned paths.

Neither can run Hibiki's installer. The installer has to run as root: it creates the `hibiki` user, may install `libvips-tools`, writes the systemd unit and reloads nginx. Widening either Quest key would blur the boundary between the two projects, and would give an AI-held key general root.

## Decision

Add a third key with one job: installing a Hibiki release that has already been merged and tagged, and nothing else.

### The key

- An ed25519 key named `hibiki-deploy`. The agent generates it in its sandbox and writes the private half straight into the torii-hibiki repo's Actions secret `HIBIKI_DEPLOY_SSH_KEY` with `gh secret set`. It is never printed, never shown in chat and never stored on the VPS. The sandbox copy is deleted at once.
- The public half is committed at `ops/hibiki-deploy.pub` (public keys are safe to publish). The setup script installs it in `ubuntu`'s `authorized_keys` as a forced-command entry with every other SSH feature off:
  ```
  command="/usr/local/sbin/hibiki-deploy-hook",restrict ssh-ed25519 AAAA… hibiki-deploy@github-actions
  ```
  Whatever the client asks to run, the server runs only the hook.

### The hook and the deploy script

- `/usr/local/sbin/hibiki-deploy-hook` is owned by root, mode 0755. It reads `SSH_ORIGINAL_COMMAND` and accepts exactly two forms:
  - `deploy vX.Y.Z`: semantic version only, checked with a strict regular expression. It calls `sudo -n /usr/local/sbin/hibiki-deploy vX.Y.Z`.
  - `status`: prints `/hibiki/api/health` and the installed release. No sudo.

  Anything else is refused and logged.
- `/usr/local/sbin/hibiki-deploy` is owned by root, mode 0755. It works from its own root-owned clone at `/opt/torii/src/torii-hibiki`, not `~/torii-hibiki`, so code the `ubuntu` user can write to never runs as root. It:
  1. Takes a lock (`flock`), so only one deploy runs at a time.
  2. Runs `git fetch --tags --prune` from `https://github.com/ChiefmonkeyArt/torii-hibiki.git`.
  3. Refuses unless all of these hold:
     - the tag exists and is annotated;
     - the tag's commit is `origin/main` HEAD, which is the release rule: merged, tagged and current;
     - `VERSION` at the tag equals the tag without its `v`.
  4. Checks out the tag (detached) and runs that tag's `./install.sh`. The installer already health-checks the new release and rolls back on failure.
  5. Prints the health JSON and logs the result to the journal (`logger -t hibiki-deploy`).
- One sudoers rule, checked with `visudo -c` before it is installed:
  ```
  ubuntu ALL=(root) NOPASSWD: /usr/local/sbin/hibiki-deploy
  ```
  It has no wildcards (sudo-rs rejects them in arguments). The script checks its own argument.

### The workflow

`.github/workflows/deploy.yml` in torii-hibiki:

- Runs on `workflow_dispatch` only, with a required `tag` input. There is no trigger on tag push and no schedule.
- `concurrency: hibiki-vps-deploy`, `permissions: contents: read`, a 10-minute timeout.
- SSH with `StrictHostKeyChecking=yes` against a pinned host key in the secret `HIBIKI_DEPLOY_KNOWN_HOSTS`. The setup script prints the VPS host-key fingerprints, so the owner can confirm the pinned key matches.
- Sends `deploy <tag>`, streams the output into the workflow log, then checks the public health endpoint reports that version.

### When the agent may run it

- Only after the owner asks for that release to be installed in the session (for example, "install v0.2.4"). Merging or tagging is not approval to deploy. This follows ADR-0106 and the owner's rule that each operator approves updates to their own node.
- Every ship report still shows the result: the workflow run link and the health output.

### Revoking it

One command on the VPS removes access:

```bash
sudo sed -i '/hibiki-deploy-hook/d' ~/.ssh/authorized_keys && sudo rm -f /etc/sudoers.d/hibiki-deploy
```

Deleting the GitHub secret also disables it. The setup script prints this command when it finishes.

## What this key cannot do

- It cannot open a shell, forward ports or agents, or run any command other than the hook.
- It cannot touch Quest, Continuum, the Suite, nginx sites or any other app, except through Hibiki's own installer.
- It cannot install a branch, an untagged commit or a tag that is not main HEAD. An older tag cannot be pushed back on: rolling back stays a manual owner step (the installer keeps five releases).
- It cannot read the owner's Nostr keys, the Suite `.env`, or Hibiki's HMAC secret.

## Setup (owner, once)

Shipped in the next Hibiki release (v0.2.4) as `ops/install-deploy-access.sh`, run from the tagged clone:

```bash
cd ~/torii-hibiki && git fetch --tags && git checkout v0.2.4 && sudo ./ops/install-deploy-access.sh
```

It installs the hook, the deploy script, the sudoers rule and the forced-command key line, creates `/opt/torii/src/torii-hibiki`, and prints the host-key fingerprints and the revoke command. Every step is idempotent. The agent then stores `HIBIKI_DEPLOY_HOST` and `HIBIKI_DEPLOY_KNOWN_HOSTS`, and does a first `status` run to prove the key works.

## Alternatives considered

- **Widen the `torii-admin` sudoers rules.** This mixes Hibiki into Quest's key and secrets, and its write rules are already broad. Rejected.
- **Paste a private key into chat**, as was done once for `torii-admin`. The secret would then sit in the conversation history. Rejected: the key is created where it is stored.
- **Deploy automatically on every tag.** This contradicts ADR-0106 and the owner's rule that updates are never forced. Rejected.
- **Use a GitHub environment with required reviewers.** That would mean an extra click in GitHub for every deploy. It is available later if the owner wants a second gate.

## Consequences

- The agent can finish a release end to end (PR, merge, tag, install, health check) once the owner says to install, with no pasted commands.
- One more credential exists. It is narrow, revocable in one line, and its use is visible in the Actions log and the VPS journal.
- Tests in v0.2.4 cover the hook's argument check (only `deploy vX.Y.Z` and `status`), the deploy script's refusals (unknown tag, lightweight tag, tag not at main, VERSION mismatch), the sudoers rule passing `visudo -c`, and the workflow having no push or schedule triggers.
