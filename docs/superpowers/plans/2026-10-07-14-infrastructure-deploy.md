# Infrastructure and Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks marked **[OWNER]** contain steps only the project owner can do (accounts, payments, DNS). The agent prepares everything else and writes the exact instructions.

**Goal:** Run Craftoria v2 in production and staging at near-zero cost: Oracle Cloud Always Free ARM VMs running Docker Compose behind a Cloudflare Tunnel, with encrypted secrets in git, one-command deploys and rollbacks from GitHub Actions, nightly off-site encrypted backups with automated restore tests, and free-tier monitoring and alerting.

**Architecture:** See `02-target-architecture.md` §3 and §10. Two VMs: `dev` (2 OCPU / 12 GB, already created for development per decision D-7; **staging runs on it** as a separate compose project) and `prod` (2 OCPU / 12 GB). No public inbound ports: web traffic arrives through `cloudflared`, and admin access goes through Tailscale. Images are built for `linux/arm64` and pulled from GHCR. Secrets are sops/age-encrypted in `infra/env/*.enc.env` and decrypted on the VM at deploy time.

**Tech Stack:** Docker Engine + Compose v2, Oracle Cloud Infrastructure (Always Free), Cloudflare (DNS, Tunnel, R2, Pages, WAF, Access), Tailscale, GitHub Actions + GHCR, sops + age, rclone, Grafana Cloud (Alloy agent), Sentry, UptimeRobot.

**Spec:** `02-target-architecture.md` §9–§12 (decisions D-1, D-2), `05-engineering-standards.md` §5 (migrations run only via the pipeline).

**Prerequisite:** plan 02 complete. Tasks 1–3 can start immediately; Task 6 needs at least one service image.

**Required skills:** `safe-backend-changes` (first: never run migrations against prod from an AI session; no destructive actions without owner approval), `database-migration` (Tasks 6–7); plus the workflow skills `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use **only** the project skills in `.claude/skills/` (mirrored in `.agents/skills/`); no other skills or plugins. See `docs/architecture/05-engineering-standards.md` §8.

## Global Constraints

- Directory on each VM: `/opt/craftoria/{infra,data,backups}`, owned by the `deploy` user. Postgres data lives in the named volume `pgdata`.
- Memory limits (prod, 12 GB VM): postgres 4g, rabbitmq 640m, valkey 256m, each Node service 320m, storefront 448m, cloudflared 128m, alloy 256m. Staging (on the dev VM): half, with Postgres 1.5g.
- Postgres prod settings: `shared_buffers=3GB`, `effective_cache_size=7GB`, `work_mem=16MB`, `maintenance_work_mem=512MB`, `max_connections=200`, `wal_compression=on`, `checkpoint_timeout=15min`, `log_min_duration_statement=500ms`.
- Image name: `ghcr.io/<owner>/craftoria-<component>:<git-sha>`. The deploy tag is always a commit SHA; `latest` is never used.
- The deploy order is fixed: pull → migrate (each `<svc>-migrate`, sequential) → `up -d --wait` → smoke → mark good, or roll back.
- Backups: 02:30 IST nightly; retention 7 daily, 4 weekly, 6 monthly; encrypted with age to a key **not** stored on the VM (the public recipient is on the VM; the private key is in the owner's password manager).

## Review Focus

1. A failed smoke test after a deploy must restore the previous tags automatically, and the pipeline must go red. (Task 6 test `rollback on failed smoke`.)
2. A deploy must never run while another deploy is running on the same VM (`flock`). (Task 6.)
3. A backup job that silently produces a 0-byte or undecryptable file must alert. (Task 7: restore test + "backup age" alert.)
4. The disk filling up from Docker logs or images: log rotation is set, and `docker image prune` runs after each deploy keeping the last 3 tags. (Tasks 1 and 6.)
5. The Razorpay webhook must keep working behind Cloudflare Access on staging (bypass rule) and behind the WAF on prod (skip rule). (Task 5 checklist + Task 6 smoke posts a signed fake webhook on staging.)

---

### Task 1: Production and staging compose files

**Skills:** `safe-backend-changes` (first: never run migrations against prod from an AI session; no destructive actions without owner approval), `database-migration` (Tasks 6–7); workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `infra/compose/docker-compose.prod.yml`, `infra/compose/docker-compose.staging.yml`, `infra/postgres/postgresql.prod.conf`, `infra/postgres/postgresql.staging.conf`, `infra/scripts/smoke.sh`

**Interfaces:**
- Produces: overrides that replace every `build:` with `image: ${REGISTRY}/craftoria-<c>:${TAG}`; `restart: unless-stopped`; `deploy.resources.limits.memory` per Global Constraints; logging `json-file` with `max-size: 10m, max-file: 3`; no `ports:` at all; service `cloudflared` (`cloudflare/cloudflared:latest` pinned by digest, `command: tunnel --no-autoupdate run`, env `TUNNEL_TOKEN`). Postgres mounts the env-specific conf. `smoke.sh <base-url-api> <base-url-site>` checks: gateway `/readyz` = 200; `/.well-known/jwks.json` has ≥1 key; `/v1/categories` = 200; storefront `/healthz` = 200 and `/` returns HTML containing `<title>`; exit 1 on any failure (curl with `--retry 10 --retry-delay 3`).

- [ ] **Step 1:** Write the files.
- [ ] **Step 2: Verify:** `docker compose -f docker-compose.yml -f docker-compose.prod.yml config -q` passes for both envs. Locally, build the images with `TAG=local REGISTRY=local`, start the prod stack with fake providers and without cloudflared (`--scale cloudflared=0`), then run `smoke.sh http://localhost:8080 http://localhost:3000` through a temporary port-forward override. Expected: exit 0.
- [ ] **Step 3: Commit** `feat(infra): production and staging compose overrides, smoke test`.

