# API contract: set-password links (Worksuite migration)

This is the backend contract for the **"Needs password"** UI in Manage Users and the public **`/set-password/:token`** page.

Accounts imported from Worksuite (`bun run import:worksuite`) have no usable password, and their `passwordSetupRequired` flag is `true`. Such a user can't sign in until they open a one-time link and choose a password.

## User object

`GET /api/users` and every other user payload now include this field:

```ts
passwordSetupRequired: boolean // true = must set a password via a link before signing in
```

The field is also added to the frontend `User` type.

### Manage Users filter

`GET /api/users?passwordSetup=required` returns only users who still need a password. `passwordSetup=done` returns the others. The filter combines with the existing `search`, `role`, `department`, `limit` and `offset` parameters, and the response shape is unchanged: `{ users, total, limit, offset }`.

## Login

`POST /api/auth/login` for an account with `passwordSetupRequired: true` always responds **403**, whatever password is sent:

```json
{ "error": "Your account needs a password — use the link from your administrator.", "code": "password_setup_required" }
```

The login page shows `error` as-is. It can also check for `code === "password_setup_required"`.

## Admin endpoints (admin role, session cookie)

### `POST /api/users/:id/password-link`

Body (optional): `{ "sendEmail": boolean }`. The default is `true`, and the email is only sent when SMTP is configured.

**201** response:

```json
{
  "setupUrl": "https://app.example.com/set-password/<token>",
  "expiresAt": "2026-10-14T10:00:00.000Z",
  "emailed": true,
  "passwordSetupRequired": true
}
```

- Every call creates a **new** link and revokes the user's older unused links. "Copy link" and "Send link" are therefore the same call. Pass `sendEmail: false` for Copy link.
- `emailed: false` means SMTP isn't configured (or `sendEmail` was false). In that case the admin must share `setupUrl` manually, so show it with a copy button.
- The endpoint works for any user, so it also serves as an admin-initiated password reset.
- Errors: **404** `{ error: "User not found" }`, **401** / **403** when the caller isn't an admin.

### `POST /api/users/password-links` (bulk: "Send links to all")

The body takes one of two forms:

- `{ "userIds": ["<id>", …], "sendEmail"?: boolean }`, with at most 500 ids
- `{ "allPending": true, "sendEmail"?: boolean }`, which covers every user with `passwordSetupRequired: true` (up to 500)

**201** response:

```json
{
  "results": [
    { "userId": "<id>", "status": "created", "setupUrl": "…", "expiresAt": "…", "emailed": true },
    { "userId": "bad", "status": "invalid" },
    { "userId": "<id>", "status": "not_found" }
  ],
  "emailConfigured": true
}
```

Errors: **400** when `userIds` is missing or empty, or has more than 500 ids.

When `emailConfigured` is false, the UI shows the created links for copying, for example as a list or a CSV download.

## Public endpoints (no auth; the token is the credential)

Both endpoints are rate-limited to **10 requests per 15 minutes per IP**, and exceeding the limit returns **429** `{ error }`. Tokens are masked in request logs.

### `GET /api/password-setup/:token`

| Status | Response | Meaning |
|---|---|---|
| **200** | `{ "name": "…", "email": "…", "expiresAt": "…" }` | The page shows "Set a password for {email}" |
| **404** | `{ "error": "This link isn't valid" }` | Unknown or malformed token |
| **410** | `{ "error": "…", "reason": "used" \| "expired" \| "revoked" }` | The link can't be used |

Suggested UI for each 410 `reason`:

| `reason` | UI |
|---|---|
| `used` | "already used — sign in", with a link to `/login` |
| `expired` | "ask your administrator for a new link" |
| `revoked` | "a newer link was sent — use the latest one" |

### `POST /api/password-setup/:token`

Body: `{ "password": string }`, 8 to 128 characters.

**200** response: `{ "user": User }`. The **session cookie is set**, so the user is signed in and the page can navigate to `/` the same way login does. The user's `passwordSetupRequired` is now `false`.

Errors:

- **400** `{ error }` when the password is too short or too long
- **404** or **410** as for `GET`; a second submit gets 410 with `reason: "used"`

## Token rules (for copy text)

- Each link is valid for **7 days** and works **once**.
- Issuing a new link invalidates the previous unused ones.
- Only a SHA-256 hash of the token is stored, so a link can't be shown again later. Create a new one instead.

## Suggested UI (from prompts/worksuite-migration.md)

**Manage Users:**

- A "Needs password" badge where `passwordSetupRequired` is true.
- A "Needs password" filter using `passwordSetup=required`.
- Row actions: **Send set-password link** (`sendEmail: true`) and **Copy link** (`sendEmail: false`, then copy `setupUrl`).
- A bulk **Send links to all** action using `allPending: true`.

**`/set-password/:token` page:**

- A public route styled like the login page.
- Load the preview with `GET`, then show the password and confirm fields.
- `POST`, then navigate to `/`.
