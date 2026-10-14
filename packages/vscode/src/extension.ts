import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { GITMIT_API_URL, SecretsDetectedError, type SecretFinding } from "@gitmit/core";
import { ConfigError, GitError, nothingStagedMessage, stagedDiff, UsageError } from "@gitmit/cli";
import * as vscode from "vscode";
import {
  generateMessages,
  MissingKeyError,
  prepare,
  providerLabel,
  type ExtensionSettings,
  type Prepared,
  type ProviderChoice,
  type StoredKeys,
} from "./engine";
import type { API, GitExtension, Repository } from "./git-api";
import { SplitPanel } from "./split-panel";

const KEY_SECRETS = { openai: "gitmit.openaiApiKey", anthropic: "gitmit.anthropicApiKey" } as const;
const SESSION_SECRET = "gitmit.session";
const ACCOUNT_PAGE = "https://gitmit-frontend.vercel.app/account";

function apiUrl(): string {
  return (process.env.GITMIT_API_URL || GITMIT_API_URL).replace(/\/+$/, "");
}

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("gitmit", { log: true });
  const gitmit = new Gitmit(context, log);
  context.subscriptions.push(log);
  context.subscriptions.push(
    vscode.commands.registerCommand("gitmit.generate", (arg?: unknown) => gitmit.run(() => gitmit.generate(arg))),
    vscode.commands.registerCommand("gitmit.split", (arg?: unknown) => gitmit.run(() => gitmit.split(arg))),
    vscode.commands.registerCommand("gitmit.setApiKey", () => gitmit.run(() => gitmit.setApiKey())),
    vscode.commands.registerCommand("gitmit.clearApiKey", () => gitmit.run(() => gitmit.clearApiKey())),
    vscode.commands.registerCommand("gitmit.signIn", () => gitmit.run(() => gitmit.signIn())),
    vscode.commands.registerCommand("gitmit.signOut", () => gitmit.run(() => gitmit.signOut())),
    vscode.commands.registerCommand("gitmit.manageAccount", () => vscode.env.openExternal(vscode.Uri.parse(ACCOUNT_PAGE))),
    vscode.commands.registerCommand("gitmit.openSettings", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "@ext:gitmit.gitmit"),
    ),
  );
}

export function deactivate() {}

class Gitmit {
  private running = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** Runs a command, one at a time, turning known errors into helpful messages. */
  async run(task: () => Promise<void>): Promise<void> {
    if (this.running) {
      vscode.window.showInformationMessage("gitmit is already working on it.");
      return;
    }
    this.running = true;
    try {
      await task();
    } catch (error) {
      await this.report(error);
    } finally {
      this.running = false;
    }
  }

