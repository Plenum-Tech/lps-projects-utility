# User Invitations

## Goal

Admins can invite people by email, like Worksuite's "Invite member". The admin enters one or more email addresses with a role, a department and optionally projects. Each person gets an email with a secure link, valid for 7 days, and sets their own name and password to join. The Users page gains an **Invitations** list for tracking, resending and revoking invites.

The existing direct **Add user** (an admin sets the password) stays as it is.

Out of scope, by the user's choice: a shareable join link, heads inviting people, CSV import.

## Data model

### Invitation (`backend/src/models/Invitation.ts`), new

```ts
email: string                 // lowercased, trimmed
role: "employee" | "head" | "admin"
department?: ObjectId | null  // required when role = head (same rule as createUser)
projects: ObjectId[]          // optional; joined as members on accept (max 20)
message?: string              // optional personal note shown in the email (max 500, escaped)
tokenHash: string             // sha256 of the random token; the plain token is never stored
status: "pending" | "accepted" | "revoked"
expiresAt: Date               // now + 7 days; "expired" = pending && expiresAt < now (derived, not stored)
invitedBy: ObjectId
lastSentAt: Date, sendCount: number
acceptedAt?: Date | null, acceptedUser?: ObjectId | null
revokedAt?: Date | null, revokedBy?: ObjectId | null
```

Indexes:
- `{ tokenHash: 1 }` unique
- `{ email: 1 }`, partial unique where `status: "pending"`, so there is at most one open invite per email
- `{ status: 1, createdAt: -1 }`

**Token**: 32 random bytes (`crypto.randomBytes`), encoded as base64url. Only the SHA-256 hash is stored. The token is never logged.

### Other changes

- `Notification` type: `user_joined`, sent to the inviter when someone accepts. It is gated by a new email preference, `emailPreferences.teamUpdates` (default true).
- `ActivityLog` actions: `user_invited`, `invitation_resent`, `invitation_revoked`, `invitation_accepted`.

## Backend endpoints

### Admin: `/api/invitations` (`requireAuth` + `requireRole("admin")`)

| Method | Path | Notes |
|---|---|---|
| POST | `/` | Body `{ emails: string[] (1-50), role, department?, projects?, message? }`. Returns `{ results: [{ email, status: "invited" \| "resent" \| "already_user" \| "invalid", invitation?, acceptUrl? }] }` (detailed below). |
| GET | `/` | Filters `status=pending\|accepted\|expired\|revoked`, `search` (email), plus pagination. Returns `{ invitations, total, limit, offset, counts: { pending, accepted, expired, revoked } }`, with invitedBy, department and projects populated. |
| POST | `/:id/resend` | Pending or expired invites only. Rotates the token, sets `expiresAt` to now + 7 days, sends the email again and returns `{ invitation, acceptUrl }`. Limited to one resend per invite every 2 minutes (429). |
| DELETE | `/:id` | Revokes a pending invite (status becomes revoked). Accepted invites can't be revoked (409). |

Notes on `POST /`:
- Each email is validated. Emails that already belong to a user come back as `already_user`.
- An existing pending invite for the same email is refreshed: new token, new expiry, and role, department and projects updated. It comes back as `resent`.
- `acceptUrl` is returned **only to the admin, once per send**, so they can copy the link if SMTP fails.

### Public: `/api/invitations/accept/:token` (strict rate limit: 10 per 15 minutes per IP)

| Method | Path | Notes |
|---|---|---|
| GET | `/:token` | Returns `{ email, role, department: { name } \| null, invitedBy: { name }, expiresAt }`. Errors: 404 for an unknown token; 410 with `{ error, reason: "expired" \| "revoked" \| "accepted" }`. |
| POST | `/:token` | Body `{ name, password }`; the password must be at least 8 characters, the same rule as today. |

On a successful `POST`:
1. In a transaction where available, otherwise in careful order:
   - Create the user with the invite's email, role and department, and `emailPreferences` defaults.
   - Add the user to each invited project that still exists and isn't archived, as a member with `hourlyRate` = the user's rate (0).
   - Mark the invite `accepted`.
2. Then **sign the user in** with the same JWT cookie as `/auth/login`, and return `{ user }`.
3. Notify the inviter with `user_joined` (in-app and email), and send `project_member_added` for each project joined.
4. Log `invitation_accepted`.

Edge cases:
- If a user with that email was created meanwhile (for example via Add user), return 409 "An account with this email already exists — sign in instead".
- If the department was deleted, the user joins with `department: null`. If the role was head, they join as employee and the response notes this.

### Email

