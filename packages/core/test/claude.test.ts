/** Claude API 大脑 + 生活流程：fallbacks、自带搜索、主动私聊的约束、pause_turn、refusal。假的客户端，不花钱。 */

import { afterAll, beforeAll, expect, it, vi } from "vitest";

const script: [string, any[]][] = [];
const calls: any[] = [];
vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    beta = {
      messages: {
        create: async (req: any) => {
          calls.push({ ...req, messages: [...req.messages] });
          const [stop_reason, content] = script.shift()!;
          return { stop_reason, content, usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
        },
      },
    };
  },
}));

import { config } from "../src/config.js";
import { closeHub } from "../src/hub.js";
import { Energy } from "../src/energy.js";
import * as life from "../src/life.js";
import type { Store } from "../src/store.js";
import { freshStore } from "./helpers.js";

const tool = (name: string, input: object = {}) => ({ type: "tool_use", id: `t_${name}`, name, input });
const text = (t: string) => ({ type: "text", text: t });

let store: Store;
afterAll(() => closeHub());
beforeAll(() => {
  store = freshStore();
  config.brain = "claude";
  config.quietHours = [0, 0];
  store.seePerson("me", "小王");
});

it("醒来：挂线头、记东西、想私聊（对方还没同意）", async () => {
  script.push(
    ["tool_use", [tool("start_thread", { title: "山里的庙" }), tool("remember", { content: "一个绕圈的故事", importance: 2 }),
      tool("send_message", { person_id: "me", content: "你好呀" })]],
    ["end_turn", [text("这个故事在绕圈。")]],
  );
  expect(await life.wake(store)).toBe("这个故事在绕圈。");
  const req = calls[0];
  expect(req.model).toBe("claude-opus-5-5");
  expect(req.fallbacks).toBe("default");
  expect(req.betas).toEqual(["server-side-fallback-2026-07-01"]);
  const names = req.tools.map((t: any) => t.name);
  expect(names).toContain("web_search");
  expect(names.filter((n: string) => n === "web_fetch")).toHaveLength(1); // 用自带的抓取，不用本地的
  expect(calls[1].messages[calls[1].messages.length - 1].content[2].content).toContain("还没同意");
});

it("对方同意后可以主动找，回复和主动消息分开记", async () => {
  store.setDmOk("me", true);
  script.push(["tool_use", [tool("send_message", { person_id: "me", content: "今天读到一句话" })]], ["end_turn", [text("想分享。")]]);
  await life.wake(store);
  expect(store.sentToday("me")).toBe(1);
  expect(store.takeOutbox("me").map((m) => m.kind)).toEqual(["outreach"]);
});

it("睡觉：改档案、放下线头、精力恢复", async () => {
  script.push(
    ["tool_use", [tool("rewrite_self", { content: "# 关于我\n\n好像喜欢绕圈的故事。" }), tool("update_thread", { thread_id: 1, status: "dropped" })]],
    ["end_turn", [text("今天读了点书。")]],
  );
  expect(await life.sleep(store)).toBe("今天读了点书。");
  expect(store.readSelf()).toContain("绕圈");
  expect(store.threads(["active"])).toEqual([]);
  expect(new Energy(store).percent).toBe(100);
});

it("pause_turn 会续上；refusal 直接停", async () => {
  script.push(["pause_turn", [text("")]], ["end_turn", [text("嗯。")]]);
  expect(await life.wake(store)).toBe("嗯。");
  script.push(["refusal", []]);
  expect(await life.wake(store)).toBe("");
});