### Task 2: arm64 image builds

**Skills:** `safe-backend-changes` (first: never run migrations against prod from an AI session; no destructive actions without owner approval), `database-migration` (Tasks 6–7); workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `.github/workflows/images.yml`, `infra/scripts/build-on-host.sh`

**Interfaces:**
- Produces: on push to `main` and on tags `v*`, a matrix over `[gateway, identity, catalog, seller, cart, order, payment, notification, storefront]` (filtered to changed components with `dorny/paths-filter`; tags build all). Runner: `ubuntu-24.04-arm` (decision D-1 = public repo); if D-1 = private, set the repository variable `BUILD_MODE=host` and the workflow skips building, so the deploy job runs `build-on-host.sh` on the VM instead (`docker compose build` with the same tags). `docker/build-push-action` with `platforms: linux/arm64`, `cache-from/to: type=gha,scope=<c>`, tags `<sha>` and `main`. Output: a `images-manifest.json` artifact `{component: sha}` listing the SHA to deploy for every component (unchanged components reuse their last built SHA, looked up from the previous manifest artifact).

- [ ] **Step 1:** Write the workflow and script. **Step 2: Verify:** a push to a test branch with `workflow_dispatch` builds one service; `docker manifest inspect ghcr.io/<owner>/craftoria-identity:<sha>` shows `arm64`. **Step 3: Commit** `ci: arm64 image builds to GHCR`.

### Task 3: Secrets with sops and age

**Skills:** `safe-backend-changes` (first: never run migrations against prod from an AI session; no destructive actions without owner approval), `database-migration` (Tasks 6–7); workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `.sops.yaml`, `infra/env/staging.enc.env`, `infra/env/prod.enc.env`, `infra/scripts/{secrets-edit.sh,secrets-decrypt.sh}`, `infra/env/README.md`

**Interfaces:**
- Produces: `.sops.yaml` creation rules that encrypt `infra/env/*.enc.env` for two age recipients: the owner's personal key and the per-environment VM key (`staging`, `prod`). The `.enc.env` files contain every variable from `.env.example`, with generated strong values (`openssl rand -base64 48` for tokens; 32-byte base64 for `JWT_KEY_ENCRYPTION_KEY`, `BANK_ENC_KEY`; per-service Postgres passwords) and placeholders `CHANGE_ME_<NAME>` only for third-party keys (Razorpay, Resend, R2, Sentry, Tunnel). `secrets-decrypt.sh <env>` → `/opt/craftoria/infra/env/.env` (`chmod 600`). README: how to install sops and age on Windows (`winget install sops FiloSottile.age`), edit, rotate a key, and add a recipient.

