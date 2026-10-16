#!/usr/bin/env node
/**
 * flow.mjs —— AutoIntroduce 状态机执行器
 *
 * 定位（DESIGN-SPEC §9）：**流程规格是固定不变的，写在 SKILL.md 里**；
 * 本文件只负责「确定性动作」——进页面、点击、读文本、填框。
 * 判断力部分（读描述、判断匹配、写文案）留给 Agent，本文件不做任何推理。
 *
 * 用法：
 *   node flow.mjs where                      # 不连浏览器：报告引擎/数据位置 + 是否已初始化
 *   node flow.mjs state                      # 当前状态 + 登录判定（每次开工第一件事）
 *   node flow.mjs wait-login [--timeout ms]  # 停在登录页等用户登录完（默认 5 分钟）
 *   node flow.mjs recover                    # 失败态出口：回 HOME 重新开始
 *   node flow.mjs enter                      # HOME → JOBS（点顶部「职位」）
 *   node flow.mjs pick --list                # JOBS：列出全部意向按钮（不点击）
 *   node flow.mjs pick --label "<意向标签>"   # JOBS：按文本选意向（推荐；下标会漂）
 *   node flow.mjs pick --index N             # JOBS：按下标选意向（备选，0 起）
 *   node flow.mjs read                       # JOBS：读右侧职位描述
 *   node flow.mjs next-card [--to N]        # JOBS：选下一张卡片；--to N 直接跳到第 N 张
 *   node flow.mjs contact                    # JOBS：点右侧「立即沟通」→ 应跳到 CHAT
 *   node flow.mjs say <文案>                  # CHAT：填进输入框**并点发送**（本轮正式路径）
 *   node flow.mjs send                       # CHAT：发送输入框里已有的内容（补发用）
 *   node flow.mjs fill <文案>                 # CHAT：只填不发送（预览/人工审文案时用）
 *   node flow.mjs back [--label "<意向标签>"]  # CHAT → JOBS；--label 顺带切回该意向
 *   node flow.mjs selftest                   # 自检：状态 + 关键元素 + 意向按钮清单
 *   node flow.mjs targets                    # 列出可接管的标签页（排查用）
 *
 * ⚠️ 意向标签是**每个人的配置**（例：「C++（杭州）」「机器学习（上海）」），
 *    写在用户数据目录的 profile.md 里，本文件不内置任何默认值 —— 每次从那里读出来传 --label。
 *
 * 一轮循环（每条 JD 一份文案）：
 *   state → [LOGIN：等用户登录 + wait-login]
 *   enter → pick --label "<意向标签>" → read → 判断
 *      ├ 不匹配 → next-card → read → …
 *      └ 匹配   → 写文案 → 过 guard.py → contact → say <文案>（填入即发送）
 *                 → back --label "<意向标签>" → read → 下一条
 *   ⚠️ 岗位必须从**意向筛选列表**取（pick --label），不要用默认推荐流：
 *      意向列表在点过「立即沟通」后会自行刷新、把已沟通的岗位移出；推荐流不变。
 *   ⚠️ back 会落回**默认推荐流**（意向筛选丢失），所以必须 back --label
 *      把意向点回来；这一步由执行器保证，别指望临场记得。
 *   ⚠️ 切回后列表已刷新（已沟通的岗位被移出、其余重排）⇒ 永远只看当前屏幕上这一张。
 *
 * 环境变量：
 *   CDP_ENDPOINT   默认 http://127.0.0.1:9222
 *   FLOW_TARGET    钉住 targetId（多标签时必须，否则会连到别的页）
 *   FLOW_GAP_MS    每次执行后的静默等待，默认 2000（红线，勿调小）
 *   AI_HOME        用户数据根目录，默认 $HOME/.auto-introduce（见 scripts/paths.mjs）
 *   AI_DATA_DIR    直接指定数据目录（覆盖 AI_HOME）
 *
 * 输出协议：OK / KEY k=v / DETAIL；失败 FAIL + FIX
 * 退出码：0 成功 / 1 状态不符或用法错 / 2 连不上浏览器 / 3 选不到页 / 4 动作失败
 *
 * 🔴 发送：文案**由本执行器点「发送」发出**（2026-10-16 用户授权）。
 *    代价是**不可撤回** —— 所以发出前必须已经过 guard.py（退出码 0），
 *    发出后本文件会核对「输入框清空 + 我方消息出现」两步，核对不过要人工看一眼。
 *    ⚠️ 只在 `say` / `send` 两条路径上点发送；`fill` 永远不点。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describePaths, graphPath, notInitializedHint } from './paths.mjs';

const ENDPOINT = (process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222').replace(/\/+$/, '');
const GAP_MS = Number(process.env.FLOW_GAP_MS ?? 2000);
const HERE = new URL('.', import.meta.url);
// ⚠️ 数据位置由 paths.mjs 统一解析（skill 目录只放引擎，个人数据在用户目录）。
const GRAPH_PATH = graphPath();

// ------------------------------------------------------------------ 输出

const out = (s) => console.log(s);
const ok = (s) => out(`OK  ${s}`);
const key = (k, v) => out(`KEY  ${k}=${v}`);
const detail = (s) => out(`DETAIL  ${s}`);

class FlowError extends Error {
  constructor(msg, fix, code = 4) {
    super(msg);
    this.fix = fix;
    this.code = code;
  }
}

function fail(msg, fix, code = 4) {
  throw new FlowError(msg, fix, code);
}

// ------------------------------------------------------------------ 风控节流
//
// 🔴 红线：每一次执行后都必须静默等待 ≥2 秒。
//   ① 点太快会被风控判定为机器人；② 界面常常还没加载完，紧接着的下一步会读到旧状态。
//   挂在 exit 钩子上 —— 所有退出路径（含报错提前退出）都必然生效，不靠自觉。

function hardSleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 环境不支持就算了，不能因此让命令失败 */
  }
}
process.on('exit', () => hardSleep(GAP_MS));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 参数

function argv(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : (process.argv[i + 1] ?? def);
}

/** 取一个非负整数参数。非法值一律当用法错拒绝，绝不让它变成 all[NaN]。 */
function intArg(name, def) {
  const raw = argv(name);
  if (raw === null || raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    fail(`参数非法：${name}=${raw}`, '该参数必须是非负整数', 1);
  }
  return n;
}

/** 取一个字符串参数；给了但后面没有值 ⇒ 用法错。 */
function strArg(name, def = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    fail(`参数缺值：${name}`, `用法：${name} <字符串>`, 1);
  }
  return v;
}

