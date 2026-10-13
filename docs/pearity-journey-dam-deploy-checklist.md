# Pearity journey + DAM write-back — Utility deploy checklist

**Audience:** Utility project lead (or their agent).  
**Scope:** Deploy Utility only. Pearity is already deployed with `UTILITY_*` env vars.  
**Do not merge/push unless you are the Utility deploy owner.** The feature work is already on a branch (not main).

## Branch

| Item | Value |
|---|---|
| Repo | `Plenum-Tech/lps-projects-utility` |
| Branch | `feat/pearity-journey-dam-writeback` |
| Commit | `b0f94f8` (or later on that branch) |
| URL | https://github.com/Plenum-Tech/lps-projects-utility/tree/feat/pearity-journey-dam-writeback |

Related API contract: [`docs/pearity-integration.md`](./pearity-integration.md) (scopes, endpoints, error codes).

## What this branch adds

- New API key scope: **`pearity:write`**
- Journey timeline write APIs:
  - `POST /api/integrations/pearity/v1/tasks/:taskId/events`
  - `POST /api/integrations/pearity/v1/tasks/by-no/events`
- DAM asset URL write APIs:
  - `POST /api/integrations/pearity/v1/tasks/:taskId/assets`
  - `POST /api/integrations/pearity/v1/tasks/by-no/assets`
- Utility task history UI labels for Pearity journey actions
- Docs updates in `docs/pearity-integration.md`

No Mongo migration is required (models are additive).

## Steps

### 1. Review the branch

1. Check out or open `feat/pearity-journey-dam-writeback`.
2. Confirm the files above are present (controller, routes, `ApiKey` scopes, `PearityTaskAsset`, task history UI, docs).
3. Do **not** treat main as the source of this work until you merge this branch yourself.

### 2. Merge using your normal release process

1. Open a PR from `feat/pearity-journey-dam-writeback` into your deploy branch / `main` (your process).
2. Review and merge when ready.
3. Deploy **backend and frontend** so the new endpoints and timeline labels both ship.

### 3. Deploy Utility

1. Run your usual Azure Container Apps / pipeline deploy for Utility.
2. Confirm the Utility host is healthy after rollout.
3. Note the public base URL (example shape):  
   `https://lps-projects-utility.<env>.azurecontainerapps.io`  
   Pearity’s `UTILITY_BASE_URL` must point at this host (already configured on Pearity DEV/PROD).

### 4. Enable the Pearity integration

1. Sign in as a Utility admin.
2. Go to **Settings → Integrations → Pearity**.
3. Ensure the integration is **enabled** (disabled → API returns `503 integration_disabled`).

### 5. API key scopes (required for write-back)

Pearity calls Utility with a Bearer key (`pty_…`). That key **must** include:

- `pearity:read`
- `pearity:tags`
- **`pearity:write`** ← new; without this, journey/DAM posts fail with `403 insufficient_scope`

Actions:

1. **Settings → Integrations → Pearity → API keys**.
2. If the existing key was created before `pearity:write` existed, **create a new key** with all three scopes (or rotate).
3. Share the new key with the Pearity ops owner over a secure channel only.
4. Pearity ops updates `UTILITY_API_KEY` on Pearity DEV/PROD if the key changed.
5. Never paste the key into chat, tickets, or git.

### 6. Optional IP allowlist

1. If Pearity API keys use an IP allowlist, add Pearity Azure Container Apps egress IPs.
2. Missing IPs → `403 ip_not_allowed`.

### 7. Smoke-test write APIs

Base URL:

```text
https://<utility-host>/api/integrations/pearity/v1
```

Header on every call:

```text
Authorization: Bearer <UTILITY_API_KEY>
```

**7a. Read still works**

```bash
curl -s -G "https://<utility-host>/api/integrations/pearity/v1/tasks/by-no" \
  --data-urlencode "taskNo=<known-task-no>" \
  --data-urlencode "email=<known-user@example.com>" \
  -H "Authorization: Bearer $UTILITY_API_KEY"
```

