import { randomBytes } from "node:crypto";
import { buildPatch } from "@gitmit/core";
import { applySplit } from "@gitmit/cli";
import * as vscode from "vscode";
import { messageFor, planCommits, providerLabel, type Plan, type Prepared } from "./engine";
import type { Repository } from "./git-api";

export interface SplitContext {
  repo: Repository;
  root: string;
  env: NodeJS.ProcessEnv;
  prepared: Prepared;
  diff: string;
  withSecretHandling: <T>(work: (redact: boolean) => PromiseLike<T>) => Promise<T | undefined>;
  report: (error: unknown) => Promise<void>;
}

type FromWebview =
  | { type: "move"; unit: number; to: number }
  | { type: "edit"; index: number; message: string }
  | { type: "apply" }
  | { type: "cancel" };

/** A panel to review, adjust and apply a proposed split, using the same safe applier as the CLI. */
export class SplitPanel {
  private static current: SplitPanel | undefined;
  private plan!: Plan;
  private redact = false;
  private busy = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly ctx: SplitContext,
  ) {
    panel.onDidDispose(() => {
      if (SplitPanel.current === this) SplitPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((message: FromWebview) => this.handle(message));
  }

  static async open(extension: vscode.ExtensionContext, ctx: SplitContext): Promise<void> {
    SplitPanel.current?.panel.dispose();

    let redact = false;
    const plan = await ctx.withSecretHandling((r) => {
      redact = r;
      return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `gitmit: planning commits with ${providerLabel(ctx.prepared)}` },
        () => planCommits(ctx.diff, ctx.prepared, r),
      );
    });
    if (!plan) return;

    if (plan.commits.length < 2) {
      const choice = await vscode.window.showInformationMessage(
        "gitmit: these changes already form one focused commit.",
        "Generate Message",
      );
      if (choice) await vscode.commands.executeCommand("gitmit.generate", { rootUri: ctx.repo.rootUri });
      return;
    }

    const panel = vscode.window.createWebviewPanel("gitmit.split", "gitmit: Split Commits", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extension.extensionUri, "media")],
    });
    panel.iconPath = vscode.Uri.joinPath(extension.extensionUri, "media", "icon.png");
    const instance = new SplitPanel(panel, ctx);
    instance.plan = plan;
    instance.redact = redact;
    SplitPanel.current = instance;
    instance.render();
  }

  private async handle(message: FromWebview): Promise<void> {
    if (this.busy) return;
    try {
      if (message.type === "cancel") {
        this.panel.dispose();
        return;
      }
      if (message.type === "edit") {
        const commit = this.plan.commits[message.index];
        if (commit && message.message.trim()) commit.message = message.message.trim();
        return;
      }
      if (message.type === "move") {
        await this.move(message.unit, message.to);
        return;
      }
      if (message.type === "apply") await this.apply();
    } catch (error) {
      this.setBusy(false);
      await this.ctx.report(error);
    }
  }

  /** Move one change to another commit (or a new one, `to === -1`) and rewrite the affected messages. */
  private async move(unit: number, to: number): Promise<void> {
    const commits = this.plan.commits;
    const source = commits.find((c) => c.units.includes(unit));
    if (!source) return;
    let destination = commits[to];
    if (!destination) {
      destination = { units: [], reason: "moved by you", message: "" };
      commits.push(destination);
    }
    if (destination === source) return;
    source.units = source.units.filter((u) => u !== unit);
    destination.units = [...destination.units, unit].sort((a, b) => a - b);
    this.plan.commits = commits.filter((c) => c.units.length > 0);

    this.setBusy(true, "Rewriting messages");
    for (const commit of [source, destination]) {
      if (this.plan.commits.includes(commit)) {
        commit.message = await messageFor(this.plan.diff, commit.units, this.ctx.prepared, this.redact);
      }
    }
    this.setBusy(false);
    this.render();
  }

  private async apply(): Promise<void> {
    const planned = this.plan.commits.map((c) => ({ patch: buildPatch(this.plan.diff, c.units), message: c.message }));
    this.setBusy(true, `Creating ${planned.length} commits`);
    const shas = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title: "gitmit: creating commits" },
      () => applySplit(this.ctx.root, planned, this.ctx.env),
    );
    await this.ctx.repo.status();
    this.panel.dispose();
    const first = planned[0]!.message.split("\n")[0];
    const choice = await vscode.window.showInformationMessage(
      `gitmit created ${shas.length} commits, starting with "${first}".`,
      "Push",
    );
    if (choice === "Push") await vscode.commands.executeCommand("git.push");
  }

  private setBusy(busy: boolean, label = "") {
    this.busy = busy;
    void this.panel.webview.postMessage({ type: "busy", busy, label });
  }

  private render(): void {
    const nonce = randomBytes(16).toString("base64");
    const csp = this.panel.webview.cspSource;
    const data = {
      commits: this.plan.commits,
      units: this.plan.diff.units.map((u) => ({ id: u.id, label: u.label, path: u.path, additions: u.additions, deletions: u.deletions })),
      source: this.plan.source,
      note: this.plan.note ?? null,
      provider: providerLabel(this.ctx.prepared),
    };
    this.panel.webview.html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style nonce="${nonce}">${STYLES}</style>
</head>
<body>
<header>
  <div>
    <h1>Split into focused commits</h1>
    <p class="muted" id="summary"></p>
  </div>
  <div class="actions">
    <button class="secondary" id="cancel">Cancel</button>
    <button id="apply"></button>
  </div>
</header>
<p class="note" id="note" hidden></p>
<div id="busy" class="busy" hidden><span class="spinner"></span><span id="busy-label"></span></div>
<main id="commits"></main>
<footer class="muted">Only the staging area changes; your files are never touched. The plan is rehearsed first, and if anything fails (for example a commit hook), your original commit and staged changes are restored.</footer>
<script nonce="${nonce}">const DATA = ${JSON.stringify(data).replace(/</g, "\\u003c")};
${SCRIPT}</script>
</body>
</html>`;
  }
}

const STYLES = `
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 20px 24px; max-width: 900px; }
  header { display: flex; align-items: flex-start; gap: 16px; }
  h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 4px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .actions { margin-left: auto; display: flex; gap: 8px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; border-radius: 2px; cursor: pointer; font: inherit; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  .note { padding: 8px 12px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-textBlockQuote-background); }
  .commit { border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); border-radius: 6px; padding: 12px 14px; margin: 14px 0; background: var(--vscode-editor-background); }
  .commit-head { display: flex; gap: 10px; align-items: flex-start; }
  .num { font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); padding-top: 6px; }
  textarea { flex: 1; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 6px 8px; resize: vertical; min-height: 2.4em; }
  textarea:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
  .reason { margin: 6px 0 0 26px; font-size: .9em; }
  ul { list-style: none; padding: 0; margin: 10px 0 0 26px; }
  li { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-family: var(--vscode-editor-font-family); font-size: .92em; }
  li .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .add { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .del { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  select { font: inherit; font-family: var(--vscode-font-family); color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border); border-radius: 2px; padding: 1px 4px; }
  .busy { display: flex; align-items: center; gap: 8px; margin: 12px 0; color: var(--vscode-descriptionForeground); }
  .spinner { width: 12px; height: 12px; border: 2px solid var(--vscode-progressBar-background); border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  footer { margin-top: 18px; font-size: .9em; }
`;

const SCRIPT = `
  const vscode = acquireVsCodeApi();
  const unitById = new Map(DATA.units.map((u) => [u.id, u]));
  const el = (tag, props = {}, children = []) => { const n = document.createElement(tag); Object.assign(n, props); for (const c of [].concat(children)) n.append(c); return n; };

  document.getElementById("summary").textContent =
    DATA.commits.length + " commits, grouped " + (DATA.source === "model" ? "by " + DATA.provider : "by area and kind of change") + ".";
  if (DATA.note) { const n = document.getElementById("note"); n.hidden = false; n.textContent = "Note: " + DATA.note; }
  const apply = document.getElementById("apply");
  apply.textContent = "Create " + DATA.commits.length + " commits";
  apply.onclick = () => vscode.postMessage({ type: "apply" });
  document.getElementById("cancel").onclick = () => vscode.postMessage({ type: "cancel" });

  const main = document.getElementById("commits");
  DATA.commits.forEach((commit, index) => {
    const message = el("textarea", { value: commit.message, rows: Math.min(8, commit.message.split("\\n").length + 1), ariaLabel: "Commit " + (index + 1) + " message" });
    message.addEventListener("change", () => vscode.postMessage({ type: "edit", index, message: message.value }));
    const rows = commit.units.map((id) => {
      const u = unitById.get(id);
      const select = el("select", { ariaLabel: "Move this change" });
      select.append(el("option", { value: "", textContent: "Move to…" }));
      DATA.commits.forEach((_, i) => { if (i !== index) select.append(el("option", { value: String(i), textContent: "Commit " + (i + 1) })); });
      select.append(el("option", { value: "-1", textContent: "A new commit" }));
      select.addEventListener("change", () => { if (select.value !== "") vscode.postMessage({ type: "move", unit: id, to: Number(select.value) }); });
      return el("li", {}, [
        el("span", { className: "label", textContent: u.label, title: u.label }),
        el("span", { className: "add", textContent: "+" + u.additions }),
        el("span", { className: "del", textContent: "-" + u.deletions }),
        select,
      ]);
    });
    main.append(el("section", { className: "commit" }, [
      el("div", { className: "commit-head" }, [el("span", { className: "num", textContent: String(index + 1) }), message]),
      el("p", { className: "reason muted", textContent: commit.reason }),
      el("ul", {}, rows),
    ]));
  });

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type !== "busy") return;
    document.getElementById("busy").hidden = !msg.busy;
    document.getElementById("busy-label").textContent = msg.label || "";
    document.querySelectorAll("button, select, textarea").forEach((n) => (n.disabled = msg.busy));
  });
`;