function tailArgs(fromCmd) {
  const i = process.argv.indexOf(fromCmd);
  return process.argv.slice(i + 1);
}

// ------------------------------------------------------------------ 能力图谱（只读）
//
// 图谱是唯一事实源。执行器只用它取「用户姓名」——登录态最可靠的正向信号。

let USER_NAME = null;
let GRAPH_MISSING = false;
try {
  const g = JSON.parse(readFileSync(GRAPH_PATH, 'utf8'));
  USER_NAME = g?.identity?.name ?? null;
} catch {
  /* 取不到就退化为「找登录入口」判据 */
  GRAPH_MISSING = true;
}

// ------------------------------------------------------------------ 选择器与 URL
//
// 选择器一律用 JSON.stringify 插进页面脚本 —— 属性值里该有引号就有引号，
// 不要为了「躲引号」把它们去掉（无引号的属性选择器是非法 CSS，
// querySelectorAll 会抛 SyntaxError，而失败表现只是「找不到元素」）。

const SEL = {
  jobsNav: 'a[href*="/web/geek/jobs"]',
  chatNav: 'a[href*="/web/geek/chat"]',
  expectItem: 'a.expect-item',
  card: 'li.job-card-box',
  cardWrap: '.job-card-wrap',
  jobName: 'a.job-name',
  chatInput: 'div.chat-input',
  // 「发送」按钮在 `.chat-op` 里。⚠️ 别用工具栏那个 `.btn-sendimg` —— 那是发图片的。
  sendBtn: '.chat-op button.btn-send',
  chatOp: '.chat-op',
  chatMine: 'li.message-item.item-myself',
  chatItem: 'li.message-item',
};

// 站点判据一律基于真实域名 zhipin.com（求职者侧 /web/geek/*）。
const HOST = 'www.zhipin.com';
const SCHEME = 'https';
const HOST_RE = 'zhipin\\.com';
const RX = {
  loginPage: /zhipin\.com\/web\/user/,
  chatPage: /zhipin\.com\/web\/geek\/chat/,
  jobsPage: /zhipin\.com\/web\/geek\/jobs/,
  appHome: /ka=header-home/,
};

const URLS = {
  home: () => `${SCHEME}://${HOST}/`,
  jobs: () => `${SCHEME}://${HOST}/web/geek/jobs`,
  chat: () => `${SCHEME}://${HOST}/web/geek/chat`,
};

/**
 * 由当前 URL 推出应用主页地址（/<城市>/?ka=header-home）。
 * ⚠️ 城市段必须排除路径段：`zhipin.com/web/geek/jobs` 的第一个路径段是 `web` 而不是城市，
 *    早期版本不排除，会拼出 `https://zhipin.com/web/?ka=header-home` 这种坏地址（实测踩到）。
 */
const NON_CITY_SEGMENTS = new Set(['web', 'wapi', 'api', 'job_detail', 'search', 'user']);
function appHomeUrl(u) {
  const seg = String(u ?? '').match(/zhipin\.com\/([a-z]+)\//i)?.[1] ?? '';
  const city = seg && !NON_CITY_SEGMENTS.has(seg.toLowerCase()) ? seg : '';
  return city
    ? `${SCHEME}://${HOST}/${city}/?ka=header-home`
    : `${SCHEME}://${HOST}/?ka=header-home`;
}

// ------------------------------------------------------------------ CDP 客户端
//
// 零第三方依赖：Node 内置 fetch 拿目标列表，内置 WebSocket 连调试端点。

let ws = null;
let msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function listTargets() {
  let res;
  try {
    res = await fetch(`${ENDPOINT}/json/list`);
  } catch {
    fail(`连不上浏览器调试端点：${ENDPOINT}`,
      '先用 tools/launch-edge.sh 起一个带 --remote-debugging-port 的可见浏览器；' +
      '若浏览器已开着，确认端口一致（CDP_ENDPOINT）', 2);
  }
  if (!res.ok) fail(`调试端点返回 ${res.status}`, '检查浏览器是否以 --remote-debugging-port 启动', 2);
  return res.json();
}

async function connect() {
  const targets = await listTargets();
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (pages.length === 0) {
    fail('没有任何可接管的标签页', '浏览器里至少留一个正常网页标签', 3);
  }

  let page = null;
  const pinned = process.env.FLOW_TARGET;
  if (pinned) {
    page = pages.find((t) => t.id === pinned) ?? null;
    if (!page) {
      fail(`钉住的 target 不在当前标签列表里：${pinned}`,
        `可用 target：${pages.map((t) => `${t.id} (${t.url.slice(0, 60)})`).join(' / ')}`, 3);
    }
  } else {
    page = pages.find((t) => new RegExp(HOST_RE).test(t.url ?? '')) ?? pages[0];
  }

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  }).catch((e) => fail(`连不上标签页 ${page.id}：${e.message}`, '重试；持续失败就重开浏览器（会丢登录态，尽量别）', 2));

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      else resolve(msg.result);
    }
  });

  key('target', page.id);
  key('url', page.url ?? '');
  return page;
}

/** 在页面里跑一段表达式，返回其值。expression 必须是自执行的 IIFE 或字面量。 */
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r?.exceptionDetails) {
    const d = r.exceptionDetails;
    const desc = d.exception?.description ?? d.text ?? '未知页面异常';
    fail(`页面脚本抛错：${String(desc).split('\n')[0]}`, '把这条错误发出来，它通常直接指出选择器或页面结构问题', 4);
  }
  return r?.result?.value;
}

