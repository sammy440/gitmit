// Runs inside VS Code. Exercises the bundled extension through its real commands.
const vscode = require("vscode");
const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gitRepository(root) {
  const git = vscode.extensions.getExtension("vscode.git");
  await git.activate();
  const api = git.exports.getAPI(1);
  for (let i = 0; i < 100; i++) {
    const repo = api.repositories.find((r) => r.rootUri.fsPath.replace(/^\/private/, "") === root.replace(/^\/private/, ""));
    if (repo) return repo;
    await sleep(200);
  }
  throw new Error("git repository was not detected");
}

exports.run = async function run() {
  const root = process.env.GITMIT_E2E_REPO;
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push(`ok   ${name}`);
    } catch (error) {
      results.push(`FAIL ${name}: ${error.message}`);
    }
  };

  const extension = vscode.extensions.getExtension("gitmit.gitmit");
  assert.ok(extension, "extension is installed");
  try {
    await extension.activate();
    results.push("ok   extension activates");
  } catch (error) {
    results.push(`FAIL extension activates: ${error && error.stack ? error.stack.split("\n").slice(0, 4).join(" | ") : error}`);
  }
  const repo = await gitRepository(root);
  await vscode.workspace.getConfiguration("gitmit").update("showSuggestions", false, vscode.ConfigurationTarget.Global);

  await check("commands are registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ["gitmit.generate", "gitmit.split", "gitmit.setApiKey", "gitmit.clearApiKey", "gitmit.openSettings"]) {
      assert.ok(commands.includes(id), id);
    }
  });

  await check("generate fills the commit box: TS config, ticket, commitlint", async () => {
    repo.inputBox.value = "";
    await vscode.commands.executeCommand("gitmit.generate", { rootUri: repo.rootUri });
    const message = repo.inputBox.value;
    assert.match(message, /\(ABC-1\)$/, `ticket suffix from the branch: ${JSON.stringify(message)}`);
    assert.ok(!message.includes("\n"), `bodyStyle none from gitmit.config.ts: ${JSON.stringify(message)}`);
    assert.ok(message.length <= 60, `commitlint header-max-length: ${message.length}`);
    assert.match(message, /^(feat|fix|chore|docs)/, "commitlint type-enum");
  });

  await check("split opens the plan panel", async () => {
    await vscode.commands.executeCommand("gitmit.split", { rootUri: repo.rootUri });
    let found = false;
    for (let i = 0; i < 50 && !found; i++) {
      found = vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === "gitmit: Split Commits"));
      if (!found) await sleep(100);
    }
    assert.ok(found, "a 'gitmit: Split Commits' panel opened");
    const staged = execFileSync("git", ["diff", "--staged", "--name-only"], { cwd: root, encoding: "utf8" });
    assert.match(staged, /login\.ts/, "opening the plan changes nothing");
  });

  console.log("\n" + results.join("\n") + "\n");
  if (results.some((r) => r.startsWith("FAIL"))) throw new Error("integration checks failed");
};
