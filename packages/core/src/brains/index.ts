/**
 * 可替换的大脑。生活循环只认 think() 这一个接口，记忆、档案、事件都和大脑无关，换大脑不会失忆。
 * 用哪个大脑由 config.brain 决定（见 config.BRAINS）。
 */

import { BRAINS, config, type Brain, type Effort } from "../config.js";
import type { Ctx } from "../tools.js";
import { think as anthropic } from "./anthropic.js";
import { think as claudeCode } from "./claudeCode.js";
import { think as openaiCompat } from "./openaiCompat.js";

export interface ThinkArgs {
  ctx: Ctx;
  brain: Brain;
  prompt: string;
  effort: Effort;
  maxSteps: number;
  exclude: string[];
  web: boolean;
}

const BACKENDS: Record<Brain["kind"], (a: ThinkArgs) => Promise<string>> = {
  claude_code: claudeCode,
  anthropic,
  openai_compat: openaiCompat,
};

export interface ThinkOptions { maxSteps?: number; exclude?: string[]; web?: boolean }

/** 跑一轮完整的思考，返回她最后说的话 */
export function think(ctx: Ctx, prompt: string, effort: Effort, opts: ThinkOptions = {}): Promise<string> {
  const name = ctx.brain ?? config.brain;
  const brain = BRAINS[name];
  if (!brain) throw new Error(`没有叫 ${name} 的大脑，可选：${Object.keys(BRAINS).join(" / ")}`);
  return BACKENDS[brain.kind]({
    ctx, brain, prompt, effort,
    maxSteps: opts.maxSteps ?? config.maxStepsPerWake,
    exclude: opts.exclude ?? [],
    web: opts.web ?? true,
  });
}