async function mouseClick(x, y) {
  // 先移动再按下：真实鼠标一定会先经过 hover，有些按钮的 handler 依赖它
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

// ------------------------------------------------------------------ 页面侧工具
//
// 这些函数会被 JSON.stringify 后注入页面。保持纯函数、无外部依赖。

const PAGE_FN = {
  /** 找元素的可见矩形；顺手返回命中数与视口，失败时能分清「窗口不可见」与「元素不在」。 */
  rectOf: (sel, idx) => {
    const els = Array.from(document.querySelectorAll(sel));
    const el = els[idx];
    const vp = { w: window.innerWidth, h: window.innerHeight };
    if (!el) return { count: els.length, rect: null, viewport: vp, texts: els.slice(0, 6).map((e) => (e.innerText || '').trim().slice(0, 40)) };
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return {
      count: els.length,
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      viewport: vp,
      text: (el.innerText || '').trim().slice(0, 60),
    };
  },

  /** 登录态判据（两条正向信号）。 */
  loginProbe: (name) => {
    const bodyText = (document.body?.innerText || '');
    const nameVisible = !!name && bodyText.includes(name);
    const entrySels = ['a[href*="/web/user/"]', 'a[href*="/web/user"]', '.header-login', '[class*="header"][class*="login"]'];
    const entryCount = entrySels.reduce((n, s) => {
      try { return n + document.querySelectorAll(s).length; } catch { return n; }
    }, 0);
    return { nameVisible, loginEntry: entryCount > 0, url: location.href };
  },

  /** 聊天输入框是否存在。 */
  hasChatInput: () => {
    const el = document.querySelector('div.chat-input');
    return !!el && (el.isContentEditable || el.getAttribute('contenteditable') === 'true');
  },

  /**
   * 单个卡片是否「当前选中」。
   * ⚠️ 选中标记挂在**父级** `<div class="job-card-wrap active">` 上，
   *    不在 `li.job-card-box` 自己身上 —— 只看 li 会永远得到 activeIdx=-1（实测踩到：
   *    于是 next-card 以为"没选中"，去点第 0 张（正是当前那张），右侧纹丝不动）。
   */
  cardActive: (el) => el.classList.contains('active')
    || !!el.querySelector('.active')
    || !!(el.closest && el.closest('.job-card-wrap.active')),

  /** 左侧卡片列表：当前选中下标 + 各卡标题。 */
  cards: () => {
    const isActive = (el) => el.classList.contains('active')
      || !!el.querySelector('.active')
      || !!(el.closest && el.closest('.job-card-wrap.active'));
    const els = Array.from(document.querySelectorAll('li.job-card-box'));
    const activeIdx = els.findIndex(isActive);
    return {
      count: els.length,
      activeIdx,
      titles: els.map((e) => {
        const a = e.querySelector('a.job-name');
        return ((a && a.innerText) || e.innerText || '').trim().slice(0, 80);
      }),
    };
  },

  /**
   * 顶部**意向筛选**按钮（`a.expect-item`）：列出全部可选意向，并标出当前选中的那个。
   * 为什么需要它：列表页默认落在「推荐」流，推荐流里点完「立即沟通」列表**不会变**，
   * 卡片顺序也不会动；而意向筛选出来的列表会在沟通后自行刷新（已沟通的岗位被移出）。
   * 因此按意向取岗比在推荐流里翻卡片稳。用文本选（--label）比用下标选稳 —— 下标会漂。
   */
  expectItems: () => {
    const els = Array.from(document.querySelectorAll('a.expect-item'));
    const isActive = (el) => {
      if (el.classList.contains('active')) return true;
      let p = el.parentElement;
      for (let i = 0; i < 2 && p; i += 1, p = p.parentElement) {
        if (p.classList && p.classList.contains('active')) return true;
      }
      return false;
    };
    return {
      count: els.length,
      items: els.map((el, i) => {
        const r = el.getBoundingClientRect();
        return {
          i,
          text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
          active: isActive(el),
          visible: r.width > 2 && r.height > 2,
        };
      }),
    };
  },

  /** 右侧职位描述面板。 */
  panel: () => {
    const right = (el) => {
      const r = el.getBoundingClientRect();
      return r.left >= window.innerWidth * 0.45 && r.width > 80;
    };
    const clean = (s) => (s || '').replace(/\n{3,}/g, '\n\n').trim();
    // 薪资的数字位是 PUA 私用区字符：**0 = U+E031**，即 数字 = 码点 - 0xE031
    // （U+E031..U+E03A 对应 0..9）。不解码的话页面文本里薪资只剩「-K·薪」。
    // ⚠️ 这个偏移量踩过坑：写成 0xE030 会得到「41-66K·26薪」——同样"看起来合理"，
    //    但真值是「30-55K·15薪」。界面上核对一次再改，别凭"看着像"下结论。
    const decode = (s) => (s || '').replace(/[\uE031-\uE03A]/g, (c) => String(c.codePointAt(0) - 0xE031));

    // 策略 1：右侧那个「立即沟通」按钮，往上找含「职位描述 / 岗位职责」的最近容器
    const greets = Array.from(document.querySelectorAll('button, a, div, span'))
      .filter((e) => (e.innerText || '').trim() === '立即沟通' && right(e))
      .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
    for (const g of greets) {
      let p = g.parentElement;
      for (let i = 0; i < 12 && p; i += 1, p = p.parentElement) {
        const t = p.innerText || '';
        if ((t.includes('职位描述') || t.includes('岗位职责')) && t.length > 200) {
          const h = p.querySelector('h1, h2, h3, .job-name, [class*="title"]');
          return { strategy: 'greet-ancestor', title: (h && h.innerText || '').trim(), text: decode(clean(t)) };
        }
      }
    }

    // 策略 2：右半屏里文本最长、且含「职位描述」的元素
    let best = null;
    for (const el of Array.from(document.querySelectorAll('div, section, main'))) {
      if (!right(el)) continue;
      const t = el.innerText || '';
      if (!(t.includes('职位描述') || t.includes('岗位职责'))) continue;
      if (!best || t.length > best.text.length) best = { strategy: 'longest-right', title: '', text: decode(clean(t)) };
    }
    if (best) return best;

    // 策略 3：右半屏文本最长的元素（兜底，标题可能不叫「职位描述」）
    let any = null;
    for (const el of Array.from(document.querySelectorAll('div, section, main'))) {
      if (!right(el)) continue;
      const t = decode(clean(el.innerText || ''));
      if (t.length < 120) continue;
      if (!any || t.length > any.text.length) any = { strategy: 'longest-right-fallback', title: '', text: t };
    }
    return any ?? { strategy: 'none', title: '', text: '' };
  },

  /** 当前左侧选中卡的标题（用于判断内容是否真的刷新）。 */
  activeTitle: () => {
    const els = Array.from(document.querySelectorAll('li.job-card-box'));
    const isActive = (el) => el.classList.contains('active')
      || !!el.querySelector('.active')
      || !!(el.closest && el.closest('.job-card-wrap.active'));
    // 不兜底成 els[0]：认不出选中卡时要能被发现，而不是假装第 0 张就是当前卡
    const act = els.find(isActive);
    if (!act) return '';
    const a = act.querySelector('a.job-name');
    return ((a && a.innerText) || act.innerText || '').trim().slice(0, 80);
  },

  /** 派发 click（选卡片用：不走坐标，不会被 hover 浮层接走）。 */
  dispatchClick: (sel, idx) => {
    const els = Array.from(document.querySelectorAll(sel));
    const el = els[idx];
    if (!el) return { count: els.length, done: false };
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { count: els.length, done: true };
  },

  /** 哨兵：整页导航会把它冲掉 ⇒ 用来判断「刚才那一下有没有触发整页加载」。 */
  setSentinel: () => { window.__flowSentinel = String(Date.now()); return window.__flowSentinel; },
  getSentinel: () => window.__flowSentinel ?? null,

  /** 把文案写进聊天输入框（contenteditable）。先 execCommand，失败再降级直改 + 派发 input。 */
  fillInput: (text) => {
    const el = document.querySelector('div.chat-input');
    if (!el) return { ok: false, why: '找不到输入框 div.chat-input' };
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, text); } catch { /* 降级 */ }
    if (!inserted) {
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return { ok: true, readback: (el.innerText || '').trim() };
  },

  /** 读输入框当前文本（发送成功后应当变成空串，用它做发送确认）。 */
  inputText: () => {
    const el = document.querySelector('div.chat-input');
    return el ? (el.innerText || '').trim() : null;
  },

  /**
   * 找「发送」按钮并量真实坐标（真鼠标点击要用坐标）。
   * ⚠️ 认的是 `.chat-op button.btn-send`（文本「发送」）。
   *    工具栏里那个 `.btn-sendimg` 名字很像，但它是**发图片**的 —— 别点错。
   * ⚠️ 实测页面比视口宽（docScrollW 1224 > clientW 1095），发送按钮会**落在视口右边的外面**
   *    （按钮 rect.x 1112、视口宽 1110），照坐标硬点会点空。所以先 scrollIntoView，
   *    量完还必须检查 inViewport —— 不在视口里就报错让人把窗口拉宽，不要盲点。
   */
  sendBtnBox: () => {
    const btns = Array.from(document.querySelectorAll('.chat-op button.btn-send, button.btn-send'))
      .filter((b) => !/sendimg/i.test(b.className || ''))
      .filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      });
    if (!btns.length) return { count: 0 };
    const b = btns[0];
    b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = b.getBoundingClientRect();
    return {
      count: btns.length,
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      w: r.width,
      h: r.height,
      text: (b.innerText || '').trim(),
      cls: (b.className || '').toString(),
      disabled: b.disabled === true || /(^|\s)disabled(\s|$)/.test(b.className || ''),
      inViewport: r.left >= 0 && r.top >= 0
        && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  },

  /**
   * 读最近一条聊天消息。`mine=true` 只看我方（`li.message-item.item-myself`）。
   * 发送后用它二次确认「刚发的文案真的落到会话里了」。
   * ⚠️ 我方的 class 是 **item-myself**（不是 item-mine）—— 真机实测踩到过：
   *    写成 item-mine 会一个都选不中，于是明明发成功了却报「最后一条不是刚发的文案」。
   */
  lastMessage: (mine) => {
    const sel = mine ? 'li.message-item.item-myself' : 'li.message-item';
    const els = Array.from(document.querySelectorAll(sel));
    const el = els[els.length - 1];
    if (!el) return { count: els.length, text: null, status: null };
    const st = el.querySelector('.message-status');
    return {
      count: els.length,
      text: (el.innerText || '').trim(),
      // 我方消息带投递状态（.message-status.status-delivery ⇒ 文本「送达」）
      status: st ? (st.innerText || '').trim() : null,
    };
  },
};

