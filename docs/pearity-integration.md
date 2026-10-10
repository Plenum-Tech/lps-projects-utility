# Pearity ↔ Utility integration (for the Pearity team)

Utility (LPS – Projects Utility) is the **source of truth** for tasks and for Pearity tags.

- **Only Utility generates tags.** Pearity never invents a tag. It asks Utility to get or create the tag (`POST …/tag`), and Utility returns it.
- Every Utility task has **at most one Pearity tag**, shared by the whole organisation and by every user. The first Generate creates it, and every later Generate, by anyone and from either system, reuses it.
- Every tag has a **tag number** (`tagNo`: 1, 2, 3, …). It is the **primary identifier**: users see it as "Tag #12", and links use it. Numbers are handed out in creation order and never reused or changed.
- **Usage is one-to-many**: Utility records each Generate against the tag (who, when, and whether it came from Utility or Pearity).
- A tag's `tagNo`, `tagId` and `tagName` **never change**, even when the task, its brand or its category is renamed later.

## Identifiers at a glance

| Identifier | Example | What it is |
|---|---|---|
| `taskNo` | `GenAI Hub-65`, `PEAR-12`, `#56` | The **task number** users see in Utility. It is the task's code when the task has one, otherwise `#` followed by the global task number. Users can type or paste it into Pearity. |
| `tagNo` | `12` | The **tag number** (primary tag identifier). Sequential, starting at 1. |
| `tagName` | `AJMA-OCT26-PRG-GH-VID3` | The tag itself: the task's tag (see the naming rules). Stable once generated. |
| `projectTag` | `AJMA-OCT26-PRG-GH` | The project's tag: brand, month, type and name. |
| `tagId` | `pt_7k3m9q2x` | Legacy random tag id. It still works everywhere for backward compatibility, but new integrations should use `tagNo`. |
| `taskId` | `66f1c0ffee0000000000abcd` | Utility's internal task id. |

There are two ways in:

1. **Generate in Utility.** A user clicks **Generate** on a task. Utility creates or reuses the tag and opens your production engine in a new tab, using the URL template the Utility admin configured. All values are already filled in. Wherever Utility shows a tag ("Tag #12 · AJMA-OCT26-PRG-GH-VID3"), the tag is a link into Pearity (see the tag link URL below).
2. **Server-to-server API.** Your backend calls the Utility API documented below. You can use it to look up a task by its task number, to create tags from Pearity, to build a "Utility dashboard" inside Pearity, and to resolve or sync tags.

---

## 1. URL templates (set in Utility)

The Utility admin sets two templates in **Settings → Integrations → Pearity**. Both must start with `https://`.

- **Production engine URL template** (required). Utility opens it when a user clicks **Generate**, and returns it as `generateUrl`. For example:

  ```
  https://app.pearity.ai/production/new?tagNo={tagNo}&tag={tagName}&taskNo={taskNo}&taskId={taskId}&brand={brand}&category={category}&project={project}
  ```

- **Tag link URL** (optional). Where a tag opens in Pearity, returned as `tagUrl`. Every tag shown in Utility (the chip on the task and the "Pearity tag" column in the tasks table) links to it in a new tab. **If it is empty, tags open the production engine URL.** For example:

  ```
  https://app.pearity.ai/tags/{tagNo}
  ```

Both templates take the same placeholders:

