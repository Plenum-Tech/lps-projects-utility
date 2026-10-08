# Pearity ↔ Utility integration (for the Pearity team)

Utility (LPS – Projects Utility) is the **source of truth** for tasks and for Pearity tags.

- Every Utility task has **at most one Pearity tag**, shared by the whole organisation. The first Generate creates it, and every later Generate, by anyone and from either system, reuses it.
- **Usage is one-to-many**: Utility records each Generate against the tag (who, when, and whether it came from Utility or Pearity).
- A tag's `tagId` and `tagName` **never change**, even when the task, its brand or its category is renamed later.

There are two ways in:

1. **Generate in Utility.** A user clicks **Generate** on a task. Utility creates or reuses the tag and opens your production engine in a new tab, using the URL template the Utility admin configured. All values are already filled in.
2. **Server-to-server API.** Your backend calls the Utility API documented below. You can use it to build the "Utility dashboard" inside Pearity, to create tags from Pearity, and to resolve or sync tags.

---

## 1. Production engine URL (Generate from Utility)

The Utility admin sets the template in **Settings → Integrations → Pearity**. The template must start with `https://`. For example:

```
https://app.pearity.ai/production/new?tagId={tagId}&tag={tagName}&taskId={taskId}&taskCode={taskCode}&brand={brand}&category={category}&project={project}
```

| Placeholder | Example | Notes |
|---|---|---|
| `{tagId}` | `pt_7k3m9q2x` | Stable, random, URL-safe. Use it as your primary key. |
| `{tagName}` | `Ajmal_Design_GenAIHub-65` | Stable display name (see naming rules below). |
| `{taskId}` | `66f1c0ffee0000000000abcd` | Utility task id. Use it with the API. |
| `{taskCode}` | `GenAIHub-65` | The task's human code. Tasks without a project use `Task-<n>`. |
| `{brand}` | `Ajmal` | The current brand name of the task's project (empty if there is none). |
| `{category}` | `Design` | The current task category (empty if there is none). |
| `{project}` | `Ajmal \| Retainer \| Oct 2026 \| GenAI Hub` | The current project name (empty for standalone tasks). |

Utility URL-encodes every value (`encodeURIComponent`), so decode the query parameters as usual. Treat the URL parameters as hints. Before you save content, confirm the tag with `GET /tags/{tagId}`.

## 2. Tag naming rules

`tagName = <Brand>_<Category>_<TaskCode>`

- Utility takes each part from the task **at creation time** and stores it as a snapshot. It never renames the tag.
- Each part is sanitized:
  - Accents are removed (`é` becomes `e`).
  - Any run of characters outside `A–Z a–z 0–9 -`, including spaces and underscores, becomes a single `-`.
  - Leading and trailing `-` are trimmed.
  - Each part is capped at 60 characters.
- If a part is missing, it falls back:
  - brand → `NoBrand`
  - category → `General`
- `_` appears only as the separator between the three parts.
- If another task already has the same name (which is rare), Utility appends `-xxxx`, taken from the `tagId`.
- The `tagId` format is `pt_` followed by 8 characters from `[0-9a-z]`. It matches `^pt_[0-9a-z]{8}$`.

Examples:
- `Ajmal Perfumes` / `Social Media` / `GENAI-65` gives `Ajmal-Perfumes_Social-Media_GENAI-65`.
- No brand / no category / `#12` gives `NoBrand_General_Task-12`.

## 3. Server-to-server API

**Base URL:** `https://<utility-host>/api/integrations/pearity/v1`

### Authentication

- **Header:** `Authorization: Bearer <api key>`. Never put the key in a URL or a query string.
- **Getting a key:** a Utility admin creates the key in Settings → Integrations → Pearity → API keys and shares it with you over a secure channel. The key is shown only once. It looks like `pty_` followed by 40 characters.
- **Storage and revocation:** Utility stores only a SHA-256 hash of the key, and the admin can revoke it at any time.
- **Scopes:**
  - `pearity:read`: every `GET` endpoint.
  - `pearity:tags`: `POST /tasks/:taskId/tag`.
- **Optional IP allowlist:** if the admin configures one, calls from any other IP get `403 ip_not_allowed`. Send Utility your egress IPs.
- **Rate limit:** 600 requests per minute per key. The headers `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` are sent on each response. Above the limit you get `429` with `Retry-After`. Repeated authentication failures from one IP (30 in 15 minutes) are blocked for the rest of that 15-minute window.
- **Audit:** Utility audits every call (key prefix, path, email, status, IP).

### User identity

Pearity users are matched to Utility users **by email**, so each user must have the same email in both systems (matching is case-insensitive). An unknown email gets `404 unknown_user`.

A key can only read what the given email's user can see in Utility. The same visibility rules apply as in the Utility UI. If a task is not visible to that user, the API answers `404 task_not_found`, so you can't probe for tasks that exist.

### Data returned

The API returns only task codes, titles, status, dates, project, brand, category, the tag, and links. It never returns comments, files, descriptions or other people's personal data. The only person data is the tag's `createdBy` (id and name).