- [ ] **Step 1 [OWNER]:** `age-keygen -o owner.agekey`; store it in the password manager; give the agent the **public** key.
- [ ] **Step 2:** Write the files, generate the values, encrypt. **Step 3: Verify:** `sops -d infra/env/staging.enc.env | grep -c '='` equals the variable count in `.env.example`; `gitleaks detect` passes; the plaintext never touches git (`git log -p | grep -c CHANGE_ME` only shows encrypted blobs).
- [ ] **Step 4: Commit** `chore(infra): sops-encrypted environment files`.

### Task 4: Oracle Cloud VMs [OWNER + agent]

**Skills:** `safe-backend-changes` (first: never run migrations against prod from an AI session; no destructive actions without owner approval), `database-migration` (Tasks 6–7); workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `infra/oracle/RUNBOOK.md`, `infra/oracle/cloud-init.yaml`, `infra/oracle/verify-host.sh`

**Interfaces:**
- Produces: a cloud-init that creates the `deploy` user (sudo, docker group); installs Docker Engine + compose plugin (official apt repo, arm64), Tailscale (`tailscale up --authkey=${TS_AUTHKEY} --ssh --hostname=craftoria-<env>`), `sops`, `age`, `rclone`; enables `unattended-upgrades`; sets up a 4 GB swapfile with `vm.swappiness=10`; journald `SystemMaxUse=500M`; `ufw default deny incoming`, `allow in on tailscale0`; creates `/opt/craftoria`. `verify-host.sh` prints PASS/FAIL for Docker version, compose, Tailscale up, ufw active, no listening public ports except via Tailscale (`ss -tlnp`), swap, and free disk > 20 GB.
- The RUNBOOK covers, step by step for a first-time user: (1) sign up (choose a home region with A1 capacity, e.g. Mumbai or Hyderabad; the home region can't change); (2) **upgrade to Pay-As-You-Go** and create a budget alert at ₹100 to keep Always Free resources safe from idle reclamation; (3) create a VCN with the wizard; (4) create the `prod` instance (Ampere A1 Flex, 2 OCPU / 12 GB, Ubuntu 24.04 aarch64, boot volume 100 GB, paste cloud-init with your Tailscale auth key); (5) the `dev` VM already exists (created per `infra/oracle/DEV-VM-SETUP.md`, decision D-7) and also hosts staging; add Tailscale to it; (6) after Tailscale shows both machines, **delete the ingress rule for port 22** from the security list; (7) copy each VM's age private key to `/etc/craftoria/age.key` (`chmod 400`, owner `deploy`); (8) run `verify-host.sh`. It also explains what to do if you hit "Out of capacity" (retry later, or 2 OCPU first and resize).

- [ ] **Step 1 (agent):** Write the RUNBOOK, cloud-init and verify script; lint the cloud-init with `cloud-init schema --config-file` in a container.
- [ ] **Step 2 [OWNER]:** Follow the RUNBOOK. Paste the `verify-host.sh` output for both VMs into the task report. Expected: all PASS.
- [ ] **Step 3: Commit** `docs(infra): oracle vm runbook and cloud-init`.

### Task 5: Cloudflare (DNS, Tunnel, R2, Pages, WAF, Access) [OWNER + agent]

**Skills:** `safe-backend-changes` (first: never run migrations against prod from an AI session; no destructive actions without owner approval), `database-migration` (Tasks 6–7); workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `infra/cloudflare/RUNBOOK.md`, `infra/cloudflare/r2-cors.json`, `infra/cloudflare/r2-lifecycle-backups.json`

**Interfaces:**
- Produces: a runbook for (1) adding the domain and switching nameservers; (2) a Zero Trust tunnel per env (`craftoria-prod`, `craftoria-staging`) with public hostnames `craftoria.in → http://storefront:3000`, `api.craftoria.in → http://gateway:8080`, `staging.craftoria.in`, `api.staging.craftoria.in`, and the tunnel tokens put into the `.enc.env` files; (3) R2 buckets `craftoria-media` (custom domain `media.craftoria.in`, CORS from `r2-cors.json` allowing `PUT` from the console and storefront origins with `Content-Type`), `craftoria-media-staging`, and `craftoria-backups` (private, lifecycle from `r2-lifecycle-backups.json` deleting `daily/` after 8 days, `weekly/` after 35 days, `monthly/` after 190 days), plus API tokens scoped per bucket; (4) a Pages project `craftoria-console` with custom domains `console.craftoria.in` / `console.staging.craftoria.in`; (5) WAF: the free managed ruleset on, a rate-limit rule for `/v1/auth/*` (20/min/IP), a **skip** rule for `/v1/webhooks/razorpay` (Bot Fight Mode off for it); (6) cache rules: `media.*` cache everything for 1 year; `api.*` bypass; storefront respects origin headers; (7) Cloudflare Access on `*.staging.craftoria.in` (email OTP to the owner) **except** `api.staging.craftoria.in/v1/webhooks/*`; (8) SPF, DKIM and DMARC records for the Resend sending domain.

- [ ] **Step 1 (agent):** Write the runbook and JSON files.
- [ ] **Step 2 [OWNER]:** Follow the runbook. **Verify:** `curl -I https://media.craftoria.in/healthcheck.txt` (upload a test file first) → 200 with `cf-cache-status`; `dig api.craftoria.in` resolves to Cloudflare; the tunnel shows "Healthy" for both envs once Task 6 deploys.
- [ ] **Step 3: Commit** `docs(infra): cloudflare runbook and r2 configs`.

### Task 6: Deploy and rollback pipeline

**Skills:** `safe-backend-changes` (first: never run migrations against prod from an AI session; no destructive actions without owner approval), `database-migration` (Tasks 6–7); workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `infra/scripts/{deploy.sh,rollback.sh,prune.sh}`, `.github/workflows/deploy.yml`, `infra/DEPLOY.md`

**Interfaces:**
- Produces:
  - `deploy.sh <env> <manifest.json>` (runs on the VM as `deploy`): `flock /opt/craftoria/.deploy.lock` → `secrets-decrypt.sh` → write `/opt/craftoria/.tags.env` from the manifest (`TAG_<COMPONENT>=<sha>`) → `docker compose pull` → for each service with migrations, `docker compose run --rm <svc>-migrate` (stop at the first failure → exit 1 **without** restarting anything) → `docker compose up -d --wait --remove-orphans` (timeout 180 s) → `smoke.sh` → on success copy `.tags.env` → `.tags.last-good.env` and run `prune.sh` (keep the 3 most recent tags per image); on failure → `rollback.sh` → exit 1.
  - `rollback.sh`: `cp .tags.last-good.env .tags.env && docker compose up -d --wait` → `smoke.sh`. Migrations are **not** reverted (they are expand-only per `05-engineering-standards.md` §5).
  - `deploy.yml`: `workflow_run` after `images` succeeds on `main` → environment `staging`; on tags `v*` → environment `production` (required reviewer = owner). Steps: `tailscale/github-action` (OAuth client, tag `tag:ci`) → `rsync infra/` to the VM → `ssh deploy@craftoria-<env> /opt/craftoria/infra/scripts/deploy.sh <env> manifest.json`. On staging it also posts a fake-signed webhook to `api.staging…/v1/webhooks/razorpay` expecting `400` (the signature is checked) and **not** a Cloudflare challenge page (proves the bypass rule works).
  - `DEPLOY.md`: the normal flow, manual deploy, manual rollback, how to tag a release, and what to do when a migration fails.

- [ ] **Step 1:** Write the scripts with `set -euo pipefail` and test them with `bats` (`infra/scripts/test/*.bats`) against a fake `docker` shim: `deploy runs migrations before up`, `migration failure stops before up`, `rollback on failed smoke`, `concurrent deploy blocked by lock`.
- [ ] **Step 2:** Run the bats tests → PASS. **Step 3 [OWNER]:** Create the Tailscale OAuth client and the GitHub environments (`staging`, `production` with a required reviewer) and secrets (`TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`). **Step 4: Verify:** a merge to `main` deploys to staging green; deliberately break `smoke.sh` on a branch deploy → the pipeline goes red and staging still serves the previous version.
- [ ] **Step 5: Commit** `feat(infra): deploy and rollback pipeline`.

### Task 7: Backups and restore testing

**Skills:** `safe-backend-changes` (first: never run migrations against prod from an AI session; no destructive actions without owner approval), `database-migration` (Tasks 6–7); workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `infra/backup/{Dockerfile,backup.sh,restore-test.sh,crontab}`, compose service `backup` (prod and staging), `infra/backup/RESTORE.md`

**Interfaces:**
- Produces: a `backup` container (alpine + `postgresql17-client`, `age`, `rclone`, `supercronic`). `backup.sh`: for each database, `pg_dump -Fc` → `age -r <recipient>` → `rclone copy` to `r2:craftoria-backups/<env>/{daily|weekly|monthly}/<date>/<db>.dump.age` (weekly on Sunday, monthly on the 1st); it writes `last_success` with a timestamp and size to a metrics textfile served for Alloy (`backup_last_success_timestamp_seconds`, `backup_bytes`). `restore-test.sh` (staging, weekly Monday 04:00): download the latest prod dumps → decrypt with the restore key (stored only on **staging** at `/etc/craftoria/restore.agekey`; a separate key whose public half is a second recipient) → `pg_restore` into a scratch Postgres container → run `SELECT count(*)` sanity queries per DB (users > 0, orders ≥ 0) → push the `restore_test_last_success_timestamp_seconds` metric. `RESTORE.md`: full disaster recovery (new VM → cloud-init → restore the latest dumps → deploy the last-good tags), with an expected RTO of about 2 h and an RPO of 24 h, plus "how to enable WAL-G for PITR later".

- [ ] **Step 1:** Write the files. **Step 2: Verify locally:** run `backup.sh` against the compose stack with MinIO standing in for R2 → objects exist and decrypt; `restore-test.sh` restores them and prints counts. **Step 3 [OWNER]:** after the staging deploy, trigger both manually once and confirm the metrics appear in Grafana (Task 8).
- [ ] **Step 4: Commit** `feat(infra): encrypted off-site backups with automated restore tests`.

### Task 8: Observability and alerting

**Skills:** `safe-backend-changes` (first: never run migrations against prod from an AI session; no destructive actions without owner approval), `database-migration` (Tasks 6–7); workflow: `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`. Use no skills outside this project's skill pack.

**Files:**
- Create: `infra/observability/{alloy.config.alloy,dashboards/*.json,alerts/*.yaml,README.md}`, compose service `alloy`

**Interfaces:**
- Produces: Grafana Alloy (container, with Docker socket read-only) that (1) tails container logs → Loki with labels `service`, `env`, `level` (parsed from pino JSON); (2) scrapes every service's `/metrics` plus the postgres-exporter, rabbitmq (`/metrics` from the prometheus plugin) and the backup textfile → Prometheus remote-write; (3) receives OTLP (`4317`) from services → Tempo. Credentials come from the env file. Dashboards: **Service RED** (rate, errors, p95 per route per service), **Checkout funnel** (`checkout` 201s, `payment.captured`, `order.paid`, timeouts, late payments), **Messaging** (outbox unpublished, consumer failures, DLQ depth per queue), **Infra** (CPU, memory, disk, Postgres connections, backup age). Alerts (Grafana Cloud alerting → email to the owner): any 5xx rate > 2 % for 5 min; DLQ depth > 0 for 10 min; outbox unpublished > 100 for 5 min; `backup_last_success` older than 26 h; `restore_test_last_success` older than 8 days; disk > 80 %; any container restarting > 3 times in 15 min; refund `failed` count > 0. Sentry DSNs for each service and both apps (in env files). UptimeRobot monitors (5-min) on `https://craftoria.in`, `https://api.craftoria.in/readyz` and `https://console.craftoria.in`.

- [ ] **Step 1:** Write the configs. **Step 2: Verify:** run `alloy fmt` and `alloy validate` (if present in your version) in a container; import the dashboards into a Grafana container and confirm they load without datasource errors. **Step 3 [OWNER]:** create the Grafana Cloud free stack, Sentry projects and UptimeRobot monitors; put the keys into the `.enc.env` files; deploy; force a test alert (stop the payment container on staging for 6 min → the 5xx alert email arrives).
- [ ] **Step 4: Commit** `feat(infra): logs, metrics, traces, dashboards and alerts`.