Expect `200` with a task object.

**7b. Journey event (must not be `403 insufficient_scope`)**

```bash
curl -s -X POST "https://<utility-host>/api/integrations/pearity/v1/tasks/by-no/events" \
  -H "Authorization: Bearer $UTILITY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "<known-user@example.com>",
    "taskNo": "<known-task-no>",
    "action": "pearity_job_started",
    "details": {
      "tagNo": 12,
      "tagName": "EXAMPLE-TAG",
      "jobId": "smoke-test",
      "pearityUrl": "https://app.pearity.ai/production"
    }
  }'
```

Expect `2xx`. Then open that task in Utility → **task history** → confirm a Pearity journey entry appears.

Allowed `action` values:

- `pearity_job_started`
- `pearity_job_completed`
- `pearity_job_failed`
- `pearity_saved_to_dam`
- `pearity_review_submitted`
- `pearity_review_approved`
- `pearity_review_changes_requested`
- `pearity_review_rejected`

**7c. DAM asset link (optional but recommended)**

```bash
curl -s -X POST "https://<utility-host>/api/integrations/pearity/v1/tasks/by-no/assets" \
  -H "Authorization: Bearer $UTILITY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "<known-user@example.com>",
    "taskNo": "<known-task-no>",
    "url": "https://example.com/media/smoke-test.mp4",
    "title": "Smoke test asset",
    "damAssetId": "smoke-1",
    "tagNo": 12,
    "jobId": "smoke-test",
    "pearityUrl": "https://app.pearity.ai/dam"
  }'
```

Expect `2xx`. Task history should show saved-to-DAM and a short comment/link.

### 8. End-to-end with Pearity

Prerequisites: Utility deployed, key has `pearity:write`, same user email in Utility and Pearity.

1. In Pearity, open an assigned Utility task → start Generate / Production.
2. In Utility task history, confirm job started / completed (or failed) events appear.
3. From Pearity, Save to DAM → Utility shows asset link + `pearity_saved_to_dam`.
4. If nothing appears: check key scopes, integration enabled, and that Pearity `UTILITY_BASE_URL` matches this Utility host.

### 9. Done criteria

- [ ] Branch merged and Utility backend + frontend deployed
- [ ] Pearity integration enabled in Utility settings
- [ ] API key includes `pearity:read`, `pearity:tags`, `pearity:write`
- [ ] Pearity `UTILITY_API_KEY` updated if the key was rotated
- [ ] Smoke `POST …/events` returns 2xx (not 403/503)
- [ ] Task history shows Pearity journey entry
- [ ] Optional: `POST …/assets` + DAM link visible on the task
- [ ] Optional E2E: Generate + Save to DAM from Pearity writes into Utility

## Pearity side (already done — do not block on this)

Pearity DEV and PROD are on the integration images with:

- `UTILITY_BASE_URL` → Utility host
- `UTILITY_API_KEY` → Bearer key

Pearity fails soft if Utility write APIs are missing or the key lacks `pearity:write`. After this Utility deploy (and key update if needed), no further Pearity deploy is required for journey/DAM write-back unless the key is rotated.

## Failure quick reference

| Symptom | Likely cause |
|---|---|
| `403 insufficient_scope` | Key missing `pearity:write` |
| `503 integration_disabled` | Pearity integration toggled off in Utility |
| `403 ip_not_allowed` | Pearity egress IP not on allowlist |
| `401 invalid_api_key` / `revoked_api_key` | Wrong or revoked key; update Pearity env |
| `404 unknown_user` | Email mismatch between Pearity and Utility |
| Events never show in UI | Old Utility build still running, or frontend not redeployed |

## Notes for agents

- Deploy **Utility only** from this checklist. Do not change Pearity unless rotating `UTILITY_API_KEY`.
- Prefer merge via PR; do not force-push shared branches.
- Do not commit secrets, keys, or `.env` files.
- Full request/response shapes and error codes: `docs/pearity-integration.md`.
