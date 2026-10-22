/**
 * 大脑接上 MCP 中枢：每次思考领一张一次性通行证，从中枢拿工具、调用工具，想完就交还。
 * 三种大脑都走这里（Claude Code 自己当 MCP 客户端，另外两种用这个 helper），工具只有一个来源。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ensureHub } from "../hub.js";
import type { Ctx, ToolSpec } from "../tools.js";

export interface MindSession {
  url: string;
  token: string;
  tools: ToolSpec[];
  call(name: string, args: Record<string, unknown>): Promise<[string, boolean]>;
  close(): Promise<void>;
}

/** 领通行证。connect=false 时只领不连（给 Claude Code 用，它自己连） */
export async function openMind(ctx: Ctx, exclude: string[], web: "local" | null, connect = true): Promise<MindSession> {
  const hub = await ensureHub(ctx.store);
  const token = hub.grantMind(ctx, exclude, web);
  const session: MindSession = {
    url: hub.url, token, tools: [],
    call: async () => ["没有连上中枢。", true],
    close: async () => hub.revoke(token),
  };
  if (!connect) return session;

  const client = new Client({ name: "companion-brain", version: "0.2.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(hub.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  const { tools } = await client.listTools();
  session.tools = tools.map((t) => ({
    name: t.name, description: t.description ?? "",
    input_schema: { type: "object", properties: (t.inputSchema.properties ?? {}) as Record<string, object>, required: t.inputSchema.required ?? [] },
  }));
  session.call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    const content = (r.content ?? []) as { type: string; text?: string }[];
    return [content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), Boolean(r.isError)];
  };
  session.close = async () => {
    await client.close();
    hub.revoke(token);
  };
  return session;
}
