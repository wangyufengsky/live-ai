/**
 * 大脑：兼容 OpenAI 接口的模型（DeepSeek、GPT 等）。
 *
 * DeepSeek 的两条规矩（见 api-docs.deepseek.com 的 thinking mode 一节）：
 * - 思考模式默认开启，用 reasoning_effort（low / high / max）调深浅
 * - 带工具时，之前每一轮的 reasoning_content 都要原样传回，否则会 400
 */

import OpenAI from "openai";
import { Energy } from "../energy.js";
import { SYSTEM } from "../prompts.js";
import type { ThinkArgs } from "./index.js";
import { openMind, type MindSession } from "./mind.js";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam & { reasoning_content?: string };

export async function think({ ctx, brain, prompt, effort, maxSteps, exclude, web }: ThinkArgs): Promise<string> {
  if (brain.kind !== "openai_compat") throw new Error("brain kind mismatch");
  const apiKey = process.env[brain.keyEnv];
  if (!apiKey) throw new Error(`没有设置环境变量 ${brain.keyEnv}`);
  const client = new OpenAI({ apiKey, baseURL: brain.baseUrl });
  const energy = new Energy(ctx.store);
  // 这些模型没有自带上网，用中枢提供的本地 web_fetch
  const mind = await openMind(ctx, exclude, web ? "local" : null);
  try {
    return await loop(client, mind, { ctx, brain, prompt, effort, maxSteps, exclude, web }, energy);
  } finally {
    await mind.close();
  }
}

async function loop(client: OpenAI, mind: MindSession, { ctx, brain, prompt, effort, maxSteps }: ThinkArgs, energy: Energy): Promise<string> {
  if (brain.kind !== "openai_compat") throw new Error("brain kind mismatch");
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = mind.tools.map((s) => ({
    type: "function", function: { name: s.name, description: s.description, parameters: s.input_schema },
  }));
  const extra = brain.effortMap ? { reasoning_effort: brain.effortMap[effort] ?? effort } : {};

  const messages: Msg[] = [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }];
  let last: OpenAI.Chat.Completions.ChatCompletionMessage | undefined;

  for (let step = 0; step < maxSteps; step++) {
    const resp = await client.chat.completions.create({ model: brain.model, messages, tools, ...extra } as any) as OpenAI.Chat.Completions.ChatCompletion;
    spend(energy, resp.usage);
    const choice = resp.choices[0];
    last = choice.message;

    const assistant: Msg = { role: "assistant", content: last.content ?? "" };
    const reasoning = (last as { reasoning_content?: string }).reasoning_content;
    if (reasoning) assistant.reasoning_content = reasoning;
    if (last.tool_calls?.length) (assistant as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam).tool_calls = last.tool_calls;
    messages.push(assistant);

    if (choice.finish_reason === "content_filter") {
      ctx.store.log("system", "这次的思考被内容审核中止了。", ctx.channel);
      return "";
    }
    if (!last.tool_calls?.length) break;

    for (const tc of last.tool_calls) {
      if (tc.type !== "function") continue;
      const name = tc.function.name;
      let output: string, isError: boolean;
      try {
        const args = JSON.parse(tc.function.arguments || "{}");
        [output, isError] = await mind.call(name, args);
      } catch {
        [output, isError] = ["参数不是合法的 JSON。", true];
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: isError ? `[出错] ${output}` : output });
    }
  }
  return (last?.content ?? "").trim();
}

function spend(energy: Energy, usage: OpenAI.Completions.CompletionUsage | undefined) {
  if (!usage) return;
  // DeepSeek 用 prompt_cache_hit_tokens，OpenAI 用 prompt_tokens_details.cached_tokens
  const cached = (usage as { prompt_cache_hit_tokens?: number }).prompt_cache_hit_tokens
    ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  energy.spend(usage.prompt_tokens - cached, usage.completion_tokens, 0, cached);
}
