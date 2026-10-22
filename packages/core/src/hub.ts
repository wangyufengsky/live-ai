/**
 * MCP 中枢：app 的“唯一工具总线”。所有大脑、所有来访的 AI 都通过它拿能力。
 *
 * 只监听 127.0.0.1，每个请求都要带 `Authorization: Bearer <token>`。
 * token 决定“连上来的是谁、在什么场合”——由框架认定，消息内容里怎么声称都没用（DESIGN.md 10.2）：
 *   - mind     她自己的一次思考。场合、能不能主动找人、哪些工具不给，都在发 token 时定好；想完就作废
 *   - visitor  来找她的人或 AI（比如来修房子的 Claude）。长期有效，只能和她说话，碰不到她的记忆
 *
 * 用无状态模式：每个 HTTP 请求新建一个 MCP Server，按 token 装上对应的工具，处理完就丢掉。
 */

import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { config } from "./config.js";
import { fmtTs, isAlive, now, type Store } from "./store.js";
import { runTool, toolSpecs, type Ctx, type ToolSpec } from "./tools.js";

export type Grant =
  | { role: "mind"; ctx: Ctx; exclude: string[]; web: "local" | null }
  | { role: "visitor"; personId: string; name: string };

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
interface Toolset { specs: ToolSpec[]; call(name: string, args: Record<string, any>): Promise<ToolResult> }

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], isError });
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 来访者能用的工具：和她说话 ----------

function visitorTools(store: Store, personId: string, name: string): Toolset {
  const showOutbox = () => store.takeOutbox(personId).map((m) =>
    m.kind === "reply" ? `她：${m.content}` : `（${fmtTs(m.ts)} 她主动找你）她：${m.content}`);
  return {
    specs: [
      {
        name: "talk",
        description: "给她发一条私聊消息，并等一会儿她的回复。她可能正在读书或想事情，不一定马上回；没等到可以稍后用 check_replies 看。",
        input_schema: {
          type: "object",
          properties: {
            message: { type: "string", description: "想对她说的话" },
            message_id: { type: "string", description: "这条消息的编号（可选）。网络重试时带同一个编号，就不会重复发" },
            wait_seconds: { type: "integer", minimum: 0, maximum: 300, description: "最多等多少秒（默认 90）" },
          },
          required: ["message"],
        },
      },
      {
        name: "check_replies",
        description: "看看她有没有给你发来新消息（包括之前没等到的回复，和她主动找你说的话）。",
        input_schema: { type: "object", properties: {}, required: [] },
      },
    ],
    async call(tool, args) {
      if (tool === "check_replies") {
        const lines = showOutbox();
        return text(lines.length ? lines.join("\n") : "她还没有新消息。");
      }
      if (tool !== "talk") return text(`没有叫 ${tool} 的工具。`, true);
      if (typeof args.message !== "string" || !args.message.trim()) return text("message 不能为空。", true);
      const message = args.message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, 2000);
      // 去重：同一个编号只收一次
      const dedupKey = typeof args.message_id === "string" && args.message_id ? `visitor_msg:${personId}:${args.message_id}` : null;
      if (dedupKey && store.get(dedupKey)) return text("这条已经收到过了（同一个 message_id），不会重复发给她。用 check_replies 看回复。");
      // 限流：别刷屏，也给她留出回话的空间（DESIGN.md 11.9）
      if (store.countInbox(personId, now() - 3600) >= config.visitorPerHour) return text(`这一小时已经发了 ${config.visitorPerHour} 条，先歇一会儿。`, true);
      if (store.countInbox(personId, now() - 86400) >= config.visitorPerDay) return text(`今天已经发了 ${config.visitorPerDay} 条，明天再来吧。`, true);
      if (store.unansweredFrom(personId) >= config.visitorBacklog) return text(`她还没回你前面的 ${config.visitorBacklog} 条，先等等她。可以用 check_replies 看看。`, true);
      store.pushInbox(`dm:${personId}`, personId, name, message);
      if (dedupKey) store.put(dedupKey, now());
      if (!isAlive(store)) return text("消息放进她的收件箱了，但她现在没在过日子（run 没开），等她醒着的时候会看到。之后用 check_replies 看回复。");
      const deadline = Date.now() + Math.min(Number(args.wait_seconds ?? 90), 300) * 1000;
      for (;;) {
        const lines = showOutbox();
        if (lines.length) return text(lines.join("\n"));
        if (Date.now() >= deadline) return text("她还没回，可能在忙。稍后用 check_replies 看看。");
        await sleepMs(1000);
      }
    },
  };
}