`invitationTemplate` in `lib/email.ts`:
- Subject: "{inviterName} invited you to join EMS".
- Body: role, department, the personal message (escaped), a **Join EMS** button linking to `${APP_URL}/invite/<token>`, the expiry date, and the line "If you weren't expecting this, ignore this email".

Sent with `sendEmail` directly, because the recipient has no account yet. `EMAIL_REDIRECT_TO` still applies in dev. A send failure doesn't fail the request, and the result row still carries `acceptUrl`.

## Frontend

### `/admin/users` gets two tabs: **Users** | **Invitations** (tab stored in `?tab=`)

**Users tab**
- The existing table and **Add user** stay.
- Add filters if they're missing: search (name or email), role, department.
- Add a header button **Invite people** next to Add user.

**Invite people dialog** (`components/users/invite-dialog.tsx`)
- Email chips input: paste or type addresses, split on commas, spaces and new lines; validates each one, removes duplicates, max 50.
- Role and department fields (department is required for head), a projects multi-select (optional), and a personal message (optional).
- After **Send invites**, a results step lists each email with its outcome: Invited / Re-sent / Already a user / Invalid. Each sent row has a **Copy link** button, for when email delivery fails.

**Invitations tab** (`components/users/invitations-table.tsx`)
- Status filter chips with counts: Pending · Accepted · Expired · Revoked · All. Plus search.
- Columns: email, role, department, projects, invited by, sent (relative time, with "sent N×" if resent), expires or accepted date, status badge.
- Row actions: **Resend** and **Revoke** for pending or expired invites, with a confirm dialog for revoke. Resend shows a toast with a **Copy link** action.
- Designed empty, loading and error states. On mobile the table becomes stacked cards.

### Public page `/invite/:token` (`routes/invite.$token.tsx`, **outside** the protected layout)

- A centred card in the same visual style as the login page.
- **Valid invite**: "Join EMS — {inviter} invited you as {role} in {department}". The email is read-only. Fields: full name, password and confirm password, with strength hints and a show/hide toggle. Clicking **Create account** signs the user in and goes to `/dashboard`, with a welcome toast.
- **Expired, revoked or used**: a clear message plus "Ask your admin for a new invite", and a **Go to sign in** button for the used case.
- **Unknown token**: a "This invite link isn't valid" state.
- **Already signed in as someone else**: "You're signed in as X. Sign out to accept this invite", with a sign-out button.

### Other frontend changes

- **Notification bell**: an icon for `user_joined`, linking to `/admin/users?tab=invitations`.
- **Profile**: a "Team updates" email switch, shown to admins only.

## Edge cases

- Emails are compared lowercase and trimmed, so `Bala.R@Plenum-Tech.com` matches `bala.r@plenum-tech.com`.
- Revoking or resending an invite immediately invalidates the old link, because the token hash is rotated or the status changes.
- An old link from before a resend returns 404, the same as an unknown token. This doesn't leak whether an invite exists.
- An invited project that is later archived or deleted is skipped on accept.
- Users who accept an invite are ordinary users. Admins can still edit them, delete them or reset their password from the Users tab.
- The token never appears in server logs: the morgan format skips `/api/invitations/accept/*` paths, or the token is masked.

## Affected files

**backend**
- models: `Invitation.ts` (new), `Notification.ts`, `ActivityLog.ts`, `User.ts` (`teamUpdates` preference)
- controllers: `invitations.ts` (new)
- routes: `invitations.ts` (new), mounted in `server.ts`
- lib: `email.ts` (template), `notifications.ts` (`user_joined`)
- other: `server.ts` (rate limit on the accept path, log masking), `controllers/auth.ts` (export the shared "issue session cookie" helper for reuse)

**frontend**
- routes: `routes.ts`, `routes/invite.$token.tsx` (new), `routes/admin/users.tsx` (tabs)
- components: `components/users/{invite-dialog, invitations-table, email-chips-input}.tsx`, `notification-bell.tsx`, the profile email preferences card
- hooks: `use-invitations.ts`
- `types.ts`

## Done when

- `bun run typecheck` passes in both apps.
- An admin invites two addresses: one new, one an existing user. The results show "Invited" and "Already a user". The email arrives (or redirects to `EMAIL_REDIRECT_TO`) with a working **Join EMS** button.
- Opening the link shows the invite and lets the person set their name and password. They land on `/dashboard`, signed in, with the right role and department, and are a member of the selected projects.
- The admin gets a `user_joined` notification. The invite shows **Accepted**.
- After Resend, the old link fails and the new one works. After Revoke, the link shows the revoked message.
- An invite past its 7 days shows **Expired** and can be resent.
- An employee calling the admin endpoints gets 403. The public accept endpoint returns 429 after 10 tries in 15 minutes.
