import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { GITMIT_API_URL } from "@gitmit/core";
import { userConfigDir } from "./env.js";
import { UsageError } from "./provider.js";

/** A gitmit session saved by `gitmit login`. */
export interface Auth {
  token: string;
  login: string;
  apiUrl: string;
}

export interface Account {
  user: { login: string; name: string | null; avatarUrl: string | null };
  keys: { provider: string; last4: string; model: string | null; updatedAt: string }[];
  sessions: { id: string; client: string; label: string | null; createdAt: string; lastUsedAt: string | null; current: boolean }[];
}

export function apiUrl(env: NodeJS.ProcessEnv): string {
  return (env.GITMIT_API_URL || GITMIT_API_URL).replace(/\/+$/, "");
}

function githubUrl(env: NodeJS.ProcessEnv): string {
  return (env.GITMIT_GITHUB_URL || "https://github.com").replace(/\/+$/, "");
}

export function authFile(env: NodeJS.ProcessEnv): string {
  return join(userConfigDir(env), "auth.json");
}

export async function readAuth(env: NodeJS.ProcessEnv): Promise<Auth | undefined> {
  try {
    const data = JSON.parse(await readFile(authFile(env), "utf8")) as Partial<Auth>;
    if (typeof data.token === "string" && typeof data.login === "string") {
      return { token: data.token, login: data.login, apiUrl: data.apiUrl || apiUrl(env) };
    }
  } catch {
    // Not signed in.
  }
  return undefined;
}

async function writeAuth(env: NodeJS.ProcessEnv, auth: Auth): Promise<void> {
  const path = authFile(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
}

async function api<T>(env: NodeJS.ProcessEnv, path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(`${apiUrl(env)}${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    throw new UsageError(`Could not reach ${apiUrl(env)}. Check your connection.`);
  }
  const body = (await response.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!response.ok) {
    if (response.status === 401) throw new UsageError("Your gitmit sign-in has expired or was revoked. Run `gitmit login`.");
    throw new UsageError(body?.error?.message ?? `The gitmit API returned HTTP ${response.status}.`);
  }
  return body as T;
}

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

/**
 * Sign in with GitHub using the device flow: show a short code, the user
 * approves it on github.com, and the GitHub token is exchanged for a gitmit
 * session. The GitHub token is used once and never stored.
 */
export async function login(
  env: NodeJS.ProcessEnv,
  ui: { out: (line?: string) => void; openBrowser: boolean; sleep?: (ms: number) => Promise<void> },
): Promise<Auth> {
  const sleep = ui.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const { githubClientId } = await api<{ githubClientId: string }>(env, "/api/auth/config");
  const github = githubUrl(env);

  const codeResponse = await fetch(`${github}/login/device/code`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: githubClientId, scope: "read:user" }),
  });
  const code = (await codeResponse.json()) as DeviceCode;
  if (!code.device_code) throw new UsageError("GitHub did not start the sign-in. Try again in a moment.");

  ui.out(`First, copy your one-time code: ${code.user_code}`);
  ui.out(`Then open ${code.verification_uri} and paste it to sign in with GitHub.`);
  if (ui.openBrowser) openUrl(code.verification_uri);
  ui.out("Waiting for you to approve on GitHub...");

  let interval = Math.max(code.interval, 1) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;
  let githubToken: string | undefined;
  while (!githubToken) {
    if (Date.now() > deadline) throw new UsageError("The sign-in code expired. Run `gitmit login` again.");
    await sleep(interval);
    const response = await fetch(`${github}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: githubClientId,
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const result = (await response.json()) as { access_token?: string; error?: string };
    if (result.access_token) githubToken = result.access_token;
    else if (result.error === "slow_down") interval += 5000;
    else if (result.error === "access_denied") throw new UsageError("Sign-in was cancelled on GitHub.");
    else if (result.error === "expired_token") throw new UsageError("The sign-in code expired. Run `gitmit login` again.");
    else if (result.error && result.error !== "authorization_pending") throw new UsageError(`GitHub sign-in failed: ${result.error}`);
  }

  const session = await api<{ token: string; user: { login: string } }>(env, "/api/auth/github", {
    method: "POST",
    body: JSON.stringify({ accessToken: githubToken, client: "cli", label: `gitmit CLI on ${hostname()}` }),
  });
  const auth: Auth = { token: session.token, login: session.user.login, apiUrl: apiUrl(env) };
  await writeAuth(env, auth);
  return auth;
}

/** Revoke this device's session on the server and forget it locally. */
export async function logout(env: NodeJS.ProcessEnv): Promise<Auth | undefined> {
  const auth = await readAuth(env);
  if (!auth) return undefined;
  await api(env, "/api/auth/logout", { method: "POST", token: auth.token }).catch(() => {
    // Already revoked or unreachable; forgetting it locally is what matters here.
  });
  await rm(authFile(env), { force: true });
  return auth;
}

export async function account(env: NodeJS.ProcessEnv, auth: Auth): Promise<Account> {
  return api<Account>(env, "/api/me", { token: auth.token });
}

function openUrl(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // No browser available; the URL is printed above.
  }
}
