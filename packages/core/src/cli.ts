#!/usr/bin/env node
/**
 * 命令行入口。
 *
 *   companion run                       让她开始持续生活（心跳 + 每晚睡觉）
 *   companion wake                      手动叫醒她一次
 *   companion sleep                     手动让她睡一觉（反思整理）
 *   companion chat --id me --name 小王  以某个身份和她私聊
 *   companion status                    看看她现在的状态
 *   companion visitor add <id> <名字>   给来访者（人或 AI）发一张通行证，让 ta 能通过 MCP 来找她聊天
 *
 * 加 --brain 临时换大脑（名字见 config.BRAINS），比如 --brain claude_code。
 */

import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { BRAINS, config } from "./config.js";
import { Energy } from "./energy.js";
import { closeHub, McpHub, startHub } from "./hub.js";
import { chat, isAlive, runForever, sleep, wake } from "./life.js";
import { fmtTs, Store } from "./store.js";

// 让所有请求（模型、网页）都遵守 HTTP(S)_PROXY / NO_PROXY，和 Python 版的 httpx 一样
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

/** 把她发给这个人的消息打印出来。收到了回复就返回 true */
function showOutbox(store: Store, personId: string): boolean {
  let gotReply = false;
  for (const m of store.takeOutbox(personId)) {
    if (m.kind === "reply") {
      console.log(`她：${m.content}`);
      gotReply = true;
    } else {
      console.log(`（${fmtTs(m.ts)} 她主动找你）她：${m.content}`);
    }
  }
  return gotReply;
}

/** 她正在 run 里生活：消息放进收件箱，等她忙完手上的事再回 */
async function sendViaLife(store: Store, personId: string, name: string, text: string) {
  store.pushInbox(`dm:${personId}`, personId, name, text);
  console.log("（已发出，她看到会回）");
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    if (showOutbox(store, personId)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log("（她暂时没回，可能在忙。回复会在下次打开聊天时显示）");
}

async function cmdChat(store: Store, personId: string, name: string) {
  store.seePerson(personId, name);
  showOutbox(store, personId);
  console.log(`以 ${name} 的身份聊天。/dm on|off 设置是否允许她主动找你，/bye 退出。`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const text = (await rl.question(`${name}：`)).trim();
      if (!text) continue;
      if (text === "/bye") break;
      if (text === "/dm on" || text === "/dm off") {
        const ok = text.endsWith("on");
        store.setDmOk(personId, ok);
        store.log("system", `${name} ${ok ? "允许" : "不再允许"}我主动私聊 ta`, `dm:${personId}`);
        console.log("（已设置）");
        continue;
      }
      if (isAlive(store)) await sendViaLife(store, personId, name, text);
      else console.log(`她：${(await chat(store, personId, name, text)) || "……"}`);
    }
  } finally {
    rl.close();
  }
}

function cmdStatus(store: Store) {
  console.log(`大脑：${config.brain}（${BRAINS[config.brain]?.model}）`);
  console.log(`精力：${new Energy(store).percent}%`);
  console.log(`记忆：${(store.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE faded = 0").get() as { n: number }).n} 条`);
  console.log("线头：");
  for (const t of store.threads(["active", "resting"])) console.log(`  #${t.id} [${t.status}] ${t.title} —— ${t.note}`);
  console.log("认识的人：");
  for (const p of store.people()) console.log(`  ${p.name}（${p.id}）：${p.notes}`);
  console.log("\n" + store.readSelf());
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { brain: { type: "string" }, id: { type: "string" }, name: { type: "string" } },
  });
  if (values.brain) {
    if (!BRAINS[values.brain]) throw new Error(`没有叫 ${values.brain} 的大脑，可选：${Object.keys(BRAINS).join(" / ")}`);
    config.brain = values.brain;
  }
  const store = new Store();
  try {
    switch (positionals[0]) {
      case "run": {
        const hub = await startHub(store, config.mcpPort);
        console.log(`MCP 中枢：${hub.url}`);
        return await runForever(store);
      }
      case "wake":
        return console.log((await wake(store)) || "（她什么也没说）");
      case "sleep":
        return console.log((await sleep(store)) || "（她什么也没说）");
      case "chat":
        if (!values.id || !values.name) throw new Error("chat 需要 --id 和 --name");
        return await cmdChat(store, values.id, values.name);
      case "status":
        return cmdStatus(store);
      case "visitor":
        return cmdVisitor(store, positionals.slice(1));
      default:
        console.log("用法：companion [--brain 名字] run | wake | sleep | status | chat --id <id> --name <名字> | visitor add <id> <名字>");
    }
  } finally {
    await closeHub(); // 一次性命令用完就关掉临时的中枢，进程才能退出
  }
}

function cmdVisitor(store: Store, args: string[]) {
  const [action, id, name] = args;
  if (action !== "add" || !id || !name) throw new Error("用法：companion visitor add <id> <名字>");
  const token = McpHub.addVisitor(store, id, name);
  const url = `http://127.0.0.1:${config.mcpPort}/mcp`;
  console.log(`给 ${name}（${id}）的通行证（只显示这一次，数据库里只存哈希）：\n${token}\n`);
  console.log("在 Claude Code 里接上：");
  console.log(`claude mcp add --transport http companion ${url} --header "Authorization: Bearer ${token}"`);
  console.log("\n只有 run 在跑的时候她才收得到；接上后可以用 talk 和她说话，用 check_replies 看回复。");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