async function pageFn(name, ...args) {
  const fn = PAGE_FN[name];
  const argStr = args.map((a) => JSON.stringify(a)).join(', ');
  return evaluate(`(${fn.toString()})(${argStr})`);
}

// ------------------------------------------------------------------ 状态判定

export const STATES = {
  LOGIN: 'LOGIN',
  HOME: 'HOME',
  JOBS: 'JOBS',
  CHAT: 'CHAT',
  CHAT_FAIL: 'CHAT_FAIL',
  OTHER: 'OTHER',
  /** 中间态：URL 在聊天页，但还要看有没有输入框才能定 CHAT / CHAT_FAIL */
  CHAT_OR_FAIL: 'CHAT_OR_FAIL',
};

/** 按 URL 查表（DESIGN-SPEC §8 状态机）。 */
function classifyByUrl(url) {
  const u = String(url ?? '');
  if (RX.loginPage.test(u)) return STATES.LOGIN;
  if (RX.chatPage.test(u)) return STATES.CHAT_OR_FAIL;
  if (RX.jobsPage.test(u)) return STATES.JOBS;
  if (/ka=header-home/.test(u)) return STATES.HOME;
  return STATES.OTHER;
}

/**
 * 登录判定 —— **纯函数**，抽出是为了让离线自检能覆盖（这一段曾被假阳性坑过）。
 *
 * 判据**逐条排除**（顺序即正确性）：
 *   ① 读得到用户姓名       ⇒ 已登录（最强正向信号）
 *   ② 人正处在登录页       ⇒ 未登录
 *      ⚠️ 关键：登录页上**本来就没有**「登录」入口按钮（入口就是这一页本身），
 *      所以绝不能拿「找不到登录入口」当已登录的证据 —— 实测踩到：
 *      `/web/user/?ka=header-login` + loginEntry=false 被判成已登录，白等一场。
 *   ③ 页面上找得到登录入口 ⇒ 未登录
 *   ④ 既无姓名也无登录入口 ⇒ 已登录
 *   probe 取不到（页面正在导航）⇒ 不猜，保持 URL 查表结果。
 */
export function decideLogin(byUrl, probe) {
  if (!probe) return { loggedIn: null, state: byUrl };

  let loggedIn;
  if (probe.nameVisible) loggedIn = true;
  else if (byUrl === STATES.LOGIN) loggedIn = false;
  else loggedIn = !probe.loginEntry;

  let state = byUrl;
  if (loggedIn === false) state = STATES.LOGIN;
  else if (byUrl === STATES.LOGIN) state = STATES.HOME; // 登录页上认出了用户名 ⇒ 已登录

  return { loggedIn, state };
}

/** 完整判定：先按 URL 查表，再过登录判据（见 decideLogin）。 */
async function refine() {
  const url = await evaluate('location.href');
  const byUrl = classifyByUrl(url);

  let probe = null;
  try {
    probe = await pageFn('loginProbe', USER_NAME);
  } catch {
    probe = null;
  }

  const decision = decideLogin(byUrl, probe);
  let state = decision.state;
  const loggedIn = decision.loggedIn;

  if (byUrl === STATES.CHAT_OR_FAIL) {
    const hasInput = await pageFn('hasChatInput');
    state = loggedIn === false ? STATES.LOGIN : (hasInput ? STATES.CHAT : STATES.CHAT_FAIL);
  }

  return { state, url, loggedIn, probe };
}

