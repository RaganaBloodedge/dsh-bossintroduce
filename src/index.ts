// dsh-bossintroduce —— DeepSeek Harness 插件入口。
//
// 职责很窄：把「在 Boss 直聘求职者侧浏览岗位、逐条投差异化自我介绍」这套状态机
// 暴露成模型可调用的工具。状态判定、点击、填入、发送这些确定性动作全部落在
// `scripts/flow.mjs`（零第三方依赖的 CDP 执行器）里，本文件只负责按 dsh 插件规范挂载，
// 因此 skill 形态与插件形态共用同一份引擎，不会各写一版。
//
// 本地开发：  照 cordis.example.yml 填好绝对路径，再
//             dsh --profile web --patch "<填好的清单>" --dump-config
// 持久挂载：  把清单里的 `- insert:` 块粘进 ~/.dsh/profiles/<name>/cordis.patch.yml
// 发布：      发到 npm registry 后，在 dsh 的插件页输入包名 dsh-bossintroduce 即可安装
//             （管理器读 package.json 的 dsh.bundle.patch 自动写 profile 配置）
//
// 三条硬规矩（违反了不报错，只是行为诡异）：
//   1. 只用具名导出，绝不 export default —— 默认导出会让加载器丢掉 inject 等元数据；
//   2. 模块顶层不留副作用，一切在 apply 内完成（插件会被反复挂载/卸载）；
//   3. **不要用 process.execPath 直接起 Node** —— dsh 桌面应用里它指向 Electron，
//      必须带 ELECTRON_RUN_AS_NODE=1 才是纯 Node（见 resolveNode）。
//
// 个人数据（能力图谱 / 投递配置 / 浏览器登录态）不在本包里，落点在
// `$AI_HOME/data`（默认 ~/.auto-introduce/data），由 scripts/paths.mjs 统一解析。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

/** 插件名（与 npm 包名一致）。 */
export const name = 'dsh-bossintroduce';

/**
 * 依赖的服务槽。cordis 4 会强制校验：apply 里访问 ctx.<service> 前必须在这里声明，
 * 否则激活即抛 `cannot get property "<service>" without inject`。
 * systemPrompt 不是可选服务 —— dsh 桌面端总有它（dsh-tools 自身也依赖它），
 * 所以放心声明为必需；换来的是 ctx.systemPrompt 可以直接访问。
 */
export const inject = ['tools', 'systemPrompt'];

/**
 * 包根目录。dist/index.js 与 src/index.ts 都在根目录下一层，所以取两次 dirname
 * 两种加载方式得到同一个值（这也是本地 `--patch` 与装进 node_modules 都能跑的写法）。
 */
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const FLOW = join(PKG_ROOT, 'scripts', 'flow.mjs');
const GUARD = join(PKG_ROOT, 'scripts', 'guard.py');
const INIT = join(PKG_ROOT, 'scripts', 'init.mjs');

/** 一次子进程调用的规范化结果。所有 boss_* 工具都返回这个形状。 */
interface Outcome {
  ok: boolean;
  exitCode: number;
  output: string;
  error: string;
}

/** CDP 调试端口上的一次探测结果。 */
interface CdpInfo {
  reachable: boolean;
  detail: string;
}

export interface Config {
  /** 数据根目录；留空 = ~/.auto-introduce（等价于环境变量 AI_HOME） */
  aiHome?: string | null;
  /** 直接指定数据目录；留空 = <aiHome>/data（等价于 AI_DATA_DIR） */
  dataDir?: string | null;
  /** CDP 端点；留空 = http://127.0.0.1:9222 */
  cdpEndpoint?: string | null;
  /** 浏览器 profile 目录；留空 = <aiHome>/edge-profile */
  browserProfile?: string | null;
  /** 每次操作后的强制静默毫秒数；留空 = 2000（**不要调小**，见 SKILL.md 铁律 4） */
  gapMs?: number | null;
  /** 浏览器可执行文件路径（msedge.exe / chrome.exe 绝对路径）；留空 = 自动发现 */
  browserPath?: string | null;
  /** Node 可执行文件路径；留空 = 自动发现（Electron 下会带 ELECTRON_RUN_AS_NODE） */
  nodePath?: string | null;
  /** Python 可执行文件路径（护栏要它）；留空 = 自动发现 */
  pythonPath?: string | null;
}

