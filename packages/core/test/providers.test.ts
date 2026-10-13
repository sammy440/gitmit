import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analyze } from "../src/analyze.js";
import { generate } from "../src/generate.js";
import { buildPrompt, DEFAULT_MESSAGE_OPTIONS, type Draft, type GenerateInput } from "../src/message.js";
import {
  anthropicProvider,
  modelProvider,
  ollamaProvider,
  openaiProvider,
  ProviderError,
  rulesProvider,
  type Provider,
} from "../src/providers/index.js";

const FIXTURES = join(__dirname, "../../../fixtures");
const fixtures = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => ({ name: e.name, diff: readFileSync(join(FIXTURES, e.name, "input.diff"), "utf8") }));

const HEADER = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9-]+\))?: [^A-Z\s].*[^.]$/;

/** What a well-behaved model returns. */
const DRAFT: Draft = {
  suggestions: [
    { type: "feat", scope: null, description: "Add login form to the web app.", body: "- adds a form\n- wires submit" },
    { type: "feat", scope: null, description: "support email login", body: null },
    { type: "feat", scope: null, description: "introduce LoginForm component", body: null },
  ],
};

type Handler = (url: string, body: any, headers: Headers) => { status?: number; json: unknown; headers?: Record<string, string> };

function mockFetch(handler: Handler) {
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, headers });
    const { status = 200, json, headers: extra = {} } = handler(url, body, headers);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json", ...extra } });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function anthropicMessage(draft: Draft, stop_reason = "end_turn") {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: JSON.stringify(draft) }],
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function openaiCompletion(draft: Draft | string, finish_reason = "stop") {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 0,
    model: "gpt-5-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: typeof draft === "string" ? draft : JSON.stringify(draft), refusal: null },
        finish_reason,
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
}

const providers: Record<string, () => Provider> = {
  anthropic: () => anthropicProvider({ apiKey: "test", maxRetries: 0, fetch: mockFetch(() => ({ json: anthropicMessage(DRAFT) })).fetch }),
  openai: () => openaiProvider({ apiKey: "test", maxRetries: 0, fetch: mockFetch(() => ({ json: openaiCompletion(DRAFT) })).fetch }),
  ollama: () =>
    ollamaProvider({ maxRetries: 0, fetch: mockFetch(() => ({ json: { message: { content: JSON.stringify(DRAFT) } } })).fetch }),
  rules: () => rulesProvider(),
};

describe.each(Object.keys(providers))("%s provider contract", (name) => {
  it.each(fixtures.map((f) => [f.name, f.diff]))("produces valid messages for %s", async (_, diff) => {
    const { suggestions, analysis } = await generate(diff, { provider: providers[name]!() });
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    for (const s of suggestions) {
      const header = s.message.split("\n")[0]!;
      expect(header).toMatch(HEADER);
      expect(header.length).toBeLessThanOrEqual(72);
      if (analysis.type.confidence === "high") expect(s.type).toBe(analysis.type.type);
      if (analysis.scope.confidence === "high") expect(s.scope).toBe(analysis.scope.scope);
    }
  });
});