| Placeholder | Example | Notes |
|---|---|---|
| `{tagNo}` | `12` | **The tag number. Use it as your primary key.** |
| `{tagId}` | `pt_7k3m9q2x` | Legacy random tag id. Still filled in for existing templates. |
| `{tagName}` | `AJMA-OCT26-PRG-GH-VID3` | Stable display name (see the naming rules below). |
| `{taskNo}` | `GenAI Hub-65` or `#56` | The task number users see (see the table above). |
| `{taskId}` | `66f1c0ffee0000000000abcd` | Utility task id. Use it with the API. |
| `{taskCode}` | `GenAI Hub-65` | The task's code. Tasks without a code use `Task-<n>`. |
| `{brand}` | `Ajmal` | The current brand name of the task's project (empty if there is none). |
| `{category}` | `Design` | The current task category (empty if there is none). |
| `{project}` | `Ajmal \| Retainer \| Oct 2026 \| GenAI Hub` | The current project name (empty for standalone tasks). |
| `{taskTag}` | `AJMA-OCT26-PRG-GH-VID3` | The task's tag (same as `{tagName}` once generated). |
| `{projectTag}` | `AJMA-OCT26-PRG-GH` | The project's tag. |
| `{projectCode}` | `GENAIHUB` | The project code. |
| `{title}` | `Video 3 – Launch teaser` | The task title. |
| `{month}` | `2026-10` | The project's month. |
| `{type}` | `Program` | The project type. |
| `{scopeUnit}` | `Video` | The task's scope unit. |
| `{quantity}` | `3` | The task's quantity. |
| `{shortName}` | `Launch teaser` | The task's short name. |
| `{iteration}` | `new` | `new` or `rework`. |
| `{status}` | `in_progress` | The task status. |
| `{priority}` | `medium` | The task priority. |
| `{startDate}` | `2026-10-05` | Start date (YYYY-MM-DD), empty if none. |
| `{dueDate}` | `2026-10-20` | Due date (YYYY-MM-DD), empty if none. |
| `{estimateMinutes}` | `90` | Estimated time in minutes. |

Utility URL-encodes every value (`encodeURIComponent`), so `GenAI Hub-65` arrives as `GenAI%20Hub-65` and `#56` as `%2356`. Decode the query parameters as usual. Treat the URL parameters as hints. Before you save content, confirm the tag with `GET /tags/by-no/{tagNo}`.

`tagUrl` and `generateUrl` are `null` when no template is configured. In Utility's own (signed-in) endpoints, `tagUrl` is also `null` while the integration is turned off.

## 2. Tag naming rules

Every project and every task in Utility has a tag. Utility builds it from abbreviations:

```
project tag = BRAND-MONTH-TYPE-NAME          AJMA-OCT26-PRG-GH
task tag    = <project tag>-<UNIT><QUANTITY>   AJMA-OCT26-PRG-GH-VID3
```

- **Brand**: the brand's short name when set, else an abbreviation ("Ajmal" → `AJMA`, "Homes R Us" → `HRU`, "GITEX" → `GITEX`).
- **Month**: the project's month as `MMMYY` (`OCT26`).
- **Type**: `CMP` (Campaign), `PRG` (Program), `PRJ` (Project); other types are abbreviated.
- **Name**: the project name's initials, numbers and short acronyms kept whole ("GenAI Hub" → `GH`, "Social 360" → `S360`).
- **Unit + quantity**: the task's scope unit and quantity ("Video", 3 → `VID3`).
- Tasks without a scope unit (older tasks) end in `T<task number>`; tasks without a project are `TASK-<task number>`.
- Missing parts are left out. Everything is uppercase letters, digits and `-`.
- **Tags are unique.** If two tasks would get the same tag, the later one gets `-2`, `-3` … appended (`AJMA-OCT26-PRG-GH-VID3-2`).
- A task's tag follows its project and scope unit until the first **Generate on Pearity**. From then on it never changes, so it always matches Pearity's copy. `tagName` is that tag.
- Tags created before October 2026 keep their older `Brand_Category_TaskCode` names.
- `tagNo` is a positive whole number. The legacy `tagId` format is `pt_` followed by 8 characters from `[0-9a-z]` (`^pt_[0-9a-z]{8}$`).

## 3. Server-to-server API

**Base URL:** `https://<utility-host>/api/integrations/pearity/v1`

### Authentication

- **Header:** `Authorization: Bearer <api key>`. Never put the key in a URL or a query string.
- **Getting a key:** a Utility admin creates the key in Settings → Integrations → Pearity → API keys and shares it with you over a secure channel. The key is shown only once. It looks like `pty_` followed by 40 characters.
- **Storage and revocation:** Utility stores only a SHA-256 hash of the key, and the admin can revoke it at any time.
- **Scopes:**
  - `pearity:read`: every `GET` endpoint.
  - `pearity:tags`: `POST /tasks/by-no/tag` and `POST /tasks/:taskId/tag`.
