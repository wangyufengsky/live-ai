/** 框架配置。所有可调的东西都放在这里。 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根目录（src/ 和 dist/ 都在 packages/core/ 下面，往上三层） */
export const ROOT = path.resolve(here, "../../..");

export type Effort = "low" | "medium" | "high" | "max";

export type Brain =
  /** 本机已登录的 Claude Code（你的订阅）。只适合你自己在本地陪她，不能接到别的渠道替别人调用 */
  | { kind: "claude_code"; model: string }
  /** Claude API，需要 ANTHROPIC_API_KEY */
  | { kind: "anthropic"; model: string }
  /** 兼容 OpenAI 接口的模型（DeepSeek、GPT 等） */
  | { kind: "openai_compat"; baseUrl: string; model: string; keyEnv: string; effortMap?: Partial<Record<Effort, string>> };

/** 可选的大脑。每个居民（数据目录）可以用不同的大脑 */
export const BRAINS: Record<string, Brain> = {
  deepseek: {
    kind: "openai_compat",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    keyEnv: "DEEPSEEK_API_KEY",
    // 我们的 effort 档位 → DeepSeek 的 reasoning_effort（只有 low / high / max）
    effortMap: { low: "low", medium: "high", high: "high", max: "max" },
  },
  claude_code: { kind: "claude_code", model: "opus" },
  claude: { kind: "anthropic", model: "claude-opus-5-5" },
};

export const config = {
  dataDir: process.env.COMPANION_DATA_DIR ?? path.join(ROOT, "data"),
  brain: process.env.COMPANION_BRAIN ?? "deepseek",
  claudeBin: "claude",
  /** run 时 MCP 中枢监听的端口（只在 127.0.0.1 上）。来访者连这个端口 */
  mcpPort: Number(process.env.COMPANION_MCP_PORT ?? 7788),

  // 心跳和反思用 medium，聊天想更快可以调成 low
  effortWake: "medium" as Effort,
  effortChat: "medium" as Effort,
  effortSleep: "high" as Effort,

  /** 每天的“精力”，单位是 token。用完了她就会“累”，只回消息不再主动做事 */
  dailyEnergy: 400_000,
  /** 一次心跳最多调用几轮工具，防止一次醒来就停不下来 */
  maxStepsPerWake: 12,

  /** 心跳间隔（分钟），实际会在区间内随机，避免像闹钟一样机械 */
  wakeIntervalMin: [40, 90] as [number, number],
  /** 几点“睡觉”（做当天的反思整理） */
  sleepHour: 2,
  /** 夜里不主动醒来、不打扰别人的时段 [开始, 结束) */
  quietHours: [0, 8] as [number, number],

  /** 主动找人聊天的上限：每人每天最多几条 */
  dmPerPersonPerDay: 3,
  /** 每次醒来带进上下文的最近事件条数（短期记忆） */
  recentEvents: 40,

  get booksDir() {
    return path.join(this.dataDir, "books");
  },
  get dbPath() {
    return path.join(this.dataDir, "mind.db");
  },
  get selfPath() {
    return path.join(this.dataDir, "self.md");
  },
};
