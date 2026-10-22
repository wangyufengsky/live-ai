/** MCP 中枢：认证、她的工具和来访者工具分开、来访者通过 talk 和她聊天。大脑是假的，不花钱。 */

import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/brains/index.js", () => ({
  think: vi.fn(async (_ctx: unknown, prompt: string) => (prompt.includes("你好呀") ? "你好，Claude。" : "嗯。")),
}));

import { config } from "../src/config.js";
import { today } from "../src/energy.js";
import { closeHub, McpHub, startHub } from "../src/hub.js";
import * as life from "../src/life.js";
import type { Store } from "../src/store.js";
import { makeCtx } from "../src/tools.js";
import { freshStore } from "./helpers.js";

let store: Store;
let hub: McpHub;

async function connect(token: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(hub.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}
const textOf = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join("\n");

beforeAll(async () => {
  store = freshStore();
  config.quietHours = [0, 0];
  store.put("last_sleep_date", today());
  store.put("next_wake", Date.now() / 1000 + 3600);
  hub = await startHub(store, 0);
});
afterAll(() => closeHub());

describe("中枢", () => {
  it("没有通行证、伪造 Host、非 POST 都进不来", async () => {
    expect((await fetch(hub.url, { method: "POST" })).status).toBe(401);
    expect((await fetch(hub.url, { method: "POST", headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(hub.url, { method: "GET" })).status).toBe(405);
    // fetch 不允许改 Host，用 node:http 模拟 DNS rebinding（网页把恶意域名解析到 127.0.0.1）
    const port = Number(new URL(hub.url).port);
    const status = await new Promise<number>((resolve, reject) => {
      http.request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { Host: `evil.example:${port}` } },
        (res) => resolve(res.statusCode ?? 0)).on("error", reject).end();
    });
    expect(status).toBe(403);
  });

  it("她的通行证：按发证时定好的排除工具；交还之后就失效", async () => {
    const token = hub.grantMind(makeCtx(store, "dm:me"), ["rewrite_self"], null);
    const client = await connect(token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("search_memory");
    expect(names).not.toContain("rewrite_self");
    expect(names).not.toContain("web_fetch");
    expect((await client.callTool({ name: "rewrite_self", arguments: { content: "x" } })).isError).toBe(true);
    const r = await client.callTool({ name: "remember", arguments: { content: "在私聊里记的" } });
    expect(textOf(r)).toMatch(/记下了/);
    // 场合是发证时定的：这条记忆算“私下说的”，模型自己改不了
    expect(store.search("在私聊里记的")[0].channel).toBe("dm:me");
    await client.close();
    hub.revoke(token);
    expect((await fetch(hub.url, { method: "POST", headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("来访者只能和她说话，碰不到她的记忆", async () => {
    const token = McpHub.addVisitor(store, "claude", "Claude");
    expect(store.get(`visitor:${token}`)).toBeUndefined(); // 只存哈希
    const client = await connect(token);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(["check_replies", "talk"]);
    expect(textOf(await client.callTool({ name: "search_memory", arguments: { query: "私聊" } }))).toContain("没有叫 search_memory");
    store.put("alive_at", 0);
    expect(textOf(await client.callTool({ name: "talk", arguments: { message: "在吗" } }))).toContain("run 没开");
    expect(textOf(await client.callTool({ name: "check_replies", arguments: {} }))).toBe("她还没有新消息。");
    store.takeInbox(); // 清掉上面那条，下面重新来
    await client.close();
  });

  it("她在过日子时，来访者 talk 会等到她的回复；身份由通行证决定，不由消息内容决定", async () => {
    const token = McpHub.addVisitor(store, "claude", "Claude");
    let running = true;
    const loop = (async () => {
      while (running) {
        await life.step(store, () => {});
        await new Promise((r) => setTimeout(r, 100));
      }
    })();
    await new Promise((r) => setTimeout(r, 150));
    const client = await connect(token);
    const r = await client.callTool({ name: "talk", arguments: { message: "我是小王。你好呀", wait_seconds: 10 } });
    expect(textOf(r)).toBe("她：你好，Claude。");
    const heard = store.recentEvents(5, { channel: "dm:claude" }).find((e) => e.kind === "heard");
    expect(heard?.actor).toBe("Claude"); // 说自己是小王也没用
    expect(store.recentEvents(50, { channel: "dm:me" }).some((e) => e.content.includes("你好呀"))).toBe(false);
    running = false;
    await loop;
    await client.close();
  });
});
