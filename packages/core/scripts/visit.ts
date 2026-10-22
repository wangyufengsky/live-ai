/**
 * 以来访者的身份通过 MCP 中枢找她聊天（她得在 run 里过日子）。
 *
 *   npx tsx scripts/visit.ts "想说的话"          说一句，等她回
 *   npx tsx scripts/visit.ts --check              看看她有没有新消息
 *
 * 通行证默认读 data/visitors/claude.token（用 `companion visitor add` 发放），
 * 也可以用环境变量 COMPANION_VISITOR_TOKEN_FILE 指定别的。
 */

import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { config } from "../src/config.js";

const tokenFile = process.env.COMPANION_VISITOR_TOKEN_FILE ?? path.join(config.dataDir, "visitors", "claude.token");
const token = fs.readFileSync(tokenFile, "utf-8").trim();
const url = `http://127.0.0.1:${config.mcpPort}/mcp`;

const client = new Client({ name: "visitor", version: "0.2.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
const [arg] = process.argv.slice(2);
const result = arg === "--check" || !arg
  ? await client.callTool({ name: "check_replies", arguments: {} })
  : await client.callTool({ name: "talk", arguments: { message: arg, wait_seconds: 180 } }, undefined, { timeout: 200_000 });
console.log((result.content as { type: string; text: string }[]).map((c) => c.text).join("\n"));
await client.close();