### Task object

```json
{
  "taskId": "66f1c0ffee0000000000abcd",
  "taskCode": "GenAIHub-65",
  "title": "Diwali hero banner",
  "status": "in_progress",
  "dueDate": "2026-10-20T00:00:00.000Z",
  "actualStartAt": "2026-10-08T05:12:44.000Z",
  "actualEndAt": null,
  "updatedAt": "2026-10-08T09:30:00.000Z",
  "project": { "id": "66f0…", "name": "Ajmal | Retainer | Oct 2026 | GenAI Hub", "code": "GENAIHUB" },
  "brand": { "id": "66e9…", "name": "Ajmal" },
  "category": { "id": "66e1…", "name": "Design" },
  "utilityUrl": "https://utility.example.com/tasks?task=66f1c0ffee0000000000abcd",
  "pearityTag": {
    "tagId": "pt_7k3m9q2x",
    "tagName": "Ajmal_Design_GenAIHub-65",
    "createdAt": "2026-10-08T09:30:00.000Z",
    "createdBy": { "id": "66a0…", "name": "Priya" }
  },
  "generateUrl": "https://app.pearity.ai/production/new?tagId=pt_7k3m9q2x&tag=Ajmal_Design_GenAIHub-65&…"
}
```

- `status` is one of `todo`, `in_progress`, `in_review`, `completed` or `rejected`.
- `dueDate` is a date-only value, given as UTC midnight.
- `pearityTag` is `null` while no tag exists. `generateUrl` is also `null` then. To create the tag, call `POST /tasks/:taskId/tag`. The response includes the `generateUrl`.

### `GET /tasks`

Lists the user's assigned tasks: those where the user is an assignee, or assigned a subtask. Tasks in archived projects are left out. The newest-updated tasks come first.

| Query | Default | Notes |
|---|---|---|
| `email` | (required) | The Pearity user's email |
| `status` | `open` | `open` (anything except `completed`) or `all` |
| `updatedSince` | | ISO 8601. Returns tasks updated since then, or tagged since then. |
| `limit` | `50` | 1–200 |
| `cursor` | | The `nextCursor` value from the previous page |

```bash
curl -s "https://utility.example.com/api/integrations/pearity/v1/tasks?email=priya%40example.com&status=open&limit=50" \
  -H "Authorization: Bearer $UTILITY_API_KEY"
```

```json
{ "tasks": [ { "taskId": "…", "…": "…" } ], "nextCursor": "eyJ0IjoxNzI4…" }
```

To get the next page, repeat the call with `&cursor=<nextCursor>`. When `nextCursor` is `null`, there are no more pages. Cursors are opaque, so don't build them yourself.

### `GET /tasks/:taskId?email=`

Returns one task. `:taskId` can be the Utility task id or the task code (for example `GENAIHUB-65`). The user identified by `email` must be allowed to view the task.

```bash
curl -s "https://utility.example.com/api/integrations/pearity/v1/tasks/66f1c0ffee0000000000abcd?email=priya%40example.com" \
  -H "Authorization: Bearer $UTILITY_API_KEY"
```

```json
{ "task": { "taskId": "66f1c0ffee0000000000abcd", "pearityTag": null, "generateUrl": null, "…": "…" } }
```

### `POST /tasks/:taskId/tag` (scope `pearity:tags`)

**Idempotent**: returns the task's existing tag, or creates it. Every call records one usage with source `pearity` and adds a "generated" entry to the task's history in Utility.

- If two calls arrive at the same time, from Pearity or from Utility, both get the **same** tag. This is guaranteed by a unique index on the task.
- The response status is `201` when the call created the tag and `200` when the tag already existed.

```bash
curl -s -X POST "https://utility.example.com/api/integrations/pearity/v1/tasks/66f1c0ffee0000000000abcd/tag" \
  -H "Authorization: Bearer $UTILITY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"priya@example.com"}'
```

```json
{
  "created": true,
  "tag": { "tagId": "pt_7k3m9q2x", "tagName": "Ajmal_Design_GenAIHub-65", "createdAt": "…", "createdBy": { "id": "…", "name": "Priya" } },
  "generateUrl": "https://app.pearity.ai/production/new?tagId=pt_7k3m9q2x&…"
}
```

It is safe to retry this call after a timeout. Tasks in archived projects get `409 task_read_only`.

### `GET /tags/:tagId`

Resolves a tag back to its Utility task. No `email` is needed, and the task block contains the fields listed above.

```bash
curl -s "https://utility.example.com/api/integrations/pearity/v1/tags/pt_7k3m9q2x" \
  -H "Authorization: Bearer $UTILITY_API_KEY"
```