- **Optional IP allowlist:** if the admin configures one, calls from any other IP get `403 ip_not_allowed`. Send Utility your egress IPs.
- **Rate limit:** 600 requests per minute per key. The headers `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` are sent on each response. Above the limit you get `429` with `Retry-After`. Repeated authentication failures from one IP (30 in 15 minutes) are blocked for the rest of that 15-minute window.
- **Audit:** Utility audits every call (key prefix, path, email, status, IP).
- **Caching:** every response is sent with `Cache-Control: no-store` and is read fresh from the database.

### User identity

Pearity users are matched to Utility users **by email**, so each user must have the same email in both systems (matching is case-insensitive). An unknown email gets `404 unknown_user`.

A key can only read what the given email's user can see in Utility. The same visibility rules apply as in the Utility UI. If a task is not visible to that user, the API answers `404 task_not_found`, so you can't probe for tasks that exist.

### Data returned

The API returns only task numbers and codes, titles, status, dates, project, brand, category, the tag, and links. It never returns comments, files, descriptions or other people's personal data. The only person data is the tag's `createdBy` (id and name).

### Task object

```json
{
  "taskId": "66f1c0ffee0000000000abcd",
  "taskCode": "GenAI Hub-65",
  "taskNo": "GenAI Hub-65",
  "title": "Video 3 – Launch teaser",
  "taskTag": "AJMA-OCT26-PRG-GH-VID3",
  "scopeUnit": "Video",
  "quantity": 3,
  "shortName": "Launch teaser",
  "status": "in_progress",
  "dueDate": "2026-10-20T00:00:00.000Z",
  "actualStartAt": "2026-10-08T05:12:44.000Z",
  "actualEndAt": null,
  "updatedAt": "2026-10-08T09:30:00.000Z",
  "project": { "id": "66f0…", "name": "Ajmal | Retainer | Oct 2026 | GenAI Hub", "code": "GENAIHUB", "tag": "AJMA-OCT26-PRG-GH", "month": "2026-10", "type": "Program" },
  "brand": { "id": "66e9…", "name": "Ajmal" },
  "category": { "id": "66e1…", "name": "Design" },
  "utilityUrl": "https://utility.example.com/tasks?task=66f1c0ffee0000000000abcd",
  "pearityTag": {
    "tagNo": 12,
    "tagId": "pt_7k3m9q2x",
    "tagName": "AJMA-OCT26-PRG-GH-VID3",
    "createdAt": "2026-10-08T09:30:00.000Z",
    "createdBy": { "id": "66a0…", "name": "Priya" },
    "tagUrl": "https://app.pearity.ai/tags/12"
  },
  "tagUrl": "https://app.pearity.ai/tags/12",
  "generateUrl": "https://app.pearity.ai/production/new?tagNo=12&tag=AJMA-OCT26-PRG-GH-VID3&taskNo=GenAI%20Hub-65&…"
}
```

- `taskNo` is the task's code when it has one, otherwise `#<number>` (for example `#56`). It is `null` only for very old tasks that have neither.
- `status` is one of `todo`, `in_progress`, `in_review`, `completed` or `rejected`.
- `dueDate` is a date-only value, given as UTC midnight.
- `pearityTag` is `null` while no tag exists. `tagUrl` and `generateUrl` are also `null` then. To create the tag, call `POST /tasks/by-no/tag` (or `POST /tasks/:taskId/tag`). The response includes `tagUrl` and `generateUrl`.

### Recommended flow: look up by task number

1. The user enters or pastes a task number in Pearity (for example `GenAI Hub-65` or `#56`).
2. Call `GET /tasks/by-no?taskNo=<value>&email=<user>`.
3. If `pearityTag` is `null`, show a **Generate** button. Otherwise show "Tag #`tagNo` · `tagName`" and link it to `tagUrl`.
4. On **Generate**, call `POST /tasks/by-no/tag` with `{ taskNo, email }`. Use the returned `tag.tagNo` and `generateUrl`.

Pearity can also go the other way: given a tag number, `GET /tags/by-no/:tagNo` returns the tag and its task.

### `GET /tasks/by-no?taskNo=&email=`

Finds one task by its **task number** and returns the task with its current tag. The tag is always read fresh, and a task has at most one tag, so this is always the latest tag.