/** 等一个条件成立（等状态收敛，不等固定毫秒）。 */
async function waitFor(fn, timeoutMs, intervalMs = 400) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (last) return { value: last, waited: Date.now() - t0 };
    await sleep(intervalMs);
  }
  return { value: last ?? null, waited: Date.now() - t0, timedOut: true };
}

/** 点一个元素：真实鼠标点击（isTrusted，SPA 才会接管）。 */
async function clickSelector(sel, idx = 0, what = sel) {
  const info = await pageFn('rectOf', sel, idx);
  if (!info.count) {
    fail(`找不到元素：${what}`,
      `选择器命中 0 个。视口 ${info.viewport?.w}x${info.viewport?.h}。` +
      '页面结构可能变了，把当前页面结构发出来核对选择器', 4);
  }
  if (!info.rect || info.rect.w < 2 || info.rect.h < 2) {
    fail(`元素不可见（尺寸为 0）：${what}`,
      `命中 ${info.count} 个但宽高为 0 —— 通常是**窗口被最小化**了。` +
      `恢复窗口（当前视口 ${info.viewport?.w}x${info.viewport?.h}）后重试`, 4);
  }
  const x = Math.round(info.rect.x + info.rect.w / 2);
  const y = Math.round(info.rect.y + info.rect.h / 2);
  await mouseClick(x, y);
  return info;
}

/**
 * 切到某个意向的岗位列表。抽出来共用，因为 `pick` 和 `back --label` 都要走同一套。
 *
 * 选目标：`index` 优先；其次 `label` 文本匹配（双向包含，容忍半/全角括号）；
 * 都没有才落到第 0 个 —— 下标会随列表刷新漂移，能写 label 就别写 index。
 * 已经是当前选中项时**不重复点击**：重复点会把列表重置回第一张。
 *
 * 为什么要抽出来：实测 `back` 从聊天页回列表时会落回**默认推荐流**（意向筛选丢失），
 * 所以「回列表」和「切回意向」必须连在一起做 —— 靠调用方记得补一步，迟早会漏。
 */
async function pickExpect({ index = null, label = null } = {}) {
  const waited = await waitFor(async () => {
    const it = await pageFn('expectItems');
    return it.count ? it : null;
  }, 12000);
  if (waited.timedOut) {
    fail('页面上找不到意向按钮（a.expect-item）',
      '确认已在职位列表页；若页面结构变了，把当前页面结构发出来核对选择器', 4);
  }
  const list = waited.value;

  let target = index;
  if (target === null && label) {
    const hit = list.items.find((it) => it.text.includes(label))
      ?? list.items.find((it) => label.includes(it.text));
    if (!hit) {
      fail(`没有匹配「${label}」的意向按钮`,
        `当前可选项：${list.items.map((it) => it.text).join(' / ')}`, 4);
    }
    target = hit.i;
  }
  if (target === null) target = 0;
  if (target >= list.count) {
    fail(`意向下标越界：${target}`,
      `当前只有 ${list.count} 个意向：${list.items.map((it) => it.text).join(' / ')}`, 1);
  }

  const chosen = list.items[target];
  key('picked_index', target);
  key('picked_label', chosen.text);

  if (chosen.active) {
    detail('该意向已是当前选中项 —— 不重复点击（重复点会把列表重置回首卡）');
    key('first_card', await pageFn('activeTitle'));
    key('cards', (await pageFn('cards')).count);
    return { index: target, label: chosen.text, clicked: false };
  }

  const before = await pageFn('activeTitle');
  const beforeCards = await pageFn('cards');

  await clickSelector(SEL.expectItem, target, `意向按钮「${chosen.text}」`);

  // 点完意向按钮 URL 可能不变 ⇒ 用「首卡是否刷新」判断是否生效
  const changed = await waitFor(async () => {
    const t = await pageFn('activeTitle');
    return t && t !== before ? t : null;
  }, 12000);
  const after = await pageFn('cards');

  key('first_card', changed.value ?? before);
  key('cards', after.count);
  if (changed.timedOut) {
    detail('首卡标题未变化（可能该意向下列表本就相同）；仍按已选中处理');
  } else {
    detail(`列表已刷新：${beforeCards.count} 张卡 → ${after.count} 张卡`);
  }
  return { index: target, label: chosen.text, clicked: true };
}

// ------------------------------------------------------------------ 子命令

const COMMANDS = {};

/**
 * where —— 不连浏览器，只报告「引擎在哪 / 我的数据在哪 / 初始化了没有」。
 * 新用户的第一条命令：连不上浏览器时也该能先确认数据位置对不对。
 */
COMMANDS.where = async () => {
  describePaths(out);
  ok('路径解析完成（不连浏览器）');
};

COMMANDS.targets = async () => {
  const ts = await listTargets();
  for (const t of ts) {
    out(`${t.type}\t${t.id}\t${(t.url ?? '').slice(0, 90)}`);
  }
  ok(`共 ${ts.length} 个 target`);
};

COMMANDS.state = async () => {
  if (GRAPH_MISSING) detail(notInitializedHint());
  await connect();
  const r = await refine();
  key('state', r.state);
  key('url', r.url);
  if (r.probe) {
    key('name_visible', r.probe.nameVisible);
    key('login_entry', r.probe.loginEntry);
  }
  key('logged_in', r.loggedIn === null ? 'unknown' : r.loggedIn);
  detail(r.state === STATES.LOGIN
    ? '未登录 —— 停下让用户登录，然后 wait-login'
    : `已登录（判据：${r.probe?.nameVisible ? '页面读到姓名' : '页面无登录入口'}）—— 直接继续走状态机`);
  ok(`当前状态 ${r.state}`);
};

COMMANDS['wait-login'] = async () => {
  const timeout = intArg('--timeout', 5 * 60 * 1000);
  await connect();
  const first = await refine();
  if (first.state !== STATES.LOGIN) {
    key('state', first.state);
    ok('已经不在登录页了，无需等待');
    return;
  }
  detail('等待用户登录……（登录完成后会自动继续）');
  const { value, timedOut } = await waitFor(async () => {
    const r = await refine();
    return r.state !== STATES.LOGIN ? r : null;
  }, timeout, 1500);
  if (timedOut) {
    fail('等待登录超时', '确认用户已在本浏览器完成登录后重试', 1);
  }
  key('state', value.state);
  ok('登录完成');
};