// ------------------------------------------------------------------ 解释器发现

/**
 * 解析用来跑引擎的 Node。
 *
 * dsh 桌面应用跑在 Electron 里，`process.execPath` 是 Electron 二进制；直接拿它执行
 * `.mjs` 会去启动一个应用而不是脚本。`ELECTRON_RUN_AS_NODE=1` 让同一个二进制退回纯
 * Node 行为 —— 这是 Electron 官方支持的用法，不需要用户另外装 Node。
 */
function resolveNode(config: Config): { cmd: string; env: Record<string, string> } {
  const explicit = config.nodePath || process.env.AI_NODE;
  if (explicit) return { cmd: explicit, env: {} };
  if (process.versions.electron) {
    return { cmd: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return { cmd: process.execPath, env: {} };
}

let pythonCache: { cmd: string; args: string[] } | null = null;

/** 探一次 Python：能起来、且自报是 Python 才算数（Windows 商店版 `python` 是个转发壳）。 */
function probePython(candidate: string): { cmd: string; args: string[] } | null {
  const parts = candidate.split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const [cmd, ...args] = parts as [string, ...string[]];
  if (parts.length === 1 && /[\\/]/.test(candidate) && !existsSync(candidate)) return null;
  try {
    const r = spawnSync(cmd, [...args, '--version'], { encoding: 'utf8', timeout: 8000, shell: false });
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status === 0 && /Python\s+\d/i.test(text)) return { cmd, args };
  } catch {
    /* 候选不可用，继续试下一个 */
  }
  return null;
}

/**
 * 解析 Python。按 `--config.pythonPath` → `AI_PYTHON` → `python3` → `python` → `py -3`
 * 顺序探测，第一个能自报版本号的胜出。结果缓存，进程内只探一次。
 */
function resolvePython(config: Config): { cmd: string; args: string[] } | null {
  if (pythonCache) return pythonCache;
  const candidates = [config.pythonPath, process.env.AI_PYTHON, 'python3', 'python', 'py -3']
    .filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    const found = probePython(c);
    if (found) {
      pythonCache = found;
      return found;
    }
  }
  return null;
}

// ------------------------------------------------------------------ 端口与浏览器

/** 读一个 HTTP 端点，失败也当结果返回（不抛）。 */
async function probeCdp(endpoint: string): Promise<CdpInfo> {
  const url = `${endpoint.replace(/\/+$/, '')}/json/version`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return { reachable: false, detail: `HTTP ${resp.status} @ ${url}` };
    const body = (await resp.json()) as { Browser?: string; webSocketDebuggerUrl?: string };
    return { reachable: true, detail: `${body.Browser ?? '(未知浏览器)'} @ ${url}` };
  } catch (err) {
    return { reachable: false, detail: `${err instanceof Error ? err.message : String(err)} @ ${url}` };
  }
}

/** 自动发现浏览器可执行文件；返回 null 表示让用户用 config.browserPath 指路。 */
function discoverBrowser(): string | null {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ]
    : ['microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser'];
  for (const c of candidates) {
    if (c.includes('/') || c.includes('\\')) {
      if (existsSync(c)) return c;
    } else {
      const r = spawnSync('which', [c], { encoding: 'utf8' });
      if (r.status === 0 && (r.stdout ?? '').trim()) return (r.stdout ?? '').trim();
    }
  }
  return null;
}