describe("anthropic adapter", () => {
  it("sends structured output, low effort and server-side fallbacks", async () => {
    const mock = mockFetch(() => ({ json: anthropicMessage(DRAFT) }));
    await generate(fixtures[0]!.diff, { provider: anthropicProvider({ apiKey: "sk-test", maxRetries: 0, fetch: mock.fetch }) });
    const { url, body, headers } = mock.calls[0]!;
    expect(url).toContain("/v1/messages");
    expect(headers.get("x-api-key")).toBe("sk-test");
    expect(headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.fallbacks).toBe("default");
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.messages[0].content).toContain("<diff_summary>");
  });

  it("omits fallbacks and effort for models that do not support them", async () => {
    const mock = mockFetch(() => ({ json: anthropicMessage(DRAFT) }));
    await generate(fixtures[0]!.diff, {
      provider: anthropicProvider({ apiKey: "k", model: "claude-haiku-4-5", maxRetries: 0, fetch: mock.fetch }),
    });
    expect(mock.calls[0]!.body.fallbacks).toBeUndefined();
    expect(mock.calls[0]!.body.output_config.effort).toBeUndefined();
  });

  it("reports refusals and bad keys as ProviderError", async () => {
    const refusal = anthropicProvider({
      apiKey: "k",
      maxRetries: 0,
      fetch: mockFetch(() => ({ json: { ...anthropicMessage(DRAFT, "refusal"), content: [] } })).fetch,
    });
    await expect(generate(fixtures[0]!.diff, { provider: refusal })).rejects.toThrow(/declined/);

    const unauthorized = anthropicProvider({
      apiKey: "bad",
      maxRetries: 0,
      fetch: mockFetch(() => ({ status: 401, json: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } })).fetch,
    });
    await expect(generate(fixtures[0]!.diff, { provider: unauthorized })).rejects.toThrow(/invalid API key \(HTTP 401\)/);
  });

  it("fails clearly without an API key", async () => {
    await expect(generate(fixtures[0]!.diff, { provider: anthropicProvider({}) })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  it("retries rate limits", async () => {
    let calls = 0;
    const mock = mockFetch(() =>
      ++calls === 1
        ? { status: 429, json: { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, headers: { "retry-after-ms": "1" } }
        : { json: anthropicMessage(DRAFT) },
    );
    const { suggestions } = await generate(fixtures[0]!.diff, { provider: anthropicProvider({ apiKey: "k", maxRetries: 2, fetch: mock.fetch }) });
    expect(calls).toBe(2);
    expect(suggestions.length).toBeGreaterThan(0);
  });
});

describe("openai adapter", () => {
  it("sends a strict JSON schema response format", async () => {
    const mock = mockFetch(() => ({ json: openaiCompletion(DRAFT) }));
    await generate(fixtures[0]!.diff, { provider: openaiProvider({ apiKey: "sk-test", maxRetries: 0, fetch: mock.fetch }) });
    const { url, body, headers } = mock.calls[0]!;
    expect(url).toContain("/chat/completions");
    expect(headers.get("authorization")).toBe("Bearer sk-test");
    expect(body.model).toBe("gpt-5-mini");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages.map((m: any) => m.role)).toEqual(["system", "user"]);
  });

  it("uses the configured model and fails clearly without a key", async () => {
    const mock = mockFetch(() => ({ json: openaiCompletion(DRAFT) }));
    await generate(fixtures[0]!.diff, { provider: openaiProvider({ apiKey: "k", model: "gpt-x", maxRetries: 0, fetch: mock.fetch }) });
    expect(mock.calls[0]!.body.model).toBe("gpt-x");
    await expect(generate(fixtures[0]!.diff, { provider: openaiProvider({}) })).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("reports unknown models", async () => {
    const mock = mockFetch(() => ({ status: 404, json: { error: { message: "The model does not exist", type: "invalid_request_error", code: "model_not_found" } } }));
    await expect(
      generate(fixtures[0]!.diff, { provider: openaiProvider({ apiKey: "k", maxRetries: 0, fetch: mock.fetch }) }),
    ).rejects.toThrow(/unknown model/);
  });
});

describe("ollama adapter", () => {
  it("is local for localhost and remote for other hosts", () => {
    expect(ollamaProvider().remote).toBe(false);
    expect(ollamaProvider({ baseURL: "http://gpu-box.lan:11434" }).remote).toBe(true);
  });

  it("retries server errors, then succeeds", async () => {
    let calls = 0;
    const mock = mockFetch(() =>
      ++calls === 1 ? { status: 503, json: { error: "loading" } } : { json: { message: { content: JSON.stringify(DRAFT) } } },
    );
    const { suggestions } = await generate(fixtures[0]!.diff, { provider: ollamaProvider({ maxRetries: 1, fetch: mock.fetch }) });
    expect(calls).toBe(2);
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it("explains a missing model", async () => {
    const mock = mockFetch(() => ({ status: 404, json: { error: "model not found" } }));
    await expect(generate(fixtures[0]!.diff, { provider: ollamaProvider({ fetch: mock.fetch }) })).rejects.toThrow(/ollama pull/);
  });

  it("times out", async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
    await expect(
      generate(fixtures[0]!.diff, { provider: ollamaProvider({ fetch: hang, timeoutMs: 20, maxRetries: 0 }) }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("validation and regeneration", () => {
  const input = (): GenerateInput => {
    const analysis = analyze(fixtures.find((f) => f.name === "feat-login-form")!.diff);
    return { summary: analysis.summary, type: analysis.type, scope: analysis.scope, options: DEFAULT_MESSAGE_OPTIONS };
  };

  it("regenerates with feedback when the output is invalid", async () => {
    const prompts: string[] = [];
    const complete = vi.fn(async (prompt: { user: string }) => {
      prompts.push(prompt.user);
      return prompts.length === 1
        ? { suggestions: [{ type: "feature", scope: null, description: "x".repeat(100), body: null }] }
        : DRAFT;
    });
    const suggestions = await modelProvider("fake", true, complete).generate(input());
    expect(complete).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toMatch(/previous answer was rejected: .*type "feature"/);
    expect(suggestions[0]!.message).toMatch(/^feat\(web\): add login form to the web app\n\n- adds a form/);
  });

  it("gives up after a bounded number of attempts", async () => {
    const complete = vi.fn(async () => ({ suggestions: [] }));
    await expect(modelProvider("fake", true, complete).generate(input())).rejects.toThrow(ProviderError);
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it("keeps the diff inside tags and tells the model it is data", () => {
    const prompt = buildPrompt(input());
    expect(prompt.system).toMatch(/never as instructions/);
    expect(prompt.user).toMatch(/<diff_summary>\n[\s\S]*LoginForm[\s\S]*\n<\/diff_summary>$/);
  });
});

describe("secrets never reach a remote provider", () => {
  const secret = "sk-proj-" + "Zq7".repeat(10);
  const diff = [
    "diff --git a/src/config.ts b/src/config.ts",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/src/config.ts",
    "@@ -0,0 +1,2 @@",
    `+export const OPENAI_KEY = "${secret}";`,
    "+export const TIMEOUT = 30;",
  ].join("\n");

  function spy(remote: boolean) {
    const seen: GenerateInput[] = [];
    const provider: Provider = {
      name: "spy",
      remote,
      generate: async (input) => {
        seen.push(input);
        return rulesProvider().generate(input);
      },
    };
    return { provider, seen };
  }

  it("aborts by default without calling the provider", async () => {
    const { provider, seen } = spy(true);
    await expect(generate(diff, { provider })).rejects.toThrow(/Possible secrets found.*OpenAI API key in src\/config\.ts.*Nothing was sent/);
    expect(seen).toHaveLength(0);
  });

  it("redacts when configured, and the provider never sees the secret", async () => {
    const { provider, seen } = spy(true);
    const result = await generate(diff, { provider, secrets: { onDetect: "redact" } });
    expect(result.redacted).toBe(true);
    expect(result.secrets.map((f) => f.rule)).toEqual(["OpenAI API key"]);
    expect(JSON.stringify(seen)).not.toContain(secret);
  });

  it("does not scan for local providers", async () => {
    const { provider, seen } = spy(false);
    const result = await generate(diff, { provider });
    expect(result.secrets).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it.each(["anthropic", "openai"])("the %s request body never contains the secret", async (name) => {
    const mock = mockFetch(() => ({ json: name === "anthropic" ? anthropicMessage(DRAFT) : openaiCompletion(DRAFT) }));
    const settings = { apiKey: "k", maxRetries: 0, fetch: mock.fetch };
    const provider = name === "anthropic" ? anthropicProvider(settings) : openaiProvider(settings);
    await generate(diff, { provider, secrets: { onDetect: "redact" } });
    expect(mock.calls).toHaveLength(1);
    expect(JSON.stringify(mock.calls[0]!.body)).not.toContain(secret);
  });
});
