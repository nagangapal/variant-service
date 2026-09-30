/**
 * LLM provider abstraction.
 *
 * Deliberately tiny. Three implementations (Anthropic, OpenAI, Ollama) behind one
 * `complete()` call, chosen at boot from LLM_PROVIDER. The point of the interface is
 * that the rest of the system never learns which vendor is answering, and that adding
 * a fourth is a single file.
 *
 * Keys are read from the environment and never leave the server. There is no code path
 * here that can be reached by a browser.
 */

import { getEnv } from '../config/env.js';

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** JSON mode. Providers that support it get structured output; others get a prompt. */
  json?: boolean;
}

export interface CompletionResult {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

// The three providers return three different JSON shapes, so the caller of postJson
// narrows the result itself. `unknown` keeps the boundary honest instead of letting
// `any` leak unchecked property access into the parsing code below.
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(`LLM request failed: ${res.status} ${text.slice(0, 300)}`, res.status);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------

class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // Prompt caching: the system prompt holds the brand voice and the safety rules,
    // and is identical across every candidate we generate for an experiment. Caching
    // it means we pay for it once per experiment rather than once per candidate.
    const res_ = await postJson(
      'https://api.anthropic.com/v1/messages',
      {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0.8,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.user }],
      },
      this.timeoutMs,
    );
    const res = res_ as {
      content?: { type: string; text?: string }[];
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');
    return {
      text,
      model: res.model ?? this.model,
      inputTokens: res.usage?.input_tokens,
      outputTokens: res.usage?.output_tokens,
    };
  }
}

class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly timeoutMs: number,
    private readonly baseUrl: string,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const res = await postJson(
      `${this.baseUrl}/v1/chat/completions`,
      { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 1024,
        temperature: req.temperature ?? 0.8,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      },
      this.timeoutMs,
    );
    const body = res as {
      choices?: { message?: { content?: string } }[];
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: body.choices?.[0]?.message?.content ?? '',
      model: body.model ?? this.model,
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
    };
  }
}

/** Local model. Used for development and for air-gapped deployments. */
class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  constructor(
    private readonly model: string,
    private readonly timeoutMs: number,
    private readonly baseUrl: string,
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const res = await postJson(
      `${this.baseUrl}/api/chat`,
      { 'content-type': 'application/json' },
      {
        model: this.model,
        stream: false,
        format: req.json ? 'json' : undefined,
        options: { temperature: req.temperature ?? 0.8, num_predict: req.maxTokens ?? 1024 },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      },
      this.timeoutMs,
    );
    const body = res as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      text: body.message?.content ?? '',
      model: this.model,
      inputTokens: body.prompt_eval_count,
      outputTokens: body.eval_count,
    };
  }
}

export function createProvider(): LlmProvider | null {
  const env = getEnv();
  switch (env.LLM_PROVIDER) {
    case 'anthropic':
      return new AnthropicProvider(env.LLM_API_KEY, env.LLM_MODEL || 'claude-sonnet-4-5', env.LLM_TIMEOUT_MS);
    case 'openai':
      return new OpenAIProvider(
        env.LLM_API_KEY,
        env.LLM_MODEL || 'gpt-4o-mini',
        env.LLM_TIMEOUT_MS,
        env.LLM_BASE_URL || 'https://api.openai.com',
      );
    case 'ollama':
      return new OllamaProvider(env.LLM_MODEL || 'llama3.1', env.LLM_TIMEOUT_MS, env.LLM_BASE_URL || 'http://localhost:11434');
    case 'none':
      return null;
  }
}
