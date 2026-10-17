import { DEFAULT_TYPES, type MessageValidator } from "./message.js";

/** Checking existing commit messages and pull request titles against the team's rules. */

export interface CheckRules {
  types?: readonly string[];
  scopes?: readonly string[];
  subjectMaxLength?: number;
  /** A ticket ID every message must mention, e.g. from the branch name. */
  ticket?: string;
  /** Require some ticket ID when the exact one isn't known. */
  requireTicket?: boolean;
  /** The repository's commitlint rules; when given, they replace gitmit's own header checks. */
  validate?: MessageValidator;
}

const HEADER = /^([a-z]+)(?:\(([^)]*)\))?(!)?: (.*)$/;
const ANY_TICKET = /\b[A-Z][A-Z0-9]+-\d+\b/;

/** Messages git writes itself, which aren't held to the rules. */
export function isGenerated(message: string): boolean {
  return /^(Merge (branch|pull request|remote-tracking branch|tag) |Revert ")/.test(message);
}

/** Problems with a commit message (or, with `headerOnly`, a pull request title); empty means it's fine. */
export async function checkMessage(message: string, rules: CheckRules = {}, options: { headerOnly?: boolean } = {}): Promise<string[]> {
  const text = message.replace(/\r\n/g, "\n").trim();
  const [header = "", second] = text.split("\n");
  const problems: string[] = [];
  if (!header.trim()) return ["the message is empty"];
  if (isGenerated(header)) return [];
  if (/^(fixup|squash|amend)! /.test(header)) return ["a fixup commit: squash it before merging (git rebase -i --autosquash)"];

  if (rules.validate) {
    problems.push(...(await rules.validate(options.headerOnly ? header : text)));
  } else {
    const types = rules.types ?? DEFAULT_TYPES;
    const max = rules.subjectMaxLength ?? 72;
    const match = HEADER.exec(header);
    if (!match) {
      problems.push(`not in "type(scope): description" form, e.g. "fix(auth): handle expired tokens"`);
    } else {
      const [, type, scope, , description = ""] = match;
      if (!types.includes(type!)) problems.push(`type "${type}" isn't one of ${types.join(", ")}`);
      if (scope !== undefined && !scope.trim()) problems.push("the scope is empty; remove the parentheses or name one");
      else if (scope && rules.scopes && !rules.scopes.includes(scope)) problems.push(`scope "${scope}" isn't one of ${rules.scopes.join(", ")}`);
      if (!description.trim()) problems.push("the description is empty");
      else {
        if (/^[A-Z][a-z]/.test(description)) problems.push("start the description with a lowercase letter");
        if (/\.$/.test(description)) problems.push("remove the period at the end of the header");
      }
    }
    if (header.length > max) problems.push(`the header is ${header.length} characters, limit is ${max}`);
    if (!options.headerOnly && second !== undefined && second.trim()) problems.push("put a blank line between the header and the body");
  }

  if (rules.ticket && !text.toUpperCase().includes(rules.ticket.toUpperCase())) problems.push(`mention the ticket ${rules.ticket}`);
  else if (!rules.ticket && rules.requireTicket && !ANY_TICKET.test(text)) problems.push("mention a ticket ID, e.g. PROJ-123");
  return problems;
}
