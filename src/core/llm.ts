import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import "./config";

/**
 * Provider-agnostic LLM interface. Every agent takes an `LLM` so it can be swapped
 * (Anthropic, OpenAI, any OpenAI-compatible server such as Ollama) or faked in tests.
 */
export interface LLM {
  readonly name: string;
  json<T>(opts: { name: string; system: string; prompt: string; schema: z.ZodType<T>; maxTokens?: number }): Promise<T>;
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

class AnthropicLLM implements LLM {
  readonly name: string;
  private client: Anthropic;
  constructor(private model: string) {
    this.name = `anthropic:${model}`;
    this.client = new Anthropic();
  }
  async json<T>({ name, system, prompt, schema, maxTokens = 4000 }: Parameters<LLM["json"]>[0] & { schema: z.ZodType<T> }): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages: [
          {
            role: "user",
            content: attempt === 0 ? prompt : `${prompt}\n\nYour previous output failed validation: ${String(lastErr)}. Return valid input for the tool.`,
          },
        ],
        tools: [{ name, description: `Return the ${name} result.`, input_schema: jsonSchemaOf(schema) as Anthropic.Tool.InputSchema }],
        tool_choice: { type: "tool", name },
      });
      const block = res.content.find((b) => b.type === "tool_use");
      const parsed = schema.safeParse(block && "input" in block ? block.input : undefined);
      if (parsed.success) return parsed.data;
      lastErr = parsed.error.message.slice(0, 500);
    }
    throw new Error(`LLM output for ${name} failed validation: ${String(lastErr)}`);
  }
}

class OpenAICompatLLM implements LLM {
  readonly name: string;
  private client: OpenAI;
  constructor(private model: string, baseURL?: string, apiKey?: string) {
    this.name = `openai-compat:${model}`;
    this.client = new OpenAI({ baseURL, apiKey: apiKey || process.env.OPENAI_API_KEY || "ollama" });
  }
  async json<T>({ name, system, prompt, schema, maxTokens = 4000 }: Parameters<LLM["json"]>[0] & { schema: z.ZodType<T> }): Promise<T> {
    const sys = `${system}\n\nRespond ONLY with a JSON object for "${name}" matching this JSON Schema:\n${JSON.stringify(jsonSchemaOf(schema))}`;
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: attempt === 0 ? prompt : `${prompt}\n\nPrevious output was invalid: ${lastErr}` },
        ],
      });
      const raw = res.choices[0]?.message?.content ?? "";
      try {
        const parsed = schema.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
        lastErr = parsed.error.message.slice(0, 500);
      } catch (e) {
        lastErr = String(e);
      }
    }
    throw new Error(`LLM output for ${name} failed validation: ${lastErr}`);
  }
}

/**
 * Offline mock for demos and tests (LLM_PROVIDER=mock). Deterministic, never invents:
 * it keeps source bullets verbatim and leaves free-text form questions unanswered.
 */
class MockLLM implements LLM {
  readonly name = "mock";
  async json<T>({ name, prompt, schema }: Parameters<LLM["json"]>[0] & { schema: z.ZodType<T> }): Promise<T> {
    let out: unknown;
    if (name === "ping") out = { ok: true };
    else if (name === "job_fit") out = { roleFit: 8, skillsFit: 8, seniorityFit: 7, domainFit: 7, mustHaveGaps: [], strengths: ["mock"], summary: "Mock score (no model configured)." };
    else if (name === "tailored_resume") {
      const roles = [...prompt.matchAll(/<role id="([^"]+)"[^>]*>([\s\S]*?)<\/role>/g)].map((m) => ({
        roleId: m[1],
        bullets: [...m[2].matchAll(/\[([^\]]+)\] (.+)/g)].slice(0, 3).map((b) => ({ sourceId: b[1], text: b[2].trim() })),
      }));
      const summary = prompt.match(/<candidate_summary>\n([^\n]+)/)?.[1] ?? "";
      const company = prompt.match(/Company: (.+)/)?.[1] ?? "your team";
      out = { headline: prompt.match(/Headline: (.+)/)?.[1] ?? "", summary, roles, skillsPriority: [], coverLetter: `I am applying to ${company}.\n\nMy experience is summarized in the attached resume.` };
    } else if (name === "entailment") out = { results: [...prompt.matchAll(/sourceId="([^"]+)"/g)].map((m) => ({ sourceId: m[1], supported: true })) };
    else if (name === "form_answers") out = { answers: [...prompt.matchAll(/"apId":"([^"]+)"/g)].map((m) => ({ apId: m[1], answer: null, confidence: 0 })) };
    return schema.parse(out);
  }
}

export function getLLM(): LLM {
  const provider = (process.env.LLM_PROVIDER || "anthropic").toLowerCase();
  if (provider === "mock") return new MockLLM();
  const model = process.env.LLM_MODEL || (provider === "anthropic" ? "claude-sonnet-4-5" : provider === "openai" ? "gpt-4.1" : "llama3.1");
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (see .env.example)");
    return new AnthropicLLM(model);
  }
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set (see .env.example)");
    return new OpenAICompatLLM(model);
  }
  if (provider === "ollama") return new OpenAICompatLLM(model, process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1", "ollama");
  throw new Error(`Unknown LLM_PROVIDER "${provider}"`);
}

export function getEmbedder(): Embedder | null {
  const p = (process.env.EMBEDDINGS_PROVIDER || "none").toLowerCase();
  if (p === "none") return null;
  const client =
    p === "ollama"
      ? new OpenAI({ baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1", apiKey: "ollama" })
      : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.EMBEDDINGS_MODEL || (p === "ollama" ? "nomic-embed-text" : "text-embedding-3-small");
  return {
    async embed(texts) {
      const res = await client.embeddings.create({ model, input: texts });
      return res.data.map((d) => d.embedding as number[]);
    },
  };
}
