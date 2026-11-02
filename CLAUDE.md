# LPS Projects Utility — working notes for Claude Code

Live at https://app.lps-me.com. Repo: github.com/Plenum-Tech/lps-projects-utility (branch `main`).
Stack: Express 5 + Bun + Mongoose (Azure Cosmos vCore Mongo) in `backend/`; React Router + TanStack Query + shadcn + Tailwind in `frontend/`.

## Working rules (from the owner, Bala)

- **Test locally first.** Finish non-trivial changes, run them against a local copy of the data, and ask "deploy?" — deploy only when told. Small urgent bug fixes can ship directly.
- **Production data is read-only** unless the owner explicitly asks for a change. Read prod only when asked.
- **Never commit local test data**: mockup `*.html`, `local-test-logins.txt`, `overdue-email-sample.html`, `backend/src/scripts/_tmp_*` stay local.
- **Never print secrets**: Mongo URI, SMTP password, OpenAI key, cookies, passwords.
- Push to `origin` = Plenum-Tech/lps-projects-utility, branch `main` (`git push origin HEAD:main`). Never the old BensonRaro repo.
- The owner's terminal is PowerShell; when giving commands to run, write them for PowerShell.

## Product decisions

- **New projects need no approval** (Settings → Projects "Project approval required" stays off). Brand changes, manpower plan versions, and scope / team edits to existing projects by non-leadership do need approval (leadership = Aasim, Rania, Bala).
- **Brands**: only brand creators (Nazeer, env `BRAND_CREATOR_EMAILS`) and leadership create brands. Different scope = different brand. A brand may have several leads and an organisation (ENOC › Zoom).
- **Month migration** (Brands → "Migrate to next month"): brand creators / leadership pick brands; plan lines + projects are copied month by month (up to 12 months), approved at once.
- **Scope = deliverables**: a scope row "15 Video" is Video 1 of 15 … 15 of 15. Tasks pick a deliverable (title "Video 3 – Copy"); several tasks can share one. Scope used = deliverables with tasks. Beyond the total → admin approval (once approved, more tasks on it are fine).
- Projects close at the end of their month (no new tasks); open tasks can still be closed. Archive makes a project read-only.
- Insights is leadership only.

## Local development

- Backend `bun run dev` on :5063, frontend `VITE_API_URL=http://127.0.0.1:5063/api bun run dev --host 127.0.0.1 --port 5183`.
- `backend/.env` and `frontend/.env` are not in git — copy them from the old machine (see `.env.example`).
- Typecheck: backend `./node_modules/.bin/tsc --noEmit -p .` (ignore `_tmp_*` errors), frontend `bun run typecheck`.
- A local copy of prod data lives in a local DB (`ems_prod_copy`); its task number counter may lag behind copied tasks — bump `counters.task` to the max task number if creates fail with "Duplicate value".

## Deploy (Azure)

Container app `lps-projects-utility`, resource group `lps-projects-utility-rg`, registry `plenumwebsiteacr`, container `app`.

1. Commit, then build from a short path (long paths break `az acr build`):
   `git archive HEAD | tar -x -C C:/Users/<you>/b<sha>` and from there
   `az acr build --registry plenumwebsiteacr --image lps-projects-utility:<sha> --image lps-projects-utility:latest --platform linux/amd64 --build-arg APP_VERSION=<sha> --source-acr-auth-id "[caller]" --no-logs .`
2. `az containerapp update -n lps-projects-utility -g lps-projects-utility-rg --container-name app --image plenumwebsiteacr.azurecr.io/lps-projects-utility:<sha>`
3. Poll `https://app.lps-me.com/api/health` until `version` is the new sha; the previous sha's image is the rollback.
4. `git push origin HEAD:main`, delete the build folder.

- Login: `az login --tenant 99514d22-1ecb-4443-8cf7-e07476d0006c --use-device-code` (MFA re-logins are common).
- Scripts against prod: Mongo URI from `az containerapp secret show -n lps-projects-utility -g lps-projects-utility-rg --secret-name mongo-uri --query value -o tsv` (never print it); the Cosmos cluster `lps-pu-mongo` firewall rule `import-workstation` must match the machine's current public IP.
- Logs: Log Analytics workspace `bdd85747-1804-4f41-a713-596cae7d0960`, tables `ContainerAppConsoleLogs_CL` / `ContainerAppSystemLogs_CL` (request logs are JSON: ip, url, status, ua — no user).
- Custom domain app.lps-me.com: CORS_ORIGIN must list every origin used (comma-separated).
