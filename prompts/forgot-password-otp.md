# Forgot Password with Email OTP

## Goal

From the sign-in page, a user who forgot their password:
1. Enters their **registered email**.
2. Receives a **6-digit one-time code (OTP)** by email.
3. Enters the code. It is validated against the stored code.
4. Enters a **new password twice** (new + confirm, which must match).
5. The password is updated, and the user is signed in.

The same flow works for imported users who never set a password, which clears `passwordSetupRequired`. The admin set-password links stay as they are.

## Security rules

- **No account enumeration**: requesting a code always returns the same generic message ("If an account exists for that email, we've sent a 6-digit code"), whether or not the email exists or is active. The response time is padded so the two cases look the same.
- **Code**:
  - 6 digits from a cryptographically secure source.
  - Stored only as **HMAC-SHA256(code, JWT_SECRET-derived key)**.
  - Valid for **10 minutes** and **single use**.
  - Requesting a new code invalidates the previous one.
- **Attempts**: at most **5 wrong guesses** per code. After that the code is locked and a new one must be requested. The comparison is constant-time.
- **Throttling**:
  - Resend cooldown of **60 s** per email.
  - At most **5 codes per email per hour**.
  - IP rate limits on all three endpoints: 10 requests per 15 minutes for request and verify, 10 for complete.
- **Reset token**: a correct code returns a **reset token**. It is random, hashed in the database, valid for **15 minutes**, single use, and bound to that user. Only this token can complete the reset.
- **New password**: at least 8 characters with the same strength rules as elsewhere. `password === confirmPassword` is checked on **both client and server**. It may not equal the current password.
- **After a reset**:
  - The password is hashed (bcrypt, the existing hook) and `passwordSetupRequired` is cleared.
  - All outstanding codes and reset tokens for the user are invalidated.
  - Any open set-password links are invalidated.
  - **Every other session is signed out**: `User.tokenVersion` is bumped, and `requireAuth` rejects JWTs carrying an older version (added if missing).
  - An activity-log entry `password_reset` is written.
  - A **"Your password was changed"** confirmation email is sent, with time and IP.
- **Email**: a "Your password reset code" template showing the code in large type, saying it expires in 10 minutes, and saying "If you didn't request this, ignore this email."
  - When SMTP isn't configured: the request still returns the generic success. **In development only** (`NODE_ENV !== production`), the code is logged to the server console for testing. In production it is never logged.
  - `EMAIL_REDIRECT_TO` still applies.
- **Logs**: codes and tokens never appear in logs or URLs; they're sent only in POST bodies.

## Backend

**Model `PasswordResetCode`**: `user`, `emailLower`, `codeHash`, `expiresAt` (TTL index), `attempts`, `usedAt`, `resetTokenHash?`, `resetTokenExpiresAt?`, `ip`, `createdAt`.

**Public routes** (`/api/auth/password-reset/*`):

| Method | Path | Body | Responses |
|---|---|---|---|
| POST | `/request` | `{ email }` | Always 200 `{ message, resendAfterSeconds: 60 }`. Generic, as above. |
| POST | `/verify` | `{ email, code }` | 200 `{ resetToken, expiresInSeconds }`. 400 `{ error: "Invalid or expired code", attemptsLeft }`. 429 when locked or throttled. |
| POST | `/complete` | `{ resetToken, password, confirmPassword }` | 200, sets the session cookie, returns `{ user }`. 400 if the passwords don't match or are too weak. 410 if the token is expired or used. |

Inactive or deleted users never receive codes, and they still get the generic response.

## Frontend

- **Login page**: a **"Forgot password?"** link under the password field, which goes to `/forgot-password`. It pre-fills the email if one was typed.
- **`/forgot-password`**: a public page in the same style as login, with a 3-step card:
  1. **Email**: an email field and **Send code**. The success message is always the generic one.
  2. **Code**: a 6-box OTP input with auto-advance, paste support and numeric keypad on mobile.
     - The page shows "Code sent to b•••@plenum-tech.com" (masked).
     - A **Resend code** button counts down 60 s.
     - Wrong codes show "Incorrect code — N attempts left". When locked, it shows "Too many attempts — request a new code".
     - The 10-minute expiry is shown as a countdown.
  3. **New password**: **New password** and **Confirm new password** fields.
     - A strength meter, hints, and show/hide (reusing `new-password-fields.tsx`).
     - "Passwords don't match" is shown inline and the submit button stays disabled until both match and meet the rules.
     - Submit **Update password**. On success the user is signed in, lands on `/dashboard`, and sees the toast "Password updated — other sessions were signed out".
- **States**: expired token goes back to step 1 with a message, plus network and rate-limit errors. Keyboard and screen-reader friendly, and works at 375px.

## Done when

- Both type checks and the build pass.
- **API tests** (scratch DB, SMTP off, dev code from the server log):
  - generic response for both known and unknown emails
  - cooldown and the hourly cap
  - wrong code 5 times locks the code
  - correct code returns a reset token
  - mismatched passwords → 400; weak password → 400; same as current → 400
  - success sets the cookie
  - reused token → 410
  - an old JWT is rejected after the reset (tokenVersion)
  - the imported-user case clears `passwordSetupRequired`
  - codes and tokens are absent from the logs
- **Browser**: the full flow from the login page, OTP paste, resend countdown, password mismatch message, success, and 375px.