```json
{
  "tag": {
    "tagId": "pt_7k3m9q2x",
    "tagName": "Ajmal_Design_GenAIHub-65",
    "taskId": "66f1c0ffee0000000000abcd",
    "taskCode": "GenAIHub-65",
    "brand": { "id": "…", "name": "Ajmal" },
    "category": { "id": "…", "name": "Design" },
    "createdAt": "…",
    "createdBy": { "id": "…", "name": "Priya" },
    "usageCount": 4,
    "lastUsedAt": "…",
    "updatedAt": "…"
  },
  "task": { "taskId": "…", "title": "…", "…": "…" }
}
```

In the `tag` object, `taskCode`, `brand` and `category` are snapshots taken when the tag was created. In the `task` block they are the current values. `task` is `null` if the task was deleted.

### `GET /tags?updatedSince=&limit=&cursor=`

Bulk sync for your cache, ordered oldest-updated first.

- Tag names never change, but `updatedAt` moves whenever someone generates against the tag, because `usageCount` and `lastUsedAt` change.
- To sync incrementally, pass the largest `updatedAt` you have seen as `updatedSince`.
- `limit` is 1–200 (default 100).

```bash
curl -s "https://utility.example.com/api/integrations/pearity/v1/tags?updatedSince=2026-10-01T00:00:00Z&limit=200" \
  -H "Authorization: Bearer $UTILITY_API_KEY"
```

```json
{ "tags": [ { "tagId": "pt_…", "tagName": "…", "taskId": "…", "…": "…" } ], "nextCursor": null }
```

### Errors

All errors are JSON: `{ "error": "<readable message>", "code": "<machine code>" }`.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_email`, `invalid_status`, `invalid_limit`, `invalid_updated_since`, `invalid_cursor` | Bad query or body |
| 401 | `missing_api_key` | No `Authorization: Bearer` header |
| 401 | `invalid_api_key` | Unknown key |
| 401 | `revoked_api_key` | The key was revoked in Utility |
| 403 | `insufficient_scope` | The key lacks the scope this endpoint needs |
| 403 | `ip_not_allowed` | Your IP is not on the admin's allowlist |
| 404 | `unknown_user` | No Utility user has this email |
| 404 | `task_not_found` | The task doesn't exist, or this user can't view it |
| 404 | `tag_not_found` / `not_found` | Unknown tag or endpoint |
| 409 | `task_read_only` | The task belongs to an archived project |
| 429 | (rate-limit message) / `too_many_auth_failures` | Slow down. Respect `Retry-After`. |
| 503 | `integration_disabled` | An admin turned the integration off in Utility |

---

## 4. Suggested "Utility dashboard" inside Pearity

This is a page in Pearity that lists the signed-in user's Utility tasks so they can start production in one click.

**Data flow**
1. When the page loads, call `GET /tasks?email=<current user>&status=open&limit=50`. Follow `nextCursor` as the user scrolls (infinite scroll).
2. Every 1–5 minutes, refresh with `updatedSince=<last sync time>` and merge by `taskId`.
3. Cache tags with `GET /tags?updatedSince=` if you show tag pickers elsewhere.

**Layout:** a table, or cards on mobile.

| Column | Source |
|---|---|
| Code | `taskCode`, linking to `utilityUrl` in a new tab |
| Task | `title` |
| Brand | `brand.name` (or "No brand") |
| Category | `category.name` (or "General") |
| Due | `dueDate`, highlighted when it has passed and the status is not `completed` |
| Status | `status` as a badge |
| Pearity tag | `pearityTag.tagName` as a chip, or a muted "Not generated yet" |
| Action | **Generate** (no tag) or **Open tag** (tag exists) |

**Actions**
- **Generate** (no tag yet):
  1. Show a small confirm: "This creates the tag `Brand_Category_Code`." Pearity can't predict the exact name, so call the API and show the name it returns.
  2. Call `POST /tasks/:taskId/tag` with the user's email.
  3. Open your production view using the returned `tag.tagId`, either through the returned `generateUrl` or your own internal route.
  4. Update the row in place.
- **Open tag** (tag exists): go to your tag workspace for `pearityTag.tagId`. If the user starts a new production from there, call `POST /tasks/:taskId/tag` again. It is idempotent and records the usage, so Utility's "Generated by" list stays complete.

**Filters:** Open / All, Brand, Category, Has tag / No tag, and search across the code and title (filtered on the client within the loaded pages).

**Empty and error states**
- `404 unknown_user`: "Your Pearity email isn't in Utility. Ask your admin to use the same email in both systems."
- `503 integration_disabled`: hide the dashboard and show "Utility integration is turned off."
- No tasks: "No open Utility tasks are assigned to you."

---

## 5. Checklist for going live

1. The Utility admin enables the integration and sets the production engine URL template.
2. The Utility admin creates an API key with both scopes and shares it securely. It is stored in Pearity's secret manager.
3. Optionally, Pearity sends its egress IPs, and the Utility admin adds them as allowed IPs.
4. Pearity users have the same email in both systems.
5. Smoke test:
   - `GET /tasks?email=<a real user>` returns tasks.
   - `POST /tasks/:id/tag` returns `created: true` the first time and `created: false` after that.
   - `GET /tags/:tagId` resolves the tag.
