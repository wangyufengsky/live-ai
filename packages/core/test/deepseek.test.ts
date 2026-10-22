/** DeepSeek（openai_compat）大脑：reasoning_content 回传、工具执行、本机地址被挡、精力。假的客户端，不花钱。 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const script: any[] = [];
const seen: any[] = [];
vi.mock("openai", () => ({
  default: class FakeOpenAI {
    constructor(opts: { baseURL: string }) {
      expect(opts.baseURL).toBe("https://api.deepseek.com");
    }
    chat = {
      completions: {
        create: async (req: any) => {
          seen.push(JSON.parse(JSON.stringify(req)));
          return script.shift();
        },
      },
    };
  },
}));

import { config } from "../src/config.js";
import { closeHub } from "../src/hub.js";
import * as life from "../src/life.js";
import type { Store } from "../src/store.js";
import { freshStore } from "./helpers.js";

function completion(content = "", reasoning?: string, calls: [string, object][] = []) {
  const message: any = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.length) {
    message.tool_calls = calls.map(([name, args], i) => ({ id: `c${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } }));
  }
  return {
    choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_cache_hit_tokens: 800 },
  };
}

let store: Store;
afterAll(() => closeHub());
beforeAll(() => {
  process.env.DEEPSEEK_API_KEY = "test";
  store = freshStore();
  config.brain = "deepseek";
  config.quietHours = [0, 0];
  fs.writeFileSync(path.join(config.booksDir, "b.txt"), "一二三".repeat(2000));
});

it("醒来：工具执行、reasoning_content 回传、本机地址被挡、没提供的工具不能用", async () => {
  script.push(
    completion("", "先看看书架", [["list_books", {}], ["web_fetch", { url: "http://127.0.0.1:3000/send" }]]),
    completion("", "读一下", [["read_book", { name: "b.txt" }], ["rewrite_self", { content: "# 我\n叫小一" }], ["no_such", {}]]),
    completion("读了点书，给自己取了个名字。", "好了"),
  );
  expect(await life.wake(store)).toBe("读了点书，给自己取了个名字。");

  const req = seen[0];
  expect(req.model).toBe("deepseek-flash");
  expect(req.reasoning_effort).toBe("high");
  expect(req.messages[0].role).toBe("system");
  const names = req.tools.map((t: any) => t.function.name);
  expect(names).toContain("web_fetch");
  expect(names).not.toContain("web_search");

  // 之后每次请求都要带回第一轮的 reasoning_content
  expect(seen[1].messages[2].reasoning_content).toBe("先看看书架");
  expect(seen[2].messages[2].reasoning_content).toBe("先看看书架");

  const toolMsgs = seen[2].messages.filter((m: any) => m.role === "tool");
  expect(toolMsgs[0].content).toContain("b.txt（读到 0%）");
  expect(toolMsgs[1].content).toContain("本机或局域网");
  expect(toolMsgs[toolMsgs.length - 1].content).toContain("不能用 no_such");
  expect(store.readSelf()).toContain("小一");
  expect(Number(store.get("energy_used"))).toBe(3 * (200 + 100 + 80));
});

it("睡觉时不给上网、不给发消息", async () => {
  script.push(completion("日记"));
  await life.sleep(store);
  const names = seen[seen.length - 1].tools.map((t: any) => t.function.name);
  expect(names).not.toContain("web_fetch");
  expect(names).not.toContain("send_message");
});
