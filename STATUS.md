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
- **Reports**: Delivery Pulse (incl. Brands › projects › people: each brand's projects, tasks and assignees for the period; Team map coverage table per brand, counted from 1 Jun 2026 — `bun run delivery:settings -- --team-map-start YYYY-MM-DD` moves the date; brands without a configured map use their projects' members), task, time-log (with an Employee › Project › Task breakdown, stacked chart, and a formatted Excel export: Summary, Breakdown, Tasks, By employee, By project, Time logs), weekly timesheet, HR reports, activity log.
- **HR**: employees and invitations, departments, leaves (heads approve their department), attendance, documents, performance reviews (manual; AI optional), feedback, announcements, **training** (admins upload a .pptx/.pdf deck and assign it; employees must read every slide, then tick the acknowledgement and complete; admins track and export progress, send reminders).
- **Dashboard**: My dashboard with a period filter (7d–1y/all); Organisation view.
- **Settings**: company, address, app (timezone, date format), profile, notifications, security, task/project/time-log/leave/meeting/delivery/brands, integrations (Pearity).
- **Auth**: set-password links, forgot password with an emailed 6-digit code.
- **Pearity**: a Generate button (one shared tag per task) and a server-to-server API (`docs/pearity-integration.md`).

## Data

- LPS Brands (Worksuite company 18) imported into **both** local `ems` and Azure Cosmos from the 9 Oct 2026 dump (`projectsutility_new (2).sql`): 59 users, 20 departments, 498 projects (94 brands), 9,642 tasks, 168 subtasks, comments, history, 2,206 time logs.
- **Task numbers = Worksuite task ids.** An imported task's `#number` is its Worksuite `tasks.id` (e.g. #13655), shown in the task header and used by Pearity's `taskNo`. New tasks auto-increment from the highest number (counter at 13,699 → next is #13,700). The importer keeps this rule on re-imports; `bun run renumber:worksuite [--dry-run]` applies it to data imported before 9 Oct 2026. Pre-change backups: `Documents\projectutility\*pre-renumber.gz` (local) and `lps-cosmos-backup-*-pre-renumber.gz` (Azure).
- **Re-import a newer dump** (safe and idempotent; keeps passwords, brands and app-side edits), from `backend/`:
  `bun run import:worksuite -- --sql "<dump.sql>" --backup "<backup.tar.gz>" --company 18 --skip-files --dry-run --confirm`, then the same without `--dry-run`.
- **Attachments**: not imported. The server backup didn't contain the files.
- **Local backups**: `Documents\projectutility\ems-backup-*.gz` (and `lps-cosmos-backup-*.gz` for Azure). Restore with `docker exec ems-mongo mongorestore --drop --gzip --archive=/data/db/<file>`. Run the command from PowerShell, not Git Bash, or set `MSYS_NO_PATHCONV=1` first.

## Deploy a new version

From the repo root (`<sha>` = `git rev-parse --short HEAD`):

```
az acr build --registry plenumwebsiteacr --image lps-projects-utility:<sha> --image lps-projects-utility:latest --platform linux/amd64 --build-arg APP_VERSION=<sha> --source-acr-auth-id "[caller]" --no-logs .
az containerapp update -n lps-projects-utility -g lps-projects-utility-rg --container-name app --image plenumwebsiteacr.azurecr.io/lps-projects-utility:<sha>
```

Check `/api/health`: it shows the version and `db: up`. The ACR build takes longer now (LibreOffice install, ~5 min). Data is in Cosmos, so it survives updates and restarts.

## Public website link

lps-me.com (source `Documents\Websites\LPS-Brands`, Azure Container App `lps-website` in *LPS-Subscription*) links to this app from **Menu → Projects Utility** and the footer's **Team login**. The URL is `PROJECTS_UTILITY_URL` in `src/data/navData.ts`. Pre-change image kept as `lpswebsite.azurecr.io/lpswebsite:rollback-2026-10-09`.

## Open items for you

1. **Email** (SMTP2GO: `mail-eu.smtp2go.com:2525`, STARTTLS, user `projectsutility.com`, from `info@projectsutility.com`; all set on Azure and in the local `.env`). Two steps left for you:
   - set the password: `az containerapp secret set -n lps-projects-utility -g lps-projects-utility-rg --secrets smtp-pass=<password>` (the app's `SMTP_PASS` already reads this secret; a new revision picks it up)
   - switch email on: `az containerapp update -n lps-projects-utility -g lps-projects-utility-rg --set-env-vars EMAIL_ENABLED=true`
   Check it in Settings → Notifications (SMTP status). `EMAIL_REDIRECT_TO=bala.r@plenum-tech.com` still routes every email to you; remove it when real users should receive their own. With `JOBS_MODE=in-process`, task reminders will email about the imported overdue tasks once email is on.
   Locally, `SMTP_PASS` is blank (emails are skipped); add `EMAIL_ENABLED=false` to `backend/.env` to be sure nothing goes out.
2. **Change the `admin@hoistra.ai` mailbox password** (it was shared in chat), and the cPanel/server credentials of the compromised projectsutility.com host.
3. **Pearity**: enable it in Settings → Integrations, set the real production engine URL, create an API key, and send `docs/pearity-integration.md` to the Pearity team.
4. **Timezone**: Settings → App Settings (currently Asia/Kolkata; Worksuite used Asia/Dubai).
5. **Production hardening**: Cosmos high availability / higher tier, a custom domain + TLS, and removing the workstation firewall rule when not importing.
6. **Code ownership**: confirm the rights to the original BensonRaro code the project started from.
