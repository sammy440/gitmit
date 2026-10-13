/**
 * The parts of VS Code's built-in Git extension API that gitmit uses.
 * Full definition: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 */
import type { Event, Uri } from "vscode";

export interface InputBox {
  value: string;
}

export interface Change {
  readonly uri: Uri;
}

export interface RepositoryState {
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  readonly untrackedChanges?: Change[];
  readonly onDidChange: Event<void>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly inputBox: InputBox;
  readonly state: RepositoryState;
  status(): Promise<void>;
}

export interface API {
  readonly git: { readonly path: string };
  readonly repositories: Repository[];
}

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): API;
}
