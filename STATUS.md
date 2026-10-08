# LPS – Projects Utility: Status & Runbook

_Last updated: 8 Oct 2026_

## Where things are

| | |
|---|---|
| **Code** | GitHub `Plenum-Tech/lps-projects-utility` (private), branch `main` |
| **Live app (Azure)** | https://lps-projects-utility.greenground-16e2d951.uaenorth.azurecontainerapps.io |
| **Azure** | Subscription *Azure-PlenumAgentic*, resource group `lps-projects-utility-rg` (UAE North) |
| Container App | `lps-projects-utility`: 1 replica, 2 vCPU / 4 GiB, managed identity `lps-app-identity` |
| Image | `plenumwebsiteacr.azurecr.io/lps-projects-utility:<commit>` (repository-scoped pull/push roles only). Debian-based, ~870 MB: it includes LibreOffice + poppler to convert training decks |
| Database | Cosmos DB for MongoDB vCore `lps-pu-mongo` (M20, no HA), database `lps`. Firewall: Azure services + one workstation IP |
| Local dev | `backend/` → `bun run dev` (:5000, DB `ems` in Docker `ems-mongo`); `frontend/` → `bun run dev` (:5173) |

## Features (all deployed)

- **Work**: projects (structured names `Brand_Type_MonYYYY_Name`, brands, milestones, members), tasks (Worksuite-style table, board, calendar, subtasks with full form, comments, notes, files, history, actual start/end, estimates), meetings (Teams transcripts → tasks), timesheets and time logs, Excel/CSV import, recurring tasks.
- **Reports**: Delivery Pulse, task, time-log, weekly timesheet, HR reports, activity log.
- **HR**: employees and invitations, departments, leaves (heads approve their department), attendance, documents, performance reviews (manual; AI optional), feedback, announcements, **training** (admins upload a .pptx/.pdf deck and assign it; employees must read every slide, then tick the acknowledgement and complete; admins track and export progress, send reminders).
- **Dashboard**: My dashboard with a period filter (7d–1y/all); Organisation view.
- **Settings**: company, address, app (timezone, date format), profile, notifications, security, task/project/time-log/leave/meeting/delivery/brands, integrations (Pearity).
- **Auth**: set-password links, forgot password with an emailed 6-digit code.
- **Pearity**: a Generate button (one shared tag per task) and a server-to-server API (`docs/pearity-integration.md`).

## Data

- LPS Brands (Worksuite company 18) imported into **both** local `ems` and Azure Cosmos: 60 users, 20 departments, 497 projects (479 branded, 94 brands), 9,617 tasks, comments, history, time logs.
- **Re-import a newer dump** (safe and idempotent; keeps passwords, brands and app-side edits), from `backend/`:
  `bun run import:worksuite -- --sql "<dump.sql>" --backup "<backup.tar.gz>" --company 18 --skip-files --dry-run --confirm`, then the same without `--dry-run`.
- **Attachments**: not imported. The server backup didn't contain the files.
- **Local backups**: `Documents\projectutility\ems-backup-*.gz`. Restore with `docker exec ems-mongo mongorestore --drop --gzip --archive=/data/db/<file>`. Run the command from PowerShell, not Git Bash, or set `MSYS_NO_PATHCONV=1` first.

## Deploy a new version

From the repo root (`<sha>` = `git rev-parse --short HEAD`):

```
az acr build --registry plenumwebsiteacr --image lps-projects-utility:<sha> --image lps-projects-utility:latest --platform linux/amd64 --build-arg APP_VERSION=<sha> --source-acr-auth-id "[caller]" --no-logs .
az containerapp update -n lps-projects-utility -g lps-projects-utility-rg --container-name app --image plenumwebsiteacr.azurecr.io/lps-projects-utility:<sha>
```

Check `/api/health`: it shows the version and `db: up`. The ACR build takes longer now (LibreOffice install, ~5 min). Data is in Cosmos, so it survives updates and restarts.

## Open items for you

1. **Email**: set the SMTP password secret. Until then no emails are sent (OTP codes, invitations, notifications):
   `az containerapp secret set -n lps-projects-utility -g lps-projects-utility-rg --secrets smtp-pass=<password>`
   `az containerapp update -n lps-projects-utility -g lps-projects-utility-rg --set-env-vars SMTP_PASS=secretref:smtp-pass`
   Remove `EMAIL_REDIRECT_TO` when real users should receive their own emails.
   **All email is currently switched off** on Azure (`EMAIL_ENABLED=false`). Turn it on with `--set-env-vars EMAIL_ENABLED=true`. First decide about task reminders: with `JOBS_MODE=in-process` they will email about the imported overdue tasks.
   Locally, scheduled jobs run only if `JOBS_MODE` is set in `backend/.env`. Add `EMAIL_ENABLED=false` there to block all local email.
2. **Change the `admin@hoistra.ai` mailbox password** (it was shared in chat), and the cPanel/server credentials of the compromised projectsutility.com host.
3. **Pearity**: enable it in Settings → Integrations, set the real production engine URL, create an API key, and send `docs/pearity-integration.md` to the Pearity team.
4. **Timezone**: Settings → App Settings (currently Asia/Kolkata; Worksuite used Asia/Dubai).
5. **Production hardening**: Cosmos high availability / higher tier, a custom domain + TLS, and removing the workstation firewall rule when not importing.
6. **Code ownership**: confirm the rights to the original BensonRaro code the project started from.