COMMANDS.recover = async () => {
  await connect();
  // 应用主页＝页面里「首页」链接指向的地址（自带城市段）。从这里取比按 URL 猜城市可靠。
  const fromDom = await evaluate(`(() => {
    const a = Array.from(document.querySelectorAll('a[href*="ka=header-home"]'))[0];
    return a ? a.href : null;
  })()`);
  const url = await evaluate('location.href');
  const target = fromDom || appHomeUrl(url);
  await send('Page.navigate', { url: target });
  const { timedOut } = await waitFor(async () => {
    const u = await evaluate('location.href');
    return /ka=header-home/.test(u) ? u : null;
  }, 15000);
  if (timedOut) {
    fail('回 HOME 超时', '手动在浏览器里打开 Boss 直聘主页后重试', 4);
  }
  key('url', target);
  ok('已回 HOME，重新开始');
};

COMMANDS.enter = async () => {
  await connect();
  let r = await refine();

  if (r.state === STATES.LOGIN) {
    fail('当前在登录页', '先让用户登录，再用 wait-login 接上', 1);
  }
  if (r.state === STATES.JOBS) {
    ok('已经在 JOBS，无需 enter');
    return;
  }
  if (r.state === STATES.CHAT || r.state === STATES.CHAT_FAIL) {
    fail('当前在聊天页', '失败态不许就地修补：先 recover 回 HOME 再开始', 1);
  }

  // 先确保落在**应用主页**（带 ka=header-home）—— 在这里点「职位」才是 SPA 路由
  let url = await evaluate('location.href');
  if (!/ka=header-home/.test(url)) {
    const target = appHomeUrl(url);
    await send('Page.navigate', { url: target });
    const nav = await waitFor(async () => {
      const u = await evaluate('location.href');
      return /ka=header-home/.test(u) ? u : null;
    }, 15000);
    if (nav.timedOut) fail('进入应用主页超时', '手动打开 Boss 直聘主页后重试', 4);
    url = nav.value;
  }

  const before = await pageFn('setSentinel');
  const info = await clickSelector(SEL.jobsNav, 0, '顶部「职位」');

  const landed = await waitFor(async () => {
    const u = await evaluate('location.href');
    return RX.jobsPage.test(u) ? u : null;
  }, 15000);
  if (landed.timedOut) {
    const after = await pageFn('getSentinel');
    fail('点了「职位」但没有进入 JOBS',
      after === before
        ? '页面没有发生整页导航，SPA 也没接住 —— 把当前页面结构发出来核对选择器'
        : '发生了整页导航（哨兵被冲掉）—— 说明落点不是应用主页，重试 enter', 4);
  }
  key('url', landed.value);
  detail(`命中「职位」导航（共 ${info.count} 个匹配）`);
  ok('已进入 JOBS');
};

COMMANDS.pick = async () => {
  // 先校验参数，再连浏览器 —— 否则用法错会被「连不上浏览器」掩盖，报错与真因无关
  const idx = intArg('--index', null);
  const label = strArg('--label', null);
  const listOnly = process.argv.includes('--list');
  await connect();
  const r = await refine();
  if (r.state !== STATES.JOBS) fail(`当前状态是 ${r.state}，不是 JOBS`, '先 enter 进入职位列表', 1);

  if (listOnly) {
    const items = await pageFn('expectItems');
    if (!items.count) {
      fail('页面上找不到意向按钮（a.expect-item）',
        '确认已在职位列表页；若页面结构变了，把当前页面结构发出来核对选择器', 4);
    }
    for (const it of items.items) out(`${it.i}\t${it.active ? '*' : ' '}\t${it.text}`);
    key('count', items.count);
    ok('以上是当前意向按钮（* = 当前选中）');
    return;
  }

  const res = await pickExpect({ index: idx, label });
  ok(res.clicked ? '已切到该意向的岗位列表' : '意向就位');
};

COMMANDS.read = async () => {
  await connect();
  const r = await refine();
  if (r.state !== STATES.JOBS) fail(`当前状态是 ${r.state}，不是 JOBS`, '先 enter 进入职位列表', 1);

  const panel = await pageFn('panel');
  if (!panel || !panel.text) {
    fail('读不到右侧职位描述',
      '右侧面板为空。可能是页面还在加载（等两秒重试），或面板结构变了', 4);
  }
  const cards = await pageFn('cards');
  key('job', panel.title || cards.titles[cards.activeIdx] || '');
  key('active_card', cards.activeIdx);
  key('cards', cards.count);
  key('chars', panel.text.length);
  out(`JDJSON ${JSON.stringify(panel.text)}`);
  ok('已读取右侧职位描述');
};

COMMANDS['next-card'] = async () => {
  await connect();
  const r = await refine();
  if (r.state !== STATES.JOBS) fail(`当前状态是 ${r.state}，不是 JOBS`, '先 enter 进入职位列表', 1);

  const before = await pageFn('activeTitle');
  const cards = await pageFn('cards');
  if (cards.count === 0) fail('左侧没有任何岗位卡片', '先 pick 一个意向按钮把列表刷出来', 4);

  const from = cards.activeIdx >= 0 ? cards.activeIdx : -1;
  // --to N 直接跳到第 N 张（确定性动作）。为什么需要它：实测 `back` 从聊天页回列表时，
  // 卡片选中会被**复位到第 0 张**（不是"保留上一轮选中"），只靠 +1 前进会重复投递前面已投的岗位。
  const toArg = intArg('--to', null);
  const to = toArg === null ? (from + 1) % cards.count : ((toArg % cards.count) + cards.count) % cards.count;

  // 选卡片用事件派发：不走坐标，不会命中 hover 浮层，也不会点到标题链接
  const disp = await pageFn('dispatchClick', SEL.card, to);
  if (!disp.done) fail(`选不中第 ${to} 张卡片`, `共 ${disp.count} 张卡`, 4);

  const changed = await waitFor(async () => {
    const t = await pageFn('activeTitle');
    return t && t !== before ? t : null;
  }, 12000);
  if (changed.timedOut) {
    fail('右侧描述没有切换',
      `点了第 ${to} 张卡但右侧标题未变（仍是「${before}」）。` +
      '若到底了，说明这个意向下没有更多卡片 —— 换意向或结束本轮', 4);
  }
  key('from', from);
  key('to', to);
  key('job', changed.value);
  ok('已选下一张卡片');
};

