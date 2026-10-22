/**
 * 大脑：本机已登录的 Claude Code（claude -p），用你自己的订阅额度。
 *
 * 她的工具由 MCP 中枢（hub.ts）提供，Claude Code 自己当 MCP 客户端连上来。只适合你自己在本地陪她：
 * 订阅额度按“个人日常使用”设计，不能接到别的渠道替别人调用。
 */

import { spawn } from "node:child_process";
import readline from "node:readline";
import { config } from "../config.js";
import { Energy } from "../energy.js";
import { SYSTEM } from "../prompts.js";
import { brief } from "../tools.js";
import type { ThinkArgs } from "./index.js";
import { openMind } from "./mind.js";

export async function think(args: ThinkArgs): Promise<string> {
  // 上网用 Claude Code 自带的 WebSearch / WebFetch，中枢那边不给本地的 web_fetch
  const mind = await openMind(args.ctx, args.exclude, null, false);
  try {
    return await run(args, mind.url, mind.token);
  } finally {
    await mind.close();
  }
}

async function run({ ctx, brain, prompt, effort, web }: ThinkArgs, url: string, token: string): Promise<string> {
  const mcpConfig = { mcpServers: { mind: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } };
  const builtin = web ? "WebSearch,WebFetch" : "";
  const cmd = [
    "-p", prompt,
    "--system-prompt", SYSTEM,
    "--model", brain.model,
    "--effort", effort,
    "--output-format", "stream-json", "--verbose",
    "--mcp-config", JSON.stringify(mcpConfig), "--strict-mcp-config",
    // 只给她自己的工具和上网，不给 Claude Code 自带的读写文件、跑命令
    "--tools", builtin,
    "--allowedTools", "mcp__mind__*" + (builtin ? "," + builtin : ""),
    // 不加载你自己的 Claude Code 设置、CLAUDE.md 和插件
    "--setting-sources", "",
    "--no-session-persistence",
  ];

  const proc = spawn(config.claudeBin, cmd, { cwd: ctx.store.dir, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d));
  let result: any;
  for await (const line of readline.createInterface({ input: proc.stdout })) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use" && (block.name === "WebSearch" || block.name === "WebFetch")) {
          ctx.store.log("did", `${block.name}: ${brief(block.input ?? {})}`, ctx.channel, "me");
        }
      }
    } else if (event.type === "result") {
      result = event;
    }
  }
  await new Promise((resolve) => (proc.exitCode !== null ? resolve(null) : proc.once("close", resolve)));

  if (!result) throw new Error(`Claude Code 没有返回结果：${stderr.trim().slice(-500)}`);
  const u = result.usage ?? {};
  new Energy(ctx.store).spend(u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0);
  if (result.is_error) throw new Error(`Claude Code 出错：${result.result || stderr.trim().slice(-500)}`);
  return String(result.result ?? "").trim();
}
