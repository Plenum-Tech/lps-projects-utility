# LPS – Projects Utility

By **Plenum Tech**. A full-stack projects, people and time platform built with the MERN stack and React Router framework mode. Features role-based access control, AI-powered insights, and real-time notifications.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19, React Router 8 (framework mode), TanStack Query, Tailwind CSS 4, Shadcn UI |
| **Backend** | Express 5, MongoDB (Mongoose 9), JWT auth, Inngest (background jobs) |
| **Email** | Resend |
| **Runtime** | Bun |
| **Deploy** | Vercel |

## Quickstart

### Prerequisites

- [Bun](https://bun.sh) v1.x
- MongoDB instance (local or Atlas)
- Vercel account (for deployment)

### Setup

```bash
# Clone and install
git clone <repo-url>
cd ems
bun install

# Backend setup
cd backend
cp .env.example .env   # fill in your values (see Environment Variables)
bun run seed            # optional: populate demo data
cd ..

# Frontend setup
cd frontend
cp .env.example .env   # fill in your values
cd ..
```

### Development

```bash
# Backend (port 5000)
cd backend && bun run dev

# Frontend (port 5173)
cd frontend && bun run dev
```

### Production Build

```bash
cd backend && bun run build   # TypeScript compile
cd frontend && bun run build  # React Router build
```

### Typecheck

```bash
cd backend && bun run typecheck
cd frontend && bun run typecheck
```

## Environment Variables

### Backend

| Variable | Description | Example |
|----------|-------------|---------|
| `PORT` | Server port | `5000` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017/ems` |
| `JWT_SECRET` | Secret for signing JWT tokens | `your-super-secret-key` |
| `JWT_EXPIRES_IN` | Token expiry | `7d` |
| `CORS_ORIGIN` | Allowed frontend origin | `http://localhost:5173` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | SMTP server (Microsoft 365: STARTTLS on 587) | `smtp.office365.com` / `587` / `false` |
| `SMTP_USER` / `SMTP_PASS` | Mailbox login (app password if MFA is on) | `you@yourdomain.com` |
| `FROM_NAME` / `FROM_EMAIL` | Sender (FROM_EMAIL must equal SMTP_USER unless Send As is granted) | empty (= company name, else `LPS – Projects Utility`) / `you@yourdomain.com` |
| `EMAIL_REDIRECT_TO` | Dev only: deliver all mail to this address | `dev@yourdomain.com` |
| `APP_URL` | Frontend URL used in email links | `http://localhost:5173` |
| `NODE_ENV` | `development` or `production` | `production` |

### Frontend

| Variable | Description | Example |
|----------|-------------|---------|
| `VITE_API_BASE_URL` | Backend API URL | `http://localhost:5000` |

## Project Structure

```
ems/
├── backend/                        # Express REST API
│   ├── src/
│   │   ├── server.ts               # Express app entry + route mounting
│   │   ├── db/                     # Mongoose connection
│   │   ├── models/                 # Mongoose schemas
│   │   │   ├── User.ts
│   │   │   ├── Department.ts
│   │   │   ├── Leave.ts
│   │   │   ├── Attendance.ts
│   │   │   ├── Task.ts
│   │   │   ├── Announcement.ts
│   │   │   ├── PerformanceReview.ts
│   │   │   ├── Feedback.ts
│   │   │   ├── AiInsight.ts
│   │   │   └── ActivityLog.ts
│   │   ├── controllers/            # Business logic per resource
│   │   ├── routes/                 # Express routers (auth + role gated)
│   │   ├── middlewares/            # requireAuth, requireRole, rateLimit
│   │   ├── lib/                    # Utilities (jwt, permissions, leavePolicies, activityLog)
│   │   └── inngest/                # Background AI functions
│   └── api/
│       └── index.ts                # Vercel serverless entry point
│
└── frontend/                       # React Router 8 app
    └── app/
        ├── routes/                 # Page components (framework-mode loaders)
        │   ├── dashboard.tsx
        │   ├── attendance.tsx
        │   ├── leaves.tsx
        │   ├── tasks.tsx
        │   ├── announcements.tsx
        │   ├── performance-reviews.tsx
        │   ├── feedback.tsx
        │   ├── ai-insights.tsx
        │   ├── profile.tsx
        │   └── admin/             # Admin-only pages
        ├── components/
        │   ├── ui/                 # Shadcn components
        │   ├── globals/            # Reusable layout components
        │   └── auth/               # Login, RequireAuth
        ├── hooks/                  # TanStack Query hooks
        ├── lib/
        │   └── api.ts              # Axios client (withCredentials)
        └── types.ts                # Shared TypeScript interfaces
```

## Features

### Authentication & Authorization

- JWT-based authentication with httpOnly cookies
- Role-based access control: **admin**, **head**, **employee**
- Permission-gated routes via middleware (`requireAuth`, `requireRole`)

### Employee Management

- Full employee profiles (personal info, contact, employment details)
- Department assignment and management
- User CRUD with role-based permissions

### Attendance

- Clock in / clock out tracking
- Daily attendance records with status (present, late, absent, half-day, on leave)
- Attendance overview per month

### Leave Management

- Apply for leave with type, date range, and reason
- Leave balance tracking per type (sick, vacation, personal, etc.)
- Admin/head approval workflow
- Configurable leave policies per department

### Tasks

- Create, assign, and track tasks
- Status updates (todo, in-progress, review, done)
- Priority levels (low, medium, high, urgent)

### Performance Reviews

- Admin/head-written performance reviews for employees (manual by default)
- 1–5 category ratings, written feedback and goals; drafts stay private until sent, then lock
- Optional AI drafting via Gemini when the backend sets `AI_REVIEW_DRAFTS=true` (needs `GEMINI_API_KEY` + Inngest)

### Feedback

- Employee feedback submission

### Announcements

- Admin-created announcements visible to all employees

### AI Insights

- AI-powered analytics for workforce management
- Admin dashboard with generated insights

### Activity Logging

- Full audit trail of user actions across the system

### Dashboard

- **Admin/Head**: department stats, leave overview, task metrics, attendance overview
- **Employee**: personal attendance rate, leave balance, active tasks, completed tasks

### Notifications

- Real-time notification system for users

## API Routes

| Method | Endpoint | Description | Auth |
|--------|----------|-------------|------|
| `POST` | `/api/auth/login` | Login | Public |
| `POST` | `/api/auth/logout` | Logout | Public |
| `GET` | `/api/auth/me` | Current user | Auth |
| CRUD | `/api/users` | User management | Admin |
| CRUD | `/api/departments` | Department management | Admin |
| CRUD | `/api/leaves` | Leave applications | Auth |
| CRUD | `/api/attendance` | Attendance records | Auth |
| CRUD | `/api/tasks` | Task management | Auth |
| CRUD | `/api/announcements` | Announcements | Admin |
| CRUD | `/api/performance-reviews` | Performance reviews | Admin/Head |
| CRUD | `/api/feedback` | Feedback | Auth |
| CRUD | `/api/ai-insights` | AI insights | Admin |
| `GET` | `/api/dashboard/analytics` | Admin/head dashboard | Admin/Head |
| `GET` | `/api/dashboard/my` | Employee dashboard | Auth |
| CRUD | `/api/notifications` | Notifications | Auth |
| `GET` | `/api/reports` | Reports | Admin/Head |
| `GET` | `/api/activity-logs` | Activity log | Admin |

## Roles & Permissions

| Feature | Employee | Head | Admin |
|---------|----------|------|-------|
| View own profile | ✅ | ✅ | ✅ |
| View all profiles | ❌ | ❌ | ✅ |
| Clock in/out | ✅ | ✅ | ✅ |
| View own attendance | ✅ | ✅ | ✅ |
| View all attendance | ❌ | ✅ | ✅ |
| Apply for leave | ✅ | ✅ | ✅ |
| Approve leaves | ❌ | ✅ | ✅ |
| Manage leave policies | ❌ | ❌ | ✅ |
| Create/update tasks | ✅ | ✅ | ✅ |
| View department dashboard | ❌ | ✅ | ✅ |
| Manage departments | ❌ | ❌ | ✅ |
| Manage users | ❌ | ❌ | ✅ |
| Create announcements | ❌ | ❌ | ✅ |
| AI insights | ❌ | ❌ | ✅ |
| Activity log | ❌ | ❌ | ✅ |

## Deployment

**Production: one container on Azure Container Apps.** The root `Dockerfile`
builds a single image (`lps-projects-utility`) that serves the API and the
SPA frontend from one Bun process on port 8080; MongoDB is external
(`MONGO_URI`). See **[DEPLOY-AZURE.md](DEPLOY-AZURE.md)** for the ACR push,
Container App setup, secrets, migrations, load-test results and runbook.
`docker compose up -d --build` runs the image locally with a throwaway MongoDB.

### Vercel (legacy split deployment)

The project can still be deployed to Vercel (UI and API on different sites —
set `CROSS_SITE_COOKIES=true` on the API so the session cookie is `SameSite=None`):

- **Backend**: `backend/api/index.ts` serves as the serverless function entry point
- **Frontend**: Standard React Router Vercel build

Ensure the following Vercel environment variables are set for production:

- `MONGODB_URI`
- `JWT_SECRET`
- `CORS_ORIGIN` (your frontend domain)
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `FROM_NAME`, `FROM_EMAIL`, `APP_URL`
- `NODE_ENV=production`

## License

Private — All rights reserved.
