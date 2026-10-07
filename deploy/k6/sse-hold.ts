// Holds one SSE stream per load user for the duration of a k6 run (k6 itself
// can't keep long-lived streams open without blocking its VUs).
//
//   bun deploy/k6/sse-hold.ts --base http://127.0.0.1:8080 --users 150 --minutes 13
//
// Reports every 30 s and at the end: streams open, reconnects, events and
// heartbeats received. Exit code 1 if any stream was lost for good.
// Env: LOAD_PASSWORD (default "LoadTest-2026!"), SPOOF_IPS=true (one X-Forwarded-For per user).

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const BASE = (args.get("base") ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const USERS = Number(args.get("users") ?? 150);
const MINUTES = Number(args.get("minutes") ?? 13);
const PASSWORD = process.env.LOAD_PASSWORD ?? "LoadTest-2026!";
const SPOOF_IPS = (process.env.SPOOF_IPS ?? "true") === "true";

const stats = { open: 0, maxOpen: 0, connects: 0, drops: 0, events: 0, heartbeats: 0, loginErrors: 0 };
const deadline = Date.now() + MINUTES * 60_000;
const pad = (n: number) => String(n).padStart(3, "0");
const ipFor = (i: number) => `10.200.${Math.floor(i / 250)}.${(i % 250) + 1}`;

async function login(i: number): Promise<string | null> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(SPOOF_IPS ? { "X-Forwarded-For": ipFor(i) } : {}) },
    body: JSON.stringify({ email: `load-user-${pad(i)}@lps.test`, password: PASSWORD }),
  });
  if (!res.ok) return null;
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? null;
}

async function hold(i: number): Promise<void> {
  const cookie = await login(i);
  if (!cookie) {
    stats.loginErrors++;
    return;
  }
  while (Date.now() < deadline) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(0, deadline - Date.now()));
    let opened = false;
    try {
      const res = await fetch(`${BASE}/api/notifications/stream`, {
        headers: { Cookie: cookie, Accept: "text/event-stream", ...(SPOOF_IPS ? { "X-Forwarded-For": ipFor(i) } : {}) },
        signal: ctrl.signal,
      });
      if (res.status !== 200 || !res.body) throw new Error(`status ${res.status}`);
      opened = true;
      stats.connects++;
      stats.open++;
      stats.maxOpen = Math.max(stats.maxOpen, stats.open);
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        const text = decoder.decode(chunk as Uint8Array);
        stats.events += (text.match(/^data: /gm) ?? []).length;
        stats.heartbeats += (text.match(/^:heartbeat/gm) ?? []).length;
      }
    } catch {
      // aborted at the deadline, or a network error
    } finally {
      clearTimeout(timer);
      if (opened) stats.open--;
    }
    if (Date.now() < deadline) {
      stats.drops++;
      await Bun.sleep(2_000);
    }
  }
}

const report = (label: string) =>
  console.log(`[sse ${label}] ${new Date().toISOString()} ${JSON.stringify(stats)}`);
const ticker = setInterval(() => report("tick"), 30_000);

// Stagger the logins over ~20 s like real users arriving.
await Promise.all(
  Array.from({ length: USERS }, (_, k) => Bun.sleep(k * (20_000 / USERS)).then(() => hold(k + 1)))
);
clearInterval(ticker);
report("final");
process.exit(stats.loginErrors > 0 || stats.drops > 0 ? 1 : 0);