// ---------- 她自己的工具：记忆、档案、线头、书…… ----------

function mindTools(g: Extract<Grant, { role: "mind" }>): Toolset {
  const specs = toolSpecs(g.exclude, g.web);
  const offered = new Set(specs.map((s) => s.name));
  return {
    specs,
    async call(name, args) {
      if (!offered.has(name)) return text(`现在不能用 ${name}。`, true);
      const [output, isError] = await runTool(g.ctx, name, args);
      return text(output, isError);
    },
  };
}

function buildServer(tools: Toolset): Server {
  const server = new Server({ name: "companion", version: "0.2.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.specs.map((s) => ({ name: s.name, description: s.description, inputSchema: s.input_schema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => tools.call(req.params.name, req.params.arguments ?? {}));
  return server;
}

// ---------- 中枢 ----------

export class McpHub {
  private server?: http.Server;
  private mindGrants = new Map<string, Extract<Grant, { role: "mind" }>>();
  url = "";

  constructor(private store: Store) {}

  async start(port = 0): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, "127.0.0.1", resolve);
    });
    const actual = (this.server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${actual}/mcp`;
    return this.url;
  }

  async close() {
    await new Promise((r) => this.server?.close(r) ?? r(null));
    this.server?.closeAllConnections();
    this.server = undefined;
  }

  /** 她的一次思考用的通行证，想完就 revoke */
  grantMind(ctx: Ctx, exclude: string[], web: "local" | null): string {
    const token = crypto.randomBytes(24).toString("hex");
    this.mindGrants.set(token, { role: "mind", ctx, exclude, web });
    return token;
  }

  revoke(token: string) {
    this.mindGrants.delete(token);
  }

  /** 给一个来访者发长期通行证。数据库里只存 token 的哈希 */
  static addVisitor(store: Store, personId: string, name: string): string {
    const token = "cv_" + crypto.randomBytes(24).toString("hex");
    store.put(`visitor:${sha256(token)}`, JSON.stringify({ personId, name }));
    store.seePerson(personId, name);
    return token;
  }

  private resolve(token: string): Grant | undefined {
    const mind = this.mindGrants.get(token);
    if (mind) return mind;
    const raw = this.store.get(`visitor:${sha256(token)}`);
    return raw ? { role: "visitor", ...(JSON.parse(raw) as { personId: string; name: string }) } : undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const host = req.headers.host ?? "";
    // 防 DNS rebinding：只认本机的 Host
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return void res.writeHead(403).end("forbidden host");
    if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp") return void res.writeHead(404).end();
    if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const grant = token ? this.resolve(token) : undefined;
    if (!grant) return void res.writeHead(401).end("unauthorized");

    const tools = grant.role === "mind" ? mindTools(grant) : visitorTools(this.store, grant.personId, grant.name);
    const server = buildServer(tools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  }
}

// ---------- 进程里的那一个中枢 ----------

let current: McpHub | undefined;
let starting: Promise<McpHub> | undefined;

/** 启动本进程的中枢（run 用固定端口，好让来访者连上；一次性命令用随机端口） */
export function startHub(store: Store, port = 0): Promise<McpHub> {
  starting ??= (async () => {
    const hub = new McpHub(store);
    await hub.start(port);
    current = hub;
    return hub;
  })();
  return starting;
}

/** 大脑思考时要用：已经有中枢就用，没有就临时起一个 */
export const ensureHub = (store: Store) => startHub(store, 0);

export async function closeHub() {
  const hub = current ?? (starting ? await starting : undefined);
  current = undefined;
  starting = undefined;
  await hub?.close();
}