  async generate(arg?: unknown): Promise<void> {
    const repo = await this.pickRepository(arg);
    if (!repo) return;
    const root = repo.rootUri.fsPath;
    const env = this.gitEnv();

    const diff = await this.ensureStaged(repo, env);
    if (!diff) return;

    const prepared = await prepare(root, await this.keys(), this.settings(), env);
    if (prepared.note) vscode.window.showInformationMessage(prepared.note);

    const result = await this.withSecretHandling(prepared, (redact) =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title: `gitmit: writing with ${providerLabel(prepared)}` },
        () => generateMessages(diff, prepared, redact),
      ),
    );
    if (!result) return;

    const suggestions = result.suggestions;
    let message = suggestions[0]!.message;
    if (suggestions.length > 1 && vscode.workspace.getConfiguration("gitmit").get<boolean>("showSuggestions", true)) {
      const picked = await vscode.window.showQuickPick(
        suggestions.map((s, i) => {
          const [header, ...rest] = s.message.split("\n");
          return { label: header!, detail: rest.join(" ").replace(/\s+/g, " ").trim() || undefined, description: i === 0 ? "top suggestion" : undefined, message: s.message };
        }),
        { title: "gitmit: pick a commit message", placeHolder: "It goes into the commit message box, where you can still edit it", matchOnDetail: true },
      );
      if (!picked) return;
      message = picked.message;
    }

    repo.inputBox.value = message;
    if (result.redacted) vscode.window.showInformationMessage(`gitmit redacted ${result.secrets.length} possible secret(s) before sending.`);
    await vscode.commands.executeCommand("workbench.view.scm");
  }

  async split(arg?: unknown): Promise<void> {
    const repo = await this.pickRepository(arg);
    if (!repo) return;
    const root = repo.rootUri.fsPath;
    const env = this.gitEnv();

    const diff = await this.ensureStaged(repo, env, true);
    if (!diff) return;

    const prepared = await prepare(root, await this.keys(), this.settings(), env);
    await SplitPanel.open(this.context, {
      repo,
      root,
      env,
      prepared,
      diff,
      withSecretHandling: (work) => this.withSecretHandling(prepared, work),
      report: (error) => this.report(error),
    });
  }

  async setApiKey(): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: "OpenAI", provider: "openai" as const, detail: "Keys start with sk-" },
        { label: "Anthropic", provider: "anthropic" as const, detail: "Keys start with sk-ant-" },
      ],
      { title: "gitmit: which provider?" },
    );
    if (!choice) return;
    const key = await vscode.window.showInputBox({
      title: `gitmit: ${choice.label} API key`,
      prompt: "Stored in VS Code's encrypted secret storage, never in settings files.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) =>
        !value.trim()
          ? "Paste your key"
          : choice.provider === "anthropic" && !value.trim().startsWith("sk-ant-")
            ? "Anthropic keys start with sk-ant-"
            : choice.provider === "openai" && !value.trim().startsWith("sk-")
              ? "OpenAI keys start with sk-"
              : undefined,
    });
    if (!key) return;
    await this.context.secrets.store(KEY_SECRETS[choice.provider], key.trim());
    vscode.window.showInformationMessage(`gitmit: ${choice.label} key saved.`);
  }

  /**
   * Sign in with the GitHub account VS Code already knows, and exchange it for
   * a gitmit session. The GitHub token is used once and not kept by gitmit.
   */
  async signIn(): Promise<void> {
    const github = await vscode.authentication.getSession("github", ["read:user"], { createIfNone: true });
    const response = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "gitmit: signing in" },
      () =>
        fetch(`${apiUrl()}/api/auth/github`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accessToken: github.accessToken, client: "vscode", label: `VS Code on ${hostname()}` }),
        }).catch(() => undefined),
    );
    if (!response) throw new UsageError(`Could not reach ${apiUrl()}. Check your connection.`);
    const body = (await response.json().catch(() => null)) as { token?: string; user?: { login: string }; error?: { message?: string } } | null;
    if (!response.ok || !body?.token) throw new UsageError(body?.error?.message ?? `Sign-in failed (HTTP ${response.status}).`);

    await this.context.secrets.store(SESSION_SECRET, JSON.stringify({ token: body.token, apiUrl: apiUrl(), login: body.user?.login }));
    const me = await fetch(`${apiUrl()}/api/me`, { headers: { authorization: `Bearer ${body.token}` } })
      .then((r) => (r.ok ? (r.json() as Promise<{ keys: { provider: string }[] }>) : undefined))
      .catch(() => undefined);
    if (me && me.keys.length === 0) {
      const choice = await vscode.window.showInformationMessage(
        `gitmit: signed in as ${body.user?.login}. Your account has no API key saved yet.`,
        "Add a Key",
      );
      if (choice) await vscode.env.openExternal(vscode.Uri.parse(ACCOUNT_PAGE));
    } else {
      vscode.window.showInformationMessage(
        `gitmit: signed in as ${body.user?.login}. gitmit will use the ${me?.keys.map((k) => k.provider).join(" and ") ?? "API"} key saved in your account.`,
      );
    }
  }

  async signOut(): Promise<void> {
    const session = await this.session();
    if (!session) {
      vscode.window.showInformationMessage("gitmit: not signed in.");
      return;
    }
    // Revoke on the server too, so the session can't be used again.
    await fetch(`${session.apiUrl}/api/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${session.token}` } }).catch(() => {});
    await this.context.secrets.delete(SESSION_SECRET);
    vscode.window.showInformationMessage(`gitmit: signed out${session.login ? ` ${session.login}` : ""}.`);
  }

  private async session(): Promise<{ token: string; apiUrl: string; login?: string } | undefined> {
    const raw = await this.context.secrets.get(SESSION_SECRET);
    if (!raw) return undefined;
    try {
      const data = JSON.parse(raw) as { token?: string; apiUrl?: string; login?: string };
      return data.token ? { token: data.token, apiUrl: data.apiUrl || apiUrl(), login: data.login } : undefined;
    } catch {
      return undefined;
    }
  }

  async clearApiKey(): Promise<void> {
    const keys = await this.keys();
    const items = [
      ...(keys.openai ? [{ label: "OpenAI", provider: "openai" as const }] : []),
      ...(keys.anthropic ? [{ label: "Anthropic", provider: "anthropic" as const }] : []),
    ];
    if (items.length === 0) {
      vscode.window.showInformationMessage("gitmit has no saved API keys.");
      return;
    }
    const choice = await vscode.window.showQuickPick(items, { title: "gitmit: remove which key?" });
    if (!choice) return;
    await this.context.secrets.delete(KEY_SECRETS[choice.provider]);
    vscode.window.showInformationMessage(`gitmit: ${choice.label} key removed.`);
  }

  /**
   * Run work that sends the diff to a provider. If the secret scan stops it,
   * show what was found and, depending on the setting, offer a redacted retry.
   */
  async withSecretHandling<T>(prepared: Prepared, work: (redact: boolean) => PromiseLike<T>): Promise<T | undefined> {
    const policy = vscode.workspace.getConfiguration("gitmit").get<string>("onSecretFound", "ask");
    try {
      return await work(policy === "redact");
    } catch (error) {
      if (!(error instanceof SecretsDetectedError)) throw error;
      const list = describeFindings(error.findings);
      if (policy === "abort") {
        vscode.window.showWarningMessage(`gitmit: possible secrets in the staged changes. Nothing was sent.\n${list}`, { modal: true });
        return undefined;
      }
      const choice = await vscode.window.showWarningMessage(
        "gitmit found possible secrets in the staged changes. Nothing was sent.",
        { modal: true, detail: `${list}\n\nUnstage them, or send a version with the secrets replaced by markers to ${providerLabel(prepared)}.` },
        "Send Redacted",
      );
      return choice === "Send Redacted" ? work(true) : undefined;
    }
  }

  /** The staged diff. When nothing is staged, offer to stage everything first. */
  private async ensureStaged(repo: Repository, env: NodeJS.ProcessEnv, forSplit = false): Promise<string | undefined> {
    const root = repo.rootUri.fsPath;
    const diff = forSplit ? await stagedDiff(root, env, { binary: true }) : await stagedDiff(root, env);
    if (diff.trim()) return diff;

    const pending = repo.state.workingTreeChanges.length + (repo.state.untrackedChanges?.length ?? 0);
    if (pending === 0) {
      vscode.window.showInformationMessage("gitmit: there are no changes to commit.");
      return undefined;
    }
    const choice = await vscode.window.showInformationMessage(
      `gitmit works on staged changes, and nothing is staged. Stage all ${pending} changed file${pending === 1 ? "" : "s"}?`,
      "Stage All",
    );
    if (choice !== "Stage All") return undefined;
    await stageAll(root, env);
    await repo.status();
    const staged = forSplit ? await stagedDiff(root, env, { binary: true }) : await stagedDiff(root, env);
    if (!staged.trim()) {
      vscode.window.showInformationMessage(`gitmit: ${await nothingStagedMessage(root, env)}`);
      return undefined;
    }
    return staged;
  }

  /** The repository the command applies to: from the Source Control title button, the only one, or the user's pick. */
  private async pickRepository(arg?: unknown): Promise<Repository | undefined> {
    const git = this.gitApi();
    const repos = git.repositories;
    if (repos.length === 0) {
      vscode.window.showInformationMessage("gitmit: open a folder that is a git repository first.");
      return undefined;
    }
    const rootUri = (arg as { rootUri?: vscode.Uri } | undefined)?.rootUri;
    if (rootUri) {
      const match = repos.find((r) => r.rootUri.toString() === rootUri.toString());
      if (match) return match;
    }
    if (repos.length === 1) return repos[0];
    const active = vscode.window.activeTextEditor?.document.uri;
    const containing = active && repos.find((r) => active.fsPath.startsWith(r.rootUri.fsPath));
    const picked = await vscode.window.showQuickPick(
      repos.map((r) => ({ label: vscode.workspace.asRelativePath(r.rootUri, false) || r.rootUri.fsPath, repo: r, picked: r === containing })),
      { title: "gitmit: which repository?" },
    );
    return picked?.repo;
  }

  private gitApi(): API {
    const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!extension?.isActive || !extension.exports.enabled) throw new UsageError("VS Code's Git support is disabled. Enable the built-in Git extension to use gitmit.");
    return extension.exports.getAPI(1);
  }

  /** The environment for git commands, with VS Code's git on the PATH. */
  private gitEnv(): NodeJS.ProcessEnv {
    const gitPath = this.gitApi().git.path;
    const env = { ...process.env };
    if (gitPath && gitPath.includes("/")) env.PATH = `${dirname(gitPath)}${process.platform === "win32" ? ";" : ":"}${env.PATH ?? ""}`;
    return env;
  }

  private async keys(): Promise<StoredKeys> {
    const [openai, anthropic, session] = await Promise.all([
      this.context.secrets.get(KEY_SECRETS.openai),
      this.context.secrets.get(KEY_SECRETS.anthropic),
      this.session(),
    ]);
    return { openai, anthropic, ...(session ? { session: { token: session.token, apiUrl: session.apiUrl } } : {}) };
  }

  private settings(): ExtensionSettings {
    const config = vscode.workspace.getConfiguration("gitmit");
    return {
      provider: config.get<ProviderChoice>("provider", "auto"),
      model: config.get<string>("model", ""),
      ollamaHost: config.get<string>("ollamaHost", ""),
      configPath: config.get<string>("configPath", ""),
    };
  }

  async report(error: unknown): Promise<void> {
    // Full details go to View → Output → gitmit, for troubleshooting.
    this.log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    if (process.env.GITMIT_E2E_REPO) console.error("[gitmit]", error);
    if (error instanceof MissingKeyError) {
      const choice = await vscode.window.showErrorMessage(
        error.provider === "account"
          ? `gitmit: ${error.message} Sign in to use the key saved in your account, or switch to offline rules.`
          : `gitmit: ${error.message} Add one, sign in to use your gitmit account, or switch to offline rules.`,
        "Sign In with GitHub",
        ...(error.provider === "account" ? [] : ["Set API Key"]),
        "Use Offline Rules",
      );
      if (choice === "Sign In with GitHub") await this.signIn();
      if (choice === "Set API Key") await this.setApiKey();
      if (choice === "Use Offline Rules") {
        await vscode.workspace.getConfiguration("gitmit").update("provider", "rules", vscode.ConfigurationTarget.Global);
      }
      return;
    }
    if (error instanceof UsageError || error instanceof ConfigError || error instanceof GitError) {
      vscode.window.showErrorMessage(`gitmit: ${error.message}`);
      return;
    }
    if (error instanceof Error && error.name === "ProviderError" && (error as { status?: number }).status === 401 && /^account:/.test(error.message)) {
      const choice = await vscode.window.showErrorMessage("gitmit: your sign-in has expired or was revoked.", "Sign In Again");
      if (choice) await this.signIn();
      return;
    }
    if (error instanceof Error && error.name === "ProviderError" && /^account: No .*key is saved/.test(error.message)) {
      const choice = await vscode.window.showErrorMessage(`gitmit: ${error.message.replace(/^account: /, "")}`, "Add a Key");
      if (choice) await vscode.env.openExternal(vscode.Uri.parse(ACCOUNT_PAGE));
      return;
    }
    if (error instanceof Error && error.name === "ProviderError") {
      const choice = await vscode.window.showErrorMessage(`gitmit: ${error.message}`, "Open Settings");
      if (choice) await vscode.commands.executeCommand("gitmit.openSettings");
      return;
    }
    if (error instanceof Error && error.name === "SplitError") {
      vscode.window.showErrorMessage(`gitmit: ${error.message}`, { modal: true });
      return;
    }
    vscode.window.showErrorMessage(`gitmit: unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function describeFindings(findings: SecretFinding[]): string {
  return findings.map((f) => `• ${f.rule}${f.path ? ` in ${f.path}` : ""} (${f.preview})`).join("\n");
}

/** Stage every change in the repository, like `git add -A`. */
function stageAll(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("git", ["add", "-A"], { cwd: root, env }, (error, _stdout, stderr) =>
      error ? reject(new GitError(stderr.trim() || error.message)) : resolve(),
    );
  });
}