How `taskNo` is matched:
- Leading and trailing spaces are trimmed, and repeated spaces count as one. Spaces inside the code matter: `GenAI Hub-65` and `GenAIHub-65` are different.
- A task code matches **exactly, ignoring case**: `genai hub-65` finds `GenAI Hub-65`.
- `#56` matches the task whose number is 56. A bare `56` first tries a task whose code is exactly `56`, then the task numbered 56.
- If more than one task the user can view has the same code, you get `409 ambiguous_task_no`. Use `GET /tasks/:taskId` with the `taskId` instead. Tasks in active projects take precedence over tasks in archived projects.
- A task the user can't view is reported as `404 task_not_found`.

```bash
curl -s -G "https://utility.example.com/api/integrations/pearity/v1/tasks/by-no" \
  --data-urlencode "taskNo=GenAI Hub-65" \
  --data-urlencode "email=priya@example.com" \
  -H "Authorization: Bearer $UTILITY_API_KEY"
```

```json
{
  "task": { "taskId": "66f1c0ffee0000000000abcd", "taskNo": "GenAI Hub-65", "title": "…", "brand": { "…": "…" }, "category": { "…": "…" }, "project": { "…": "…" }, "status": "in_progress", "dueDate": "…", "pearityTag": null, "tagUrl": null, "generateUrl": null },
  "pearityTag": null,
  "tagUrl": null,
  "generateUrl": null
}
```

When the tag exists, `pearityTag` is the tag object (with `tagNo`), and `tagUrl` and `generateUrl` are filled in.

### `POST /tasks/by-no/tag` (scope `pearity:tags`)

Body: `{ "taskNo": "<task number>", "email": "<user email>" }`. The task number is matched exactly as for `GET /tasks/by-no`.

**Idempotent**: returns the task's existing tag, or creates it. It behaves exactly like `POST /tasks/:taskId/tag` below (the same atomic get-or-create, one usage with source `pearity`, and a history entry), and the response also contains the task.

```bash
curl -s -X POST "https://utility.example.com/api/integrations/pearity/v1/tasks/by-no/tag" \
  -H "Authorization: Bearer $UTILITY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"taskNo":"GenAI Hub-65","email":"priya@example.com"}'
```

```json
{
  "created": true,
  "tag": { "tagNo": 12, "tagId": "pt_7k3m9q2x", "tagName": "AJMA-OCT26-PRG-GH-VID3", "createdAt": "…", "createdBy": { "id": "…", "name": "Priya" }, "tagUrl": "https://app.pearity.ai/tags/12" },
  "task": { "taskId": "…", "taskNo": "GenAI Hub-65", "pearityTag": { "tagNo": 12, "…": "…" }, "…": "…" },
  "tagUrl": "https://app.pearity.ai/tags/12",
  "generateUrl": "https://app.pearity.ai/production/new?tagNo=12&…"
}
```

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
{ "tasks": [ { "taskId": "…", "taskNo": "GenAI Hub-65", "…": "…" } ], "nextCursor": "eyJ0IjoxNzI4…" }
```

To get the next page, repeat the call with `&cursor=<nextCursor>`. When `nextCursor` is `null`, there are no more pages. Cursors are opaque, so don't build them yourself.

### `GET /tasks/:taskId?email=`

Returns one task. `:taskId` can be the Utility task id or an upper-case task code without spaces (for example `PEAR-12`). For task numbers typed by users, use `GET /tasks/by-no` instead. The user identified by `email` must be allowed to view the task.

```bash
curl -s "https://utility.example.com/api/integrations/pearity/v1/tasks/66f1c0ffee0000000000abcd?email=priya%40example.com" \
  -H "Authorization: Bearer $UTILITY_API_KEY"
