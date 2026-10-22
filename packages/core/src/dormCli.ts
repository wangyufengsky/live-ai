/**
 * 宿舍的命令行（宿舍目录由 COMPANION_DORM_DIR 指定，默认仓库里的 dorm/）。
 *
 *   companion dorm add <id> --brain deepseek --placeholder 她 [--dir <目录>]   搬进一位居民
 *   companion dorm run                                宿舍开始过日子（所有居民 + 主持人 + MCP 中枢）
 *   companion dorm status                             谁在哪、门开没开、谁睡着了
 *   companion dorm enter --as me --name 小王          人走进宿舍（默认在客厅）
 *   companion dorm go <地方> --as me                  人走动；别人的房间门关着就是敲门
 *   companion dorm say "<话>" --as me                 人在所在的地方说话，在场的人听得到
 *   companion dorm watch --as me                      看自己在场时听到的（一直跟着）
 *   companion dorm leave --as me                      人离开宿舍
 */

import { config } from "./config.js";
import { Dorm } from "./dorm.js";
import { startHub } from "./hub.js";
import { fmtTs } from "./store.js";
import { HUMAN, World, audienceOf } from "./world.js";
import { whereText } from "./worldTools.js";

export async function cmdDorm(args: string[], opts: Record<string, string | undefined>) {
  const world = new World();
  const [action, ...rest] = args;
  const as = opts.as ? HUMAN(opts.as) : undefined;
  const needAs = () => {
    if (!as) throw new Error("要用 --as <你的 id> 说明你是谁，比如 --as me");
    if (!world.presence(as)) throw new Error("你还不在宿舍里，先 dorm enter --as <id> --name <名字>");
    world.touch(as);
    return as;
  };

  switch (action) {
    case "add": {
      const [id] = rest;
      if (!id || !opts.brain || !opts.placeholder) throw new Error("用法：dorm add <id> --brain <大脑> --placeholder <称呼> [--dir <目录>]");
      const r = world.addResident(id, { brain: opts.brain, placeholder: opts.placeholder, dir: opts.dir });
      console.log(`${r.placeholder}（${r.id}）搬进来了：大脑 ${r.brain}，目录 ${r.dir}`);
      return;
    }
    case "run": {
      const dorm = new Dorm(world);
      const first = [...dorm.residents.values()][0];
      if (!first) throw new Error("宿舍里还没有居民，先 dorm add");
      const hub = await startHub(first.store, config.mcpPort);
      console.log(`MCP 中枢：${hub.url}`);
      console.log(`宿舍开始过日子了：${world.residents().map((r) => world.nameOf(r.id)).join("、")}。Ctrl+C 停止。`);
      return dorm.runForever();
    }
    case "status": {
      for (const pl of world.places()) {
        const who = world.whoIsAt(pl.id).map((p) => `${p.name}${world.isAwake(p.entity) ? "" : "（睡着）"}`);
        console.log(`${pl.name}${pl.kind === "room" ? `（门${pl.door === "open" ? "开着" : "关着"}）` : ""}：${who.join("、") || "没人"}`);
      }
      return;
    }
    case "enter": {
      if (!opts.as || !opts.name) throw new Error("用法：dorm enter --as <id> --name <名字>");
      world.enterHuman(opts.as, opts.name);
      console.log(`你走进了宿舍。\n${whereText(world, HUMAN(opts.as))}`);
      return;
    }
    case "go": {
      const me = needAs();
      const target = world.resolvePlace(me, rest.join(" "));
      if (!target) throw new Error(`宿舍里没有“${rest.join(" ")}”这个地方`);
      console.log(world.goTo(me, target).message);
      return;
    }
    case "say": {
      const me = needAs();
      const ev = world.say(me, rest.join(" "));
      const heard = audienceOf(ev).map((e) => world.nameOf(e));
      console.log(heard.length ? `（${heard.join("、")}听到了）` : "（这里没有醒着的人）");
      return;
    }
    case "watch": {
      const me = needAs();
      let last = world.maxEventId() - 20;
      console.log(`你在${world.place(world.location(me)!)!.name}。Ctrl+C 停止。`);
      for (;;) {
        for (const ev of world.eventsSince(last)) {
          last = ev.id;
          if (ev.actor !== me && !audienceOf(ev).includes(me)) continue; // 不在场就听不到
          const who = ev.actor === me ? "你" : world.nameOf(ev.actor);
          console.log(ev.kind === "say" ? `${fmtTs(ev.ts)} ${who}：${ev.content}` : `${fmtTs(ev.ts)} （${ev.content}）`);
        }
        world.touch(me);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    case "leave": {
      const me = needAs();
      world.leaveHuman(me);
      console.log("你离开了宿舍。");
      return;
    }
    default:
      console.log("用法：companion dorm add | run | status | enter | go | say | watch | leave（详见 src/dormCli.ts 开头）");
  }
}