COMMANDS.contact = async () => {
  await connect();
  const r = await refine();
  if (r.state !== STATES.JOBS) fail(`当前状态是 ${r.state}，不是 JOBS`, '先 enter 进入职位列表', 1);

  const before = await pageFn('setSentinel');

  // 「立即沟通」必须点在**右侧描述面板内** —— 点卡片 hover 浮层里那个，
  // 会真实建立到另一个岗位的沟通。
  const greet = await evaluate(`(() => {
    const els = Array.from(document.querySelectorAll('button, a, div, span'))
      .filter((e) => (e.innerText || '').trim() === '\\u7acb\\u5373\\u6c9f\\u901a')
      .filter((e) => {
        const r = e.getBoundingClientRect();
        return r.left >= window.innerWidth * 0.45 && r.width > 2 && r.height > 2;
      })
      .sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
    if (!els.length) return { count: 0 };
    const r = els[0].getBoundingClientRect();
    return { count: els.length, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);

  if (!greet.count) {
    fail('右侧描述面板里找不到「立即沟通」',
      '确认右侧有职位描述；若这是最后一个卡片或岗位已沟通过，按钮文案可能不同', 4);
  }
  await mouseClick(Math.round(greet.x), Math.round(greet.y));

  const landed = await waitFor(async () => {
    const u = await evaluate('location.href');
    return RX.chatPage.test(u) ? u : null;
  }, 15000);

  // ⚠️ URL 落到 /web/geek/chat ≠ 面板已经渲染好。
  //    立刻查输入框会把自己的慢渲染误报成 CHAT_FAIL（实测踩到：contact 报 CHAT_FAIL，
  //    紧接着 state 又是 CHAT）。所以这里要**等输入框真的出现**，等不到才判失败态。
  const ready = await waitFor(async () => {
    const has = await pageFn('hasChatInput');
    return has ? true : null;
  }, 12000);

  if (!ready.timedOut) {
    key('state', STATES.CHAT);
    ok('已进入聊天页，HR 默认已选中 —— 接下来 say <文案>（填入即发送）');
    return;
  }

  const after = await refine();
  if (after.state === STATES.CHAT_FAIL) {
    fail('落到了没有输入框的聊天页（CHAT_FAIL）',
      '失败态不许就地修补：recover 回 HOME 重新开始', 4);
  }
  const sentinel = await pageFn('getSentinel');
  fail('点了「立即沟通」但没有进入聊天页',
    sentinel === before ? '页面没有跳转 —— 把当前页面发出来核对' : '发生了整页导航，重试', 4);
};

/** 把文案写进聊天输入框（fill / say 共用的唯一实现）。 */
async function fillInto(text) {
  const r = await refine();
  if (r.state !== STATES.CHAT) {
    fail(`当前状态是 ${r.state}，不是 CHAT`, '先 contact 进入聊天页；CHAT_FAIL 要 recover 回 HOME 重来', 1);
  }
  const res = await pageFn('fillInput', text);
  if (!res.ok) fail(res.why, '确认已进入聊天页且右侧有输入框', 4);
  if (res.readback !== text) {
    fail('填入内容与目标文案不一致',
      `读回 ${res.readback.length} 字，目标 ${text.length} 字 —— 输入框可能被插件改写，改用 fill 重试或手动粘贴`, 4);
  }
  key('chars', res.readback.length);
}

/**
 * 点「发送」并确认真的发出去了。**这是全流程唯一不可撤回的动作。**
 * 三道核对：按钮可见可点 → 点击后输入框清空 → 我方最后一条消息就是这段文案。
 */
async function sendCurrent(expect) {
  // ⚠️ 刚 fill 完的**一瞬间**按钮还挂着 disabled 类（编辑器的内容状态是异步同步的），
  //    实测立刻探测会读到 disabled 而误报「按钮禁用 ⇒ 输入框是空的」。
  //    所以这里等它变可点（几秒内必然恢复），等不到才判失败。
  const box = await waitFor(async () => {
    const b = await pageFn('sendBtnBox');
    return (b.count && !b.disabled) ? b : null;
  }, 6000);
  if (box.timedOut) {
    const b = await pageFn('sendBtnBox');
    if (!b.count) {
      fail('找不到「发送」按钮',
        '确认已选中 HR 且右侧有输入框（`.chat-op button.btn-send`）；工具栏里的 .btn-sendimg 是发图片的，不是它', 4);
    }
    fail('「发送」按钮一直是禁用态（等了 6 秒）',
      '输入框可能是空的、或站点没识别到内容 —— `state` 看一眼，必要时手动发这一条', 4);
  }
  const btn = box.value;
  if (!btn.inViewport) {
    fail(`「发送」按钮不在视口内（按钮中心 ${Math.round(btn.x)},${Math.round(btn.y)}，视口 ${btn.viewport.w}×${btn.viewport.h}）`,
      '页面比窗口宽、按钮被挤出右边 —— 把浏览器窗口拉宽再重试，或手动点一次发送', 4);
  }
  key('send_btn', `${Math.round(btn.x)},${Math.round(btn.y)} ${Math.round(btn.w)}x${Math.round(btn.h)}`);

  await mouseClick(Math.round(btn.x), Math.round(btn.y));

  // ① 输入框被清空 = 发出的第一信号
  const cleared = await waitFor(async () => (((await pageFn('inputText')) === '') ? true : null), 8000);
  if (cleared.timedOut) {
    const left = await pageFn('inputText');
    fail(`点了发送但输入框没清空（仍有 ${(left || '').length} 字）`,
      '大概率是没点中（浮层/视口外）或站点限流 —— `state` 看一眼，必要时手动发这一条', 4);
  }

  // ② 我方最后一条消息应当就是刚写的文案（去空白后比前缀，容忍气泡里的「已读/送达」之类尾巴）
  const mine = await pageFn('lastMessage', true);
  const norm = (s) => (s || '').replace(/\s+/g, '');
  const head = norm(expect).slice(0, 10);
  let landed = !!head && norm(mine.text).includes(head);
  if (!landed && head) {
    // 兜底：万一我方条目的 class 变了，别又误报一次（真机踩过 item-mine vs item-myself）。
    const all = await pageFn('lastMessage', false);
    landed = norm(all.text).includes(head);
    detail(landed
      ? '⚠️ 在全部消息里找到了刚发的文案，但「我方消息」选择器没命中 —— 类名可能变了，去核对 item-myself'
      : `我方最后一条读回：${(mine.text || '(空)').slice(0, 40)}`);
  }
  if (!landed) {
    fail('输入框空了，但聊天记录里找不到刚发的文案',
      '去界面里核对一眼；若确实已发出（输入框清空基本就代表发出）可当作成功继续', 4);
  }

  key('sent_chars', expect.length);
  key('mine_messages', mine.count);
  if (mine.status) key('mine_status', mine.status);
  ok('已发送（输入框已清空 + 文案已出现在聊天记录里）');
}

COMMANDS.fill = async () => {
  await connect();
  const text = tailArgs('fill').join(' ').trim();
  if (!text) fail('没有要填的文案', '用法：node flow.mjs fill <文案>', 1);
  await fillInto(text);
  detail('⚠️ 只填未发（预览用）—— 正式投递请用 say <文案>');
  ok('已填入输入框（未发送）');
};
/**
 * 填入 + 发送 —— 本轮循环的正式路径。文案一旦发出不可撤回，所以三道闸：
 * ① 调用方必须先跑 guard.py 且退出码 0；② 发送前核对输入框读回内容与文案一致（fillInto 里做）；
 * ③ 发送后核对「输入框已清空」+「我方最后一条就是这段文案」，两步都过才报 OK。
 */
COMMANDS.say = async () => {
  await connect();
  const text = tailArgs('say').join(' ').trim();
  if (!text) fail('没有要发的文案', '用法：node flow.mjs say <文案>', 1);
  await fillInto(text);
  await sendCurrent(text);
};

/** 只发送输入框里已有的内容（补发/重发场景）。 */
COMMANDS.send = async () => {
  await connect();
  const r = await refine();
  if (r.state !== STATES.CHAT) {
    fail(`当前状态是 ${r.state}，不是 CHAT`, '先 contact 进入聊天页；CHAT_FAIL 要 recover 回 HOME 重来', 1);
  }
  const text = await pageFn('inputText');
  if (!text) fail('输入框是空的，没有可发送的内容', '先用 fill <文案> 或 say <文案>', 1);
  key('chars', text.length);
  await sendCurrent(text);
};

COMMANDS.back = async () => {
  const label = strArg('--label', null);
  await connect();
  const r = await refine();
  if (r.state !== STATES.CHAT && r.state !== STATES.CHAT_FAIL) {
    fail(`当前状态是 ${r.state}，不是 CHAT`, '只有聊天页需要 back', 1);
  }
  await evaluate('history.back()');
  const landed = await waitFor(async () => {
    const u = await evaluate('location.href');
    return RX.jobsPage.test(u) ? u : null;
  }, 15000);
  if (landed.timedOut) fail('后退没有回到 JOBS', '手动点顶部「职位」回到列表', 4);
  key('url', landed.value);

  // 🔴 实测：后退会落回**默认推荐流**，意向筛选（如「C++（杭州）」）会丢。
  //    所以带 --label 时直接把意向点回来 —— 这一步必须由执行器保证，
  //    不能指望调用方每轮都记得补（漏一次就会在推荐流里取岗，重复处理同一批卡片）。
  if (label) {
    const picked = await pickExpect({ label });
    key('repicked_index', picked.index);
    key('repicked_label', picked.label);
    ok('已回 JOBS 并自动切回意向 —— 当前卡就是刷新后的第一条');
    return;
  }

  detail('⚠️ back 会落回默认推荐流（意向筛选丢失）—— 取岗前必须重新 pick --label');
  ok('已回 JOBS');
};

COMMANDS.selftest = async () => {
  await connect();
  const r = await refine();
  key('state', r.state);
  key('url', r.url);

  const cards = r.state === STATES.JOBS ? await pageFn('cards') : { count: -1, activeIdx: -1, titles: [] };
  const expects = r.state === STATES.JOBS
    ? await evaluate(`Array.from(document.querySelectorAll('a.expect-item')).map(e => (e.innerText||'').trim())`)
    : [];
  const chatInput = await pageFn('hasChatInput');
  // 聊天页额外探一次发送按钮：坐标 / 是否可见 / 是否禁用 —— 发送前的必要信息，
  // 也顺手把「视口太窄导致按钮被挤出屏幕」这个坑提前暴露出来。
  const sendBox = chatInput ? await pageFn('sendBtnBox') : null;

  key('cards', cards.count);
  key('active_card', cards.activeIdx);
  key('expect_items', JSON.stringify(expects));
  key('chat_input', chatInput);
  if (sendBox) {
    key('send_btn_count', sendBox.count);
    if (sendBox.count) {
      key('send_btn_xy', `${Math.round(sendBox.x)},${Math.round(sendBox.y)}`);
      key('send_btn_in_viewport', sendBox.inViewport);
      key('send_btn_disabled', sendBox.disabled);
      key('chat_draft_chars', (await pageFn('inputText') || '').length);
    }
  }
  key('user_name_known', USER_NAME ?? '(未知，退化为登录入口判据)');
  detail(`意向按钮：${expects.length ? expects.join(' / ') : '（当前页面没有）'}`);
  ok('自检完成');
};

// ------------------------------------------------------------------ 入口

async function main() {
  const cmd = process.argv[2];
  if (!cmd || !COMMANDS[cmd]) {
    out('用法：node flow.mjs <命令> [参数]');
    out('');
    out('命令：');
    out('  where                     报告「引擎/数据/初始化」位置（不连浏览器）');
    out('  state                     当前状态 + 登录判定（每次开工第一件事）');
    out('  wait-login [--timeout ms] 停在登录页等用户登录完');
    out('  recover                   失败态出口：回 HOME');
    out('  enter                     HOME → JOBS');
    out('  pick --list               列出全部意向按钮（不点击）');
    out('  pick --label "<意向标签>"  按文本选意向（推荐；标签取自 profile.md）');
    out('  pick --index N            按下标选意向（备选，0 起）');
    out('  read                      读右侧职位描述');
    out('  next-card [--to N]        选下一张卡片；--to N 跳到第 N 张');
    out('  contact                   点「立即沟通」→ 聊天页');
    out('  say <文案>                 填进输入框并**点发送**（正式路径，发出不可撤回）');
    out('  send                      发送输入框里已有的内容（补发用）');
    out('  fill <文案>                只填不发送（预览/人工审文案时用）');
    out('  back [--label "<意向标签>"] CHAT → JOBS；--label 顺带切回该意向');
    out('  selftest                  自检状态与关键元素');
    out('  targets                   列出可接管的标签页');
    process.exit(cmd ? 1 : 0);
  }

  try {
    await COMMANDS[cmd]();
    process.exit(0);
  } catch (e) {
    if (e instanceof FlowError) {
      out(`FAIL  ${e.message}`);
      if (e.fix) out(`FIX  ${e.fix}`);
      process.exit(e.code);
    }
    out(`FAIL  未预期的错误：${e?.message ?? e}`);
    out('FIX  把完整输出发出来排查');
    process.exit(4);
  }
}

// 只有「被直接执行」时才跑 main —— 被 import（离线自检）时只取纯函数
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
