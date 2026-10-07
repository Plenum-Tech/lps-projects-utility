// k6 load test for LPS – Projects Utility (see DEPLOY-AZURE.md → "Load test").
//
// 150 virtual users, each signed in as its own seeded user (load-user-001…150,
// `bun run seed:load`), browsing like a person: dashboard, task table and board,
// a task detail, a comment, a status change, projects, a time entry and the
// notification poll, with think time between steps. The SSE streams (one per
// user) are held by deploy/k6/sse-hold.ts running alongside this script.
//
//   docker run --rm -i --network <compose-network> -v "$PWD/deploy/k6:/k6" grafana/k6 \
//     run -e BASE_URL=http://app:8080 -e RUN_ID=1 /k6/load-test.js
//
// Env: BASE_URL, VUS (150), HOLD (10m), RAMP (2m), THINK_SCALE (1), LOAD_PASSWORD, RUN_ID (1–20, keeps
// time entries of repeated runs from overlapping), SPOOF_IPS (true: one X-Forwarded-For per
// VU, as the ACA ingress would send — needs TRUST_PROXY=1, otherwise every VU shares the
// k6 machine's per-IP rate-limit bucket).

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Counter } from "k6/metrics";

const BASE = (__ENV.BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const VUS = Number(__ENV.VUS || 150);
const PASSWORD = __ENV.LOAD_PASSWORD || "LoadTest-2026!";
const RUN_ID = Number(__ENV.RUN_ID || 1);
const SPOOF_IPS = (__ENV.SPOOF_IPS || "true") === "true";

const unexpected = new Counter("unexpected_responses");

export const options = {
  scenarios: {
    users: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP || "2m", target: VUS },
        { duration: __ENV.HOLD || "10m", target: VUS },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    "http_req_duration{kind:read}": ["p(95)<500", "p(99)<1500"],
    "http_req_duration{kind:write}": ["p(95)<800"],
    http_req_failed: ["rate<0.005"],
    checks: ["rate>0.995"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

const pad = (n) => String(n).padStart(3, "0");
// THINK_SCALE stretches every pause (1 = 2–5 s between steps, an aggressive pace;
// 2.5 ≈ 5–12 s, closer to people actually reading a page).
const THINK_SCALE = Number(__ENV.THINK_SCALE || 1);
const think = (min = 2, max = 5) => sleep(THINK_SCALE * (min + Math.random() * (max - min)));
const pick = (items) => items[Math.floor(Math.random() * items.length)];
const ymd = (d) => d.toISOString().slice(0, 10);

// Per-VU state (each VU is one signed-in user for the whole run).
let session = null;

function headers(extra = {}) {
  const h = { Cookie: session.cookie, Accept: "application/json", "Accept-Encoding": "gzip, br", ...extra };
  if (SPOOF_IPS) h["X-Forwarded-For"] = session.ip;
  return h;
}

function get(path, name) {
  const res = http.get(`${BASE}/api${path}`, { headers: headers(), tags: { kind: "read", name } });
  if (!check(res, { [`${name} 200`]: (r) => r.status === 200 })) unexpected.add(1, { name, status: String(res.status) });
  return res;
}

function send(method, path, body, name, okStatuses = [200, 201]) {
  const res = http.request(method, `${BASE}/api${path}`, JSON.stringify(body), {
    headers: headers({ "Content-Type": "application/json" }),
    tags: { kind: "write", name },
  });
  if (!check(res, { [`${name} ok`]: (r) => okStatuses.includes(r.status) })) unexpected.add(1, { name, status: String(res.status) });
  return res;
}

function login() {
  const email = `load-user-${pad(((__VU - 1) % 150) + 1)}@lps.test`;
  const ip = `10.${Math.floor(__VU / 250) + 1}.${__VU % 250}.${(__VU % 200) + 1}`;
  const res = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
    headers: { "Content-Type": "application/json", ...(SPOOF_IPS ? { "X-Forwarded-For": ip } : {}) },
    tags: { kind: "write", name: "login" },
  });
  const ok = check(res, { "login 200": (r) => r.status === 200 });
  if (!ok) {
    unexpected.add(1, { name: "login", status: String(res.status) });
    return null;
  }
  // The production cookie is Secure; over plain http (local test) k6's jar won't
  // replay it, so the Cookie header is set explicitly.
  const token = res.cookies.token && res.cookies.token[0] ? res.cookies.token[0].value : null;
  return { cookie: `token=${token}`, ip, user: res.json("user"), logNo: 0 };
}

export default function () {
  if (!session) {
    session = login();
    if (!session) {
      sleep(5);
      return;
    }
  }

  group("app shell", () => {
    get("/auth/me", "auth_me");
    get("/settings/public", "settings_public");
    get("/notifications/unread-count", "unread_count");
    get("/timelogs/active", "timer_active");
  });
  think(1, 2);

  group("dashboard", () => {
    const today = new Date();
    const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * 86400000);
    get("/dashboard/me", "dashboard_me");
    get(`/dashboard/me/calendar?from=${ymd(new Date(today.getTime() - 14 * 86400000))}&to=${ymd(new Date(today.getTime() + 21 * 86400000))}`, "dashboard_calendar");
    get(`/dashboard/me/timelogs?weekStart=${ymd(monday)}`, "dashboard_timelogs");
  });
  think();

  let tasks = [];
  group("tasks table", () => {
    const res = get("/tasks?scope=assigned&limit=20&offset=0", "tasks_list");
    if (res.status === 200) tasks = res.json("tasks") || [];
    get("/tasks/approvals/count", "approvals_count");
  });
  think();

  group("tasks board", () => {
    get("/tasks?scope=assigned&view=board", "tasks_board");
  });
  think();

  if (tasks.length > 0) {
    const task = pick(tasks);
    group("task detail", () => {
      get(`/tasks/${task._id}`, "task_detail");
      get(`/tasks/${task._id}/comments`, "task_comments");
      get(`/tasks/${task._id}/history`, "task_history");
      get(`/tasks/${task._id}/files`, "task_files");
      get(`/tasks/${task._id}/notes`, "task_notes");
    });
    think(3, 6);

    group("comment", () => {
      send("POST", `/tasks/${task._id}/comments`, { body: `Load test comment from VU ${__VU} at ${new Date().toISOString()}` }, "comment_add");
    });
    think();

    const movable = tasks.filter((t) => t.status === "todo" || t.status === "in_progress");
    if (movable.length > 0) {
      const t = pick(movable);
      const next = t.status === "todo" ? "in_progress" : "todo";
      group("status", () => {
        const res = send("PATCH", `/tasks/${t._id}/status`, { status: next }, "status_update");
        if (res.status === 200) t.status = next;
      });
      think();
    }
  }

  let project = null;
  group("projects", () => {
    const res = get("/projects?limit=20&offset=0", "projects_list");
    const projects = res.status === 200 ? res.json("projects") || [] : [];
    if (projects.length > 0) {
      project = pick(projects);
      get(`/projects/${project._id}`, "project_detail");
    }
  });
  think();

  // A manual time entry on one of my tasks: 30 min on a past day nobody else
  // writes to (seed data uses 04:00–06:00 UTC; this uses 07:00+RUN_ID).
  const loggable = tasks.filter((t) => t.project && t.status !== "completed");
  if (loggable.length > 0) {
    const t = pick(loggable);
    const projectId = typeof t.project === "object" ? t.project._id : t.project;
    session.logNo += 1;
    const day = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - (200 + session.logNo) * 86400000);
    const start = new Date(day.getTime() + (6 + RUN_ID) * 3600000);
    const end = new Date(start.getTime() + 30 * 60000);
    group("log time", () => {
      send("POST", "/timelogs", { project: projectId, task: t._id, startTime: start.toISOString(), endTime: end.toISOString(), memo: "load test" }, "timelog_add");
    });
    think();
  }

  group("notifications", () => {
    get("/notifications?limit=10&offset=0", "notifications_list");
    get("/notifications/unread-count", "unread_count");
  });
  think(3, 8);
}
