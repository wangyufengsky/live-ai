/** 大脑：Claude API，需要 ANTHROPIC_API_KEY。 */

import Anthropic from "@anthropic-ai/sdk";
import { Energy } from "../energy.js";
import { SYSTEM } from "../prompts.js";
import { ANTHROPIC_SERVER_TOOLS, brief } from "../tools.js";
import type { ThinkArgs } from "./index.js";
import { openMind } from "./mind.js";

export async function think({ ctx, brain, prompt, effort, maxSteps, exclude, web }: ThinkArgs): Promise<string> {
  const client = new Anthropic();
  const energy = new Energy(ctx.store);
  // 上网用 Claude API 自带的搜索和抓取，所以中枢那边不给本地的 web_fetch
  const mind = await openMind(ctx, exclude, null);
  try {
    return await loop(client, mind, { ctx, brain, prompt, effort, maxSteps, exclude, web }, energy);
  } finally {
    await mind.close();
  }
}

async function loop(
  client: Anthropic, mind: Awaited<ReturnType<typeof openMind>>,
  { ctx, brain, prompt, effort, maxSteps, web }: ThinkArgs, energy: Energy,
): Promise<string> {
  const tools = [...mind.tools, ...(web ? ANTHROPIC_SERVER_TOOLS : [])] as Anthropic.Beta.BetaToolUnion[];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
  let response: Anthropic.Beta.BetaMessage | undefined;

  for (let step = 0; step < maxSteps; step++) {
    response = await client.beta.messages.create({
      model: brain.model,
      max_tokens: 16000,
      system: SYSTEM,
      tools,
      messages,
      output_config: { effort },
      cache_control: { type: "ephemeral" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    const u = response.usage;
    energy.spend(u.input_tokens, u.output_tokens, u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0);
    messages.push({ role: "assistant", content: response.content });
    for (const block of response.content) {
      if (block.type === "server_tool_use") ctx.store.log("did", `${block.name}: ${brief(block.input as object)}`, ctx.channel, "me");
    }

    if (response.stop_reason === "refusal") {
      ctx.store.log("system", "这次的思考被安全机制中止了。", ctx.channel);
      return "";
    }
    if (response.stop_reason === "pause_turn") continue; // 服务端工具（搜索）还没跑完，原样续上
    if (response.stop_reason !== "tool_use") break;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const [output, isError] = await mind.call(block.name, block.input as Record<string, unknown>);
      results.push({ type: "tool_result", tool_use_id: block.id, content: output, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }

  if (!response) return "";
  return response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
}