```

```json
{ "task": { "taskId": "66f1c0ffee0000000000abcd", "taskNo": "GenAI Hub-65", "pearityTag": null, "tagUrl": null, "generateUrl": null, "…": "…" } }
```

### `POST /tasks/:taskId/tag` (scope `pearity:tags`)

**Idempotent**: returns the task's existing tag, or creates it. Every call records one usage with source `pearity` and adds a "generated" entry to the task's history in Utility.

- If two calls arrive at the same time, from Pearity or from Utility, both get the **same** tag. This is guaranteed by a unique index on the task.
- Only the call that actually creates the tag takes the next tag number. Reusing a tag never uses up a number.
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
  "tag": { "tagNo": 12, "tagId": "pt_7k3m9q2x", "tagName": "AJMA-OCT26-PRG-GH-VID3", "createdAt": "…", "createdBy": { "id": "…", "name": "Priya" }, "tagUrl": "https://app.pearity.ai/tags/12" },
  "tagUrl": "https://app.pearity.ai/tags/12",
  "generateUrl": "https://app.pearity.ai/production/new?tagNo=12&…"
}
```

It is safe to retry this call after a timeout. Tasks in archived projects get `409 task_read_only`.

### `GET /tags/by-no/:tagNo`

Resolves a **tag number** back to its Utility task. No `email` is needed. The `task` block is a full task object, including `taskNo`, `brand`, `category`, `tagUrl` and `generateUrl`.

```bash
curl -s "https://utility.example.com/api/integrations/pearity/v1/tags/by-no/12" \
  -H "Authorization: Bearer $UTILITY_API_KEY"
```

```json
{
  "tag": {
    "tagNo": 12,
    "tagId": "pt_7k3m9q2x",
    "tagName": "AJMA-OCT26-PRG-GH-VID3",
    "taskId": "66f1c0ffee0000000000abcd",
    "taskNo": "GenAI Hub-65",
    "taskCode": "GenAI Hub-65",
    "brand": { "id": "…", "name": "Ajmal" },
    "category": { "id": "…", "name": "Design" },
    "createdAt": "…",
    "createdBy": { "id": "…", "name": "Priya" },
    "tagUrl": "https://app.pearity.ai/tags/12",
    "usageCount": 4,
    "lastUsedAt": "…",
    "updatedAt": "…"
  },
  "task": { "taskId": "…", "taskNo": "GenAI Hub-65", "title": "…", "tagUrl": "…", "generateUrl": "…", "…": "…" }
}
```

In the `tag` object, `taskCode`, `brand` and `category` are snapshots taken when the tag was created, while `taskNo` is the task's current number. In the `task` block all values are current. `task` is `null` if the task was deleted. A `:tagNo` that is not a positive whole number gets `400 invalid_tag_no`.

### `GET /tags/:tagId`

The same as `GET /tags/by-no/:tagNo`, but looks the tag up by its legacy `tagId` (`pt_…`). It is kept for backward compatibility.

### `GET /tags?updatedSince=&limit=&cursor=`

Bulk sync for your cache, ordered oldest-updated first. Each tag includes `tagNo`, `taskNo` and `tagUrl`.

- Tag names never change, but `updatedAt` moves whenever someone generates against the tag, because `usageCount` and `lastUsedAt` change.
- Tags created before tag numbers existed were numbered once, in creation order, when Utility was upgraded. Their `updatedAt` moved at that point, so an incremental sync picks up their `tagNo`.
- To sync incrementally, pass the largest `updatedAt` you have seen as `updatedSince`.
- `limit` is 1–200 (default 100).

```bash
curl -s "https://utility.example.com/api/integrations/pearity/v1/tags?updatedSince=2026-10-01T00:00:00Z&limit=200" \
  -H "Authorization: Bearer $UTILITY_API_KEY"
```

```json
{ "tags": [ { "tagNo": 12, "tagId": "pt_…", "tagName": "…", "taskId": "…", "taskNo": "GenAI Hub-65", "tagUrl": "…", "…": "…" } ], "nextCursor": null }
```

### Errors

