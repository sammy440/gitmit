import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestRepo } from "./harness.js";

let repo: TestRepo;
let server: Server;
let base: string;
let received: { path: string; auth?: string; body: string }[];
let revoked: string[];
let polls: number;

const SESSION = "gmt_" + "s".repeat(43);

/** A fake gitmit API and GitHub in one local server. */
function startServer(): Promise<void> {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      const send = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const authed = req.headers.authorization === `Bearer ${SESSION}` && !revoked.includes(SESSION);
      switch (req.url) {
        case "/api/auth/config":
          return send(200, { githubClientId: "client-123" });
        case "/login/device/code":
          return send(200, { device_code: "dev-1", user_code: "ABCD-1234", verification_uri: `${base}/login/device`, interval: 1, expires_in: 60 });
        case "/login/oauth/access_token":
          return send(200, ++polls < 2 ? { error: "authorization_pending" } : { access_token: "gh-token" });
        case "/api/auth/github":
          return JSON.parse(body).accessToken === "gh-token"
            ? send(200, { token: SESSION, user: { login: "alice" } })
            : send(401, { error: { message: "bad" } });
        case "/api/me":
          return authed
            ? send(200, {
                user: { login: "alice", name: "Alice", avatarUrl: null },
                keys: [{ provider: "openai", last4: "a1b2", model: null, updatedAt: "2026-01-01" }],
                sessions: [{ id: "s1", client: "cli", label: "x", createdAt: "", lastUsedAt: null, current: true }],
              })
            : send(401, { error: { message: "not signed in" } });
        case "/api/auth/logout":
          revoked.push(SESSION);
          return send(200, { ok: true });
        case "/api/complete":
          if (!authed) return send(401, { error: { message: "not signed in" } });
          return send(200, { result: { suggestions: [{ type: "feat", scope: null, description: "add login via account", body: null }] } });
        default:
          return send(404, {});
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      base = `http://127.0.0.1:${address.port}`;
      resolve();
    }),
  );
}

const env = () => ({ GITMIT_API_URL: base, GITMIT_GITHUB_URL: base });

beforeEach(async () => {
  received = [];
  revoked = [];
  polls = 0;
  repo = new TestRepo();
  await startServer();
});
afterEach(() => {
  repo.cleanup();
  server.close();
});

describe("gitmit login / account / logout", () => {
  it("signs in with the GitHub device flow and saves only the gitmit session, privately", async () => {
    const result = await repo.run(["login"], env());
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/one-time code: ABCD-1234/);
    expect(result.stdout).toMatch(/Signed in as alice/);
    expect(result.stdout).toMatch(/use the openai key saved in your account/);

    const file = join(repo.home, ".config", "gitmit", "auth.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toEqual({ token: SESSION, login: "alice", apiUrl: base });
    expect(readFileSync(file, "utf8")).not.toContain("gh-token");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(received.find((r) => r.path === "/api/auth/github")!.body).toMatch(/"client":"cli"/);
  });

  it("works outside a git repository", async () => {
    repo.dir = repo.home;
    expect((await repo.run(["account"], env())).stdout).toMatch(/Not signed in/);
  });

  it("shows the account, and logout revokes the session on the server", async () => {
    await repo.run(["login"], env());
    const shown = await repo.run(["account"], env());
    expect(shown.stdout).toMatch(/Signed in as alice \(Alice\)/);
    expect(shown.stdout).toMatch(/openai\s+a1b2/);

    const out = await repo.run(["logout"], env());
    expect(out.stdout).toMatch(/Signed out alice/);
    expect(revoked).toContain(SESSION);
    expect(existsSync(join(repo.home, ".config", "gitmit", "auth.json"))).toBe(false);
  });
});

describe("committing with the account", () => {
  it("uses the account automatically when signed in, sending only the scanned summary prompt", async () => {
    await repo.run(["login"], env());
    repo.write("src/auth/login.ts", "export function login() {}\n");
    repo.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nTOPSECRET_LOCK_CONTENT\n");
    repo.git("add", "-A");
    received = [];

    const result = await repo.run(["--dry-run"], env());
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^feat\(auth\): add login via account/m);

    const calls = received.filter((r) => r.path === "/api/complete");
    expect(calls.length).toBeGreaterThan(0);
    const sent = JSON.parse(calls[0]!.body);
    expect(calls[0]!.auth).toBe(`Bearer ${SESSION}`);
    expect(Object.keys(sent).sort()).toEqual(["output", "system", "user"]);
    expect(sent.output).toBe("commit_suggestions");
    expect(sent.user).toMatch(/<diff_summary>/);
    expect(calls[0]!.body).not.toContain("TOPSECRET_LOCK_CONTENT");
    expect(calls[0]!.body).not.toContain("diff --git");
  });

  it("stops before sending a secret to the account relay", async () => {
    await repo.run(["login"], env());
    repo.write("src/config.ts", `export const KEY = "ghp_${"q".repeat(36)}";\n`);
    repo.git("add", "-A");
    received = [];
    const result = await repo.run(["--dry-run", "--provider", "account"], env());
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Possible secrets/);
    expect(received.some((r) => r.path === "/api/complete")).toBe(false);
  });

  it("a local key still wins over the account", async () => {
    await repo.run(["login"], env());
    repo.write("docs/a.md", "a\n");
    repo.git("add", "-A");
    const shown = await repo.run(["config"], { ...env(), OPENAI_API_KEY: "sk-local" });
    expect(shown.stdout).toMatch(/^Provider: openai/m);
    const signedIn = await repo.run(["config"], env());
    expect(signedIn.stdout).toMatch(/^Provider: account/m);
  });

  it("explains how to sign in when the account provider is chosen without a session", async () => {
    repo.write("docs/a.md", "a\n");
    repo.git("add", "-A");
    const result = await repo.run(["--dry-run", "--provider", "account"], env());
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Not signed in to gitmit\. Run `gitmit login`/);
  });
});