/** 把启动参数拼出来（与 scripts/launch-edge.sh 保持一致，两处别各写一版）。 */
function browserArgs(port: number, profile: string, url: string): string[] {
  return [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    url,
  ];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 子进程执行

interface RunOptions {
  /** 覆盖 cwd（默认包根目录）。 */
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * 跑一个子进程并收集结果。**不抛异常** —— 超时、非零退出、起不来都变成 Outcome，
 * 因为对模型来说这些都是可读的观察，不是栈回溯。
 */
function run(cmd: string, args: string[], env: Record<string, string>, opts: RunOptions): Promise<Outcome> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd ?? PKG_ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      resolvePromise({ ok: false, exitCode: -1, output: '', error: `无法启动 ${cmd}：${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (o: Outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolvePromise(o);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退了 */ }
      finish({
        ok: false,
        exitCode: -1,
        output: stdout,
        error: `超时 ${opts.timeoutMs}ms —— 已终止。界面可能还停在半途，先用 boss_state 看一眼再决定下一步。`,
      });
    }, opts.timeoutMs);

    const onAbort = () => {
      try { child.kill(); } catch { /* 同上 */ }
      finish({ ok: false, exitCode: -1, output: stdout, error: '调用被取消' });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      finish({ ok: false, exitCode: -1, output: stdout, error: `无法启动 ${cmd}：${err.message}` });
    });
    child.on('close', (code) => {
      const exitCode = code ?? -1;
      finish({ ok: exitCode === 0, exitCode, output: stdout.trim(), error: stderr.trim() });
    });
  });
}

// ------------------------------------------------------------------ 上下文（config + 环境）

interface Ctx {
  config: Config;
  env: Record<string, string>;
  endpoint: string;
  port: number;
  profile: string;
}

/** 把插件配置翻译成引擎认识的环境变量；引擎那边只认环境变量，不认插件配置。 */
function makeCtx(config: Config): Ctx {
  const aiHome = config.aiHome || process.env.AI_HOME || join(homedir(), '.auto-introduce');
  const env: Record<string, string> = { AI_HOME: aiHome };
  if (config.dataDir) env.AI_DATA_DIR = resolve(config.dataDir);
  if (config.browserProfile) env.FLOW_PROFILE = resolve(config.browserProfile);
  if (config.cdpEndpoint) env.CDP_ENDPOINT = config.cdpEndpoint;
  if (config.gapMs != null && Number.isFinite(config.gapMs)) env.FLOW_GAP_MS = String(config.gapMs);

  const endpoint = config.cdpEndpoint || process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';
  const port = Number(new URL(endpoint).port || 9222);
  const profile = config.browserProfile ? resolve(config.browserProfile) : join(aiHome, 'edge-profile');
  return { config, env, endpoint, port, profile };
}

/** 跑 flow.mjs 的某个子命令。 */
async function flow(c: Ctx, argv: string[], exec: { signal: AbortSignal }, timeoutMs: number): Promise<Outcome> {
  const node = resolveNode(c.config);
  return run(node.cmd, [FLOW, ...argv], { ...c.env, ...node.env }, { timeoutMs, signal: exec.signal });
}

// ------------------------------------------------------------------ 工具输出契约

/**
 * 所有 boss_* 工具共用的输出 schema。
 *
 * 刻意不做成结构化字段：引擎的输出协议（`OK` / `KEY k=v` / `DETAIL` / `FAIL`+`FIX`）
 * 本身就是给模型读的行格式，逐行透传比再包一层 JSON 更省 token、也更好核对。
 *
 * ⚠️ 必须 `as const`：不加的话 `type: 'object'` 会被推宽成 `string`，不再满足
 * `ValueSchemaSpec` 这个按 `type` 判别的联合，`O` 直接塌成 `never`，`execute` 的返回
 * 类型随之变成 `Promise<never>` —— 报错落在每个 execute 上，看不出真正原因。
 */
const OUTCOME_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    exitCode: { type: 'number' },
    output: { type: 'string' },
    error: { type: 'string' },
  },
} as const;

/** 生成一个 boss_* 工具的共享选项（超时、并发、输出契约）。 */
const common = (timeoutMs: number) => ({
  output: {
    schema: OUTCOME_SCHEMA,
    render(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
      const v = value as Outcome;
      const body = [v.output, v.error].filter(Boolean).join('\n');
      const head = v.ok ? 'exit 0' : `exit ${v.exitCode} — 未完成`;
      return [{ type: 'text', text: `${head}\n${body}`.trim() }];
    },
  },
  timeoutMs,
  isConcurrencySafe: (_args: unknown) => false,
});

// ------------------------------------------------------------------ 系统提示词

/**
 * 插件往系统提示词里加的一节。
 *
 * dsh 的插件没有 SKILL.md 那套自动加载，所以「什么时候该点哪个工具、哪几步绝不能跳」
 * 必须由插件自己声明，否则模型只看到十来个孤立的工具名，会拿它当浏览器遥控器乱点。
 * 完整版（含界面事实、失败态、环境坑）在 references/ 里，这里只放做对事情所需的最小集。
 */
const WORKFLOW_SECTION = `## Boss 直聘投递（dsh-bossintroduce）

工具 \`boss_*\` 驱动一个**可见的**浏览器，在 Boss 直聘求职者侧浏览岗位，为每条 JD 写一段
只属于它的自我介绍并发给那位 HR。匹配判断与文案撰写由你完成；状态判定、点击、填入、发送
由工具完成。不要用 bash/curl 自己驱动浏览器，也不要另起无头浏览器。

### 开工顺序（固定，不要每次重新推导）
1. \`boss_where\` —— 确认数据目录已初始化。缺图谱就先 \`boss_init\`，再按 \`references/01-能力图谱.md\`
   的八步建图谱（先问用户：简历路径 / 公开链接 / 项目分档 / **不能怎么写**的黑名单）。
2. \`boss_browser\`：先 \`action=status\`，连不上再 \`action=launch\`。
   **绝不 taskkill 清场** —— 那会连用户已登录的浏览器一起杀掉。
3. \`boss_state\` —— 由它给判定。HOME/JOBS/CHAT 即**已登录**，直接继续；只有判出 LOGIN 才停下，
   让用户登录后 \`boss_wait_login\`。**绝不默认"未登录"让用户重登一次。**
4. \`boss_enter\` → \`boss_pick\`（label 取 \`profile.md\` 里那个意向标签，别临场猜）。
5. 循环：\`boss_read\` → 判断 → 不匹配就 \`boss_next_card\` 再读；
   匹配就写文案 → \`boss_guard\` → \`boss_contact\` → \`boss_say\` → \`boss_back\`（**带 label**）。

### 取岗
- 岗位只从**意向筛选列表**里取（\`boss_pick --label\`），不要停在默认推荐流。
- 🔴 **一张一张看，禁止批量取列表**：意向列表在点过「立即沟通」后会自行刷新（已沟通的移出、
  其余重排），任何提前抓下来的清单下一轮必然错位。永远只处理当前屏幕上这一张。
- \`boss_back\` 一定带 label —— 光 back 会落回默认推荐流，意向筛选丢失。

### 发送（发出不可撤回）
- 只有 \`boss_say\` 能点到发送。**必须先过 \`boss_guard\` 且退出码 0**；不合格的文案发出去收不回来。
- 文案的**语气、形式与长度以数据目录为准**：先读 profile.md 的「文案语气与长度」与图谱的
  writing_rules.tone / writing_rules.budget（闸门由 budget 决定，别凭记忆写死字数）。
  本机当前口径：**站内聊天消息体**、以「尊敬的HR」开头、敬语诚恳、目标 400–800 字。
  🔴 **它是聊天消息不是信件**：不写「此致/敬礼」、不写落款签名、不写「冒昧来信」、不用首行缩进。
- **零业绩数字**（提速倍数 / 测试条数 / 吞吐量 / 百分比一律不写），
  只保留必要的时间与身份信息（如"2026 年 7 月毕业"）。院校背书类数字可例外。
- 只能引用能力图谱里的事实，不得新增。每条的主攻事实要**换着挑**，别拿同一张牌投所有岗位。
- 别把草稿留在输入框里就当成投过了：草稿会丢（切会话后只剩最近一条）。成果按"已发出"计数。

### 硬过滤（逐项对 profile.md）
城市 / 薪资左边界 / 学历 / 经验 / 毕业时间窗口。任一项不符 → \`boss_next_card\`，不要投。

### 节奏
引擎已把「每次操作后静默 ≥2 秒」挂在退出钩子上强制生效（\`FLOW_GAP_MS\`）——
既有风控原因，也因为界面常常还没加载完。别绕过、别调小、别并发。

### 收尾
凑满 N 份即停，报清单：岗位 / HR / 公司 / 薪资 / 主攻事实 / 文案首句，说明全部为**已发送**，
并说清跳过了哪些岗位、为什么。`;

/** 系统提示词里这一节的排序位（紧跟 MCP 服务之后，早于 SDK 工具说明）。 */
const SECTION_ORDER = 3200;

// ------------------------------------------------------------------ apply

export function apply(ctx: Context, config: Config = {}): void {
  const c = makeCtx(config);

  // ── 系统提示词：告诉模型这套工具的正确用法与红线 ─────────────────────
  // systemPrompt 已在 inject 里声明（cordis 4 不声明就访问会直接抛错），
  // 此处 cast 只是因为泛型 Context 类型没有带上这个属性。
  const sp = (ctx as unknown as { systemPrompt?: { section?: (s: unknown) => () => void } }).systemPrompt;
  if (typeof sp?.section === 'function') {
    ctx.effect(() =>
      (sp.section as (s: unknown) => () => void)({
        name: 'dsh-bossintroduce',
        order: SECTION_ORDER,
        text: WORKFLOW_SECTION,
        interpolate: false,
      }),
    );
  }

  // ── 位置与初始化 ────────────────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'boss_where',
      description:
        'Report where the engine, the personal data directory, the capability graph and the browser profile actually resolve to, plus whether initialization has been done. Read-only: does not touch the browser. Call this first in any session — before that, nothing else can be trusted to point at the right data.',
      parameters: {},
      ...common(20_000),
      async execute(_args, exec) {
        return (await flow(c, ['where'], exec, 20_000)) as unknown as Outcome;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'boss_init',
      description:
        'Lay down the personal data directory with empty capability-graph and profile templates (does not touch the browser). Safe to re-run: existing files are left alone unless force is set. Use migrate when the data still lives inside the package directory from an older layout.',
      parameters: {
        migrate: { type: 'boolean', description: 'Also copy capability-graph.json / profile.md / resume-raw.txt from the legacy in-package data/ directory into the user data directory.' },
        force: { type: 'boolean', description: 'Overwrite existing files instead of skipping them.' },
      },
      ...common(30_000),
      async execute(args, exec) {
        const argv: string[] = [];
        if (args.migrate) argv.push('--migrate');
        if (args.force) argv.push('--force');
        const node = resolveNode(c.config);
        return (await run(node.cmd, [INIT, ...argv], { ...c.env, ...node.env }, { timeoutMs: 30_000, signal: exec.signal })) as unknown as Outcome;
      },
    }),
  );

  // ── 浏览器 ──────────────────────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'boss_browser',
      description:
        'Check whether the debuggable browser is up, or start it. action=status probes the CDP endpoint and returns the browser version; action=launch starts a visible browser with the CDP port and the user profile, then waits until the port answers. Never kill the browser to "clean up" — it holds the user\'s login session.',
      parameters: {
        action: { type: 'string', required: true, description: 'status | launch' },
        url: { type: 'string', description: 'Start URL for launch. Defaults to https://www.zhipin.com/', },
      },
      ...common(45_000),
      async execute(args, exec) {
        const action = String(args.action);
        if (action === 'status') {
          const info = await probeCdp(c.endpoint);
          return {
            ok: info.reachable,
            exitCode: info.reachable ? 0 : 1,
            output: `${info.reachable ? 'OK' : 'FAIL'}  ${info.detail}`,
            error: info.reachable ? '' : 'FIX  浏览器没起或没开调试端口 —— 用 action=launch',
          } as unknown as Outcome;
        }
        if (action !== 'launch') {
          return { ok: false, exitCode: 1, output: '', error: `FIX  action 只认 status | launch，收到 "${action}"` } as unknown as Outcome;
        }

        const already = await probeCdp(c.endpoint);
        if (already.reachable) {
          return { ok: true, exitCode: 0, output: `OK  已经在跑，不重复启动\nKEY  ${already.detail}`, error: '' } as unknown as Outcome;
        }

        const browser = c.config.browserPath || discoverBrowser();
        if (!browser) {
          return {
            ok: false,
            exitCode: 1,
            output: '',
            error: 'FIX  没找到 Edge/Chrome —— 在插件配置里给 browserPath 一个绝对路径，或直接手起浏览器：\n' +
              `     msedge.exe --remote-debugging-port=${c.port} --user-data-dir="${c.profile}"`,
          } as unknown as Outcome;
        }

        mkdirSync(c.profile, { recursive: true });
        const url = String(args.url ?? 'https://www.zhipin.com/');
        const child = spawn(browser, browserArgs(c.port, c.profile, url), {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        child.unref();

        // 等端口应答再返回 —— 否则紧跟着的 boss_state 会连不上，表现为"随机失败"。
        const deadline = Date.now() + 40_000;
        let last = '';
        while (Date.now() < deadline) {
          if (exec.signal.aborted) return { ok: false, exitCode: -1, output: '', error: '调用被取消' } as unknown as Outcome;
          await sleep(1200);
          const info = await probeCdp(c.endpoint);
          if (info.reachable) {
            return {
              ok: true,
              exitCode: 0,
              output: `OK  已启动 ${browser}\nKEY  ${info.detail}\nKEY  profile=${c.profile}\nKEY  start=${url}`,
              error: '',
            } as unknown as Outcome;
          }
          last = info.detail;
        }
        return {
          ok: false,
          exitCode: 4,
          output: '',
          error: `浏览器起来了但 40s 内没应答调试端口：${last}\n` +
            'FIX  窗口**不要最小化**（最小化时元素尺寸为 0，坐标点击全部打空）；确认没有别的实例占用该 profile。',
        } as unknown as Outcome;
      },
    }),
  );

  // ── 状态机 ──────────────────────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'boss_state',
      description:
        'Read the current state and the login verdict: HOME / JOBS / CHAT / CHAT_FAIL / LOGIN. Run this as the first browser action of every session and after any failure — it decides whether the user needs to log in at all. It checks positively (is the user\'s name on the page, is there no login entry), so it will NOT report LOGIN for an already-logged-in session.',
      parameters: {},
      ...common(45_000),
      async execute(_args, exec) {
        return (await flow(c, ['state'], exec, 45_000)) as unknown as Outcome;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'boss_wait_login',
      description:
        'Block until the login page goes away, then report the new state. Only call this after boss_state has actually reported LOGIN — never "just in case", it wastes a whole turn.',
      parameters: {
        timeoutMs: { type: 'number', description: 'How long to wait, in ms. Default 300000 (5 minutes).' },
      },
      ...common(360_000),
      async execute(args, exec) {
        const ms = Number.isFinite(Number(args.timeoutMs)) && Number(args.timeoutMs) > 0 ? Number(args.timeoutMs) : 300_000;
        return (await flow(c, ['wait-login', '--timeout', String(ms)], exec, ms + 30_000)) as unknown as Outcome;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'boss_enter',
      description:
        'Go from HOME to the jobs page (clicks the 「职位」 entry in the top bar). Do not use the 「消息」 entry to reach the jobs page — that lands in the CHAT_FAIL state where no HR is selected and there is no input box.',
      parameters: {},
      ...common(45_000),
      async execute(_args, exec) {
        return (await flow(c, ['enter'], exec, 45_000)) as unknown as Outcome;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'boss_pick',
      description:
        'Switch the jobs list to one intent (the buttons such as 「C++（杭州）」). Pass label to select by text — that is the correct way, labels come from profile.md. Pass list=true to enumerate the available intent labels without clicking (diagnostics). Index selection exists but drifts as the list refreshes. This is the only supported way to reach the job list: the default recommendation feed does not refresh after you contact someone, so the same cards keep coming back.',
      parameters: {
        label: { type: 'string', description: 'Intent button text to select, e.g. the value recorded as 意向标签 in profile.md.' },
        index: { type: 'number', description: 'Zero-based index of the intent button. Fallback only — prefer label.' },
        list: { type: 'boolean', description: 'Enumerate the intent buttons instead of clicking any.' },
      },
      ...common(45_000),
      async execute(args, exec) {
        const argv = ['pick'];
        if (args.list) argv.push('--list');
        else if (typeof args.label === 'string' && args.label) argv.push('--label', args.label);
        else if (Number.isFinite(Number(args.index))) argv.push('--index', String(Number(args.index)));
        else return { ok: false, exitCode: 1, output: '', error: 'FIX  给 label（推荐）、index 或 list=true 三者之一' } as unknown as Outcome;
        return (await flow(c, argv, exec, 45_000)) as unknown as Outcome;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'boss_read',
      description:
        'Read the job description currently shown in the right-hand pane. The full text is on the JDJSON line of the output. Read before deciding anything, and re-read after every navigation — the pane follows the selected card.',
      parameters: {},
      ...common(30_000),
      async execute(_args, exec) {
        return (await flow(c, ['read'], exec, 30_000)) as unknown as Outcome;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'boss_next_card',
      description:
        'Select the next job card (event dispatch, stays on the same page) and move the description pane to it. Use this for every skip — one card at a time. Do not try to harvest the whole list up front: the list re-renders as you contact people.',
      parameters: {
        to: { type: 'number', description: 'Jump to the N-th card instead of the next one.' },
      },
      ...common(45_000),
      async execute(args, exec) {
        const argv = ['next-card'];
        if (Number.isFinite(Number(args.to))) argv.push('--to', String(Number(args.to)));
        return (await flow(c, argv, exec, 45_000)) as unknown as Outcome;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'boss_contact',
      description:
        'Click 「立即沟通」 on the job shown in the description pane and expect to land on the chat state. This only establishes the conversation and opens the chat page — it does not send anything, so it is safe to automate. If it reports CHAT_FAIL, do not try to repair it: go back with boss_recover.',
      parameters: {},
      ...common(45_000),
      async execute(_args, exec) {
        return (await flow(c, ['contact'], exec, 45_000)) as unknown as Outcome;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'boss_say',
      description:
        'Send the self-introduction to the HR in the currently open chat. With text: type it into the box and click send. Without text: send whatever is already in the box (recovery path). THIS IS THE ONLY IRREVERSIBLE ACTION IN THE WHOLE WORKFLOW — the message cannot be unsent. Never call it before boss_guard has returned exit code 0 on the exact same text. It confirms delivery two ways: the input box empties AND the text shows up among your own messages.',
      parameters: {
        text: { type: 'string', description: 'The self-introduction to send. Omit to send the existing draft.' },
      },
      ...common(120_000),
      async execute(args, exec) {
        const text = typeof args.text === 'string' ? args.text : '';
        const argv = text ? ['say', text] : ['send'];
        return (await flow(c, argv, exec, 120_000)) as unknown as Outcome;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'boss_back',
      description:
        'Go from the chat page back to the jobs page and re-select the intent. Always pass the label: a bare back lands on the default recommendation feed and loses the intent filter, which silently changes which jobs you are looking at.',
      parameters: {
        label: { type: 'string', description: 'Intent label to re-select on the way back (from profile.md). Strongly recommended.' },
      },
      ...common(60_000),
      async execute(args, exec) {
        const argv = ['back'];
        if (typeof args.label === 'string' && args.label) argv.push('--label', args.label);
        return (await flow(c, argv, exec, 60_000)) as unknown as Outcome;
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'boss_recover',
      description:
        'Failure-state exit: return to HOME so the state machine can be restarted. Use it for CHAT_FAIL and any other stuck state. Manual repairs (clicking an HR card to fix a chat with no input box, for example) are not supported and make things worse.',
      parameters: {},
      ...common(60_000),
      async execute(_args, exec) {
        return (await flow(c, ['recover'], exec, 60_000)) as unknown as Outcome;
      },
    }),
  );

  // ── 护栏 ────────────────────────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'boss_guard',
      description:
        'Run the copy gate over one self-introduction before it is sent. Checks length budget, forbidden numbers, fact provenance against the capability graph, the required JD terms, the declared main fact, blacklist phrases and the public homepage. Exit code 0 means the text is cleared to send; exit code 1 lists exactly which checks failed. Do not send anything that has not passed this.',
      parameters: {
        text: { type: 'string', required: true, description: 'The self-introduction to check.' },
        require: { type: 'string', required: true, description: 'The exact JD term this text is answering (e.g. the headline requirement). Must literally appear in the text.' },
        focus: { type: 'string', description: 'Id of the main fact from the capability graph that this text leads with.' },
        budget: { type: 'string', description: 'resume (default) or extra — use extra when the text cites a project that is not on the resume.' },
        offresume: { type: 'string', description: 'Id of a cited off-resume project. Comma-separate several. Each must carry its own link in the text.' },
      },
      ...common(30_000),
      async execute(args, exec) {
        const py = resolvePython(c.config);
        if (!py) {
          return {
            ok: false,
            exitCode: 2,
            output: '',
            error: 'FIX  没找到可用的 Python（护栏是 Python 实现）。装一个 Python 3，或在插件配置里给 pythonPath 一个绝对路径。',
          } as unknown as Outcome;
        }
        const argv = [GUARD, '--text', String(args.text), '--require', String(args.require)];
        if (typeof args.focus === 'string' && args.focus) argv.push('--focus', args.focus);
        if (typeof args.budget === 'string' && args.budget) argv.push('--budget', args.budget);
        if (typeof args.offresume === 'string' && args.offresume) {
          for (const id of args.offresume.split(',').map((s) => s.trim()).filter(Boolean)) argv.push('--offresume', id);
        }
        return (await run(py.cmd, [...py.args, ...argv], c.env, { timeoutMs: 30_000, signal: exec.signal })) as unknown as Outcome;
      },
    }),
  );
}