All errors are JSON: `{ "error": "<readable message>", "code": "<machine code>" }`.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_email`, `invalid_status`, `invalid_limit`, `invalid_updated_since`, `invalid_cursor` | Bad query or body |
| 400 | `invalid_task_no` | `taskNo` is missing, empty, longer than 60 characters, or not a task number |
| 400 | `invalid_tag_no` | `:tagNo` is not a positive whole number |
| 401 | `missing_api_key` | No `Authorization: Bearer` header |
| 401 | `invalid_api_key` | Unknown key |
| 401 | `revoked_api_key` | The key was revoked in Utility |
| 403 | `insufficient_scope` | The key lacks the scope this endpoint needs |
| 403 | `ip_not_allowed` | Your IP is not on the admin's allowlist |
| 404 | `unknown_user` | No Utility user has this email |
| 404 | `task_not_found` | The task doesn't exist, or this user can't view it |
| 404 | `tag_not_found` / `not_found` | Unknown tag or endpoint |
| 409 | `ambiguous_task_no` | More than one task the user can view has this task number. Use the `taskId`. |
| 409 | `task_read_only` | The task belongs to an archived project |
| 429 | (rate-limit message) / `too_many_auth_failures` | Slow down. Respect `Retry-After`. |
| 503 | `integration_disabled` | An admin turned the integration off in Utility |

---

## 4. Suggested "Utility dashboard" inside Pearity

This is a page in Pearity that lists the signed-in user's Utility tasks so they can start production in one click.

**Data flow**
1. When the page loads, call `GET /tasks?email=<current user>&status=open&limit=50`. Follow `nextCursor` as the user scrolls (infinite scroll).
2. Every 1–5 minutes, refresh with `updatedSince=<last sync time>` and merge by `taskId`.
3. Cache tags with `GET /tags?updatedSince=` if you show tag pickers elsewhere, keyed by `tagNo`.
4. Offer a "Find task" box where the user pastes a task number, backed by `GET /tasks/by-no` (see the recommended flow above).

**Layout:** a table, or cards on mobile.

| Column | Source |
|---|---|
| Task no. | `taskNo`, linking to `utilityUrl` in a new tab |
| Task | `title` |
| Brand | `brand.name` (or "No brand") |
| Category | `category.name` (or "General") |
| Due | `dueDate`, highlighted when it has passed and the status is not `completed` |
| Status | `status` as a badge |
| Pearity tag | "Tag #`pearityTag.tagNo` · `pearityTag.tagName`" as a chip linking to `tagUrl`, or a muted "Not generated yet" |
| Action | **Generate** (no tag) or **Open tag** (tag exists) |

**Actions**
- **Generate** (no tag yet):
  1. Show a small confirm: "This creates the tag `Brand_Category_Code`." Pearity can't predict the exact name or number, so call the API and show what it returns.
  2. Call `POST /tasks/by-no/tag` (or `POST /tasks/:taskId/tag`) with the user's email.
  3. Open your production view using the returned `tag.tagNo`, either through the returned `generateUrl` or your own internal route.
  4. Update the row in place.
- **Open tag** (tag exists): go to your tag workspace for `pearityTag.tagNo`. If the user starts a new production from there, call the `POST …/tag` endpoint again. It is idempotent and records the usage, so Utility's "Generated by" list stays complete.

**Filters:** Open / All, Brand, Category, Has tag / No tag, and search across the task number and title (filtered on the client within the loaded pages).

**Empty and error states**
- `404 unknown_user`: "Your Pearity email isn't in Utility. Ask your admin to use the same email in both systems."
- `404 task_not_found` from the "Find task" box: "No task with this number, or you can't view it in Utility."
- `409 ambiguous_task_no`: "Several tasks have this number. Pick it from your task list instead."
- `503 integration_disabled`: hide the dashboard and show "Utility integration is turned off."
- No tasks: "No open Utility tasks are assigned to you."

---

## 5. Checklist for going live

1. The Utility admin enables the integration and sets the production engine URL template. Optionally, the admin also sets the tag link URL (for example `https://app.pearity.ai/tags/{tagNo}`).
2. The Utility admin creates an API key with both scopes and shares it securely. It is stored in Pearity's secret manager.
3. Optionally, Pearity sends its egress IPs, and the Utility admin adds them as allowed IPs.
4. Pearity users have the same email in both systems.
5. Smoke test:
   - `GET /tasks?email=<a real user>` returns tasks.
   - `GET /tasks/by-no?taskNo=<a real task number>&email=<user>` returns that task.
   - `POST /tasks/by-no/tag` returns `created: true` the first time and `created: false` after that, with the same `tagNo`.
   - `GET /tags/by-no/<tagNo>` resolves the tag.
