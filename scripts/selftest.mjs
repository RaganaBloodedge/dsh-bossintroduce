#!/usr/bin/env node
/**
 * selftest.mjs —— AutoIntroduce 离线自检（不需要浏览器）
 *
 * 为什么有它：本项目绝大部分逻辑**不依赖浏览器** —— 参数校验、状态查表、数字闸门、
 * 图谱结构、文档与代码的一致性。这些本来就能离线证明，却长期没测试，于是同一个 bug 被反复踩。
 * **先跑它，再上真机**；真机只用来证明「选择器还认不认这个页面」这一件事。
 *
 * 用法：
 *   node scripts/selftest.mjs [--verbose]
 *
 * 退出码：0 全绿 / 1 有失败
 *
 * ⚠️ 它**证明不了页面选择器在真实 Boss 页面上仍然有效** —— 改过选择器之后仍需真机验证。
 * ⚠️ 面向多用户：**没有个人数据也必须全绿**（图谱相关的断言只在图谱存在时才跑）。
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SKILL_ROOT, dataDir, graphPath } from './paths.mjs';

// 别让 flow.mjs 的 exit 钩子在本进程里睡那 2 秒
process.env.FLOW_GAP_MS = process.env.FLOW_GAP_MS ?? '0';

const ROOT = SKILL_ROOT;
const VERBOSE = process.argv.includes('--verbose');

/**
 * 「引擎」= 随包发布的东西。
 *
 * 仓库根还有 README / LICENSE / package.json / .gitignore —— 那些是**仓库元信息**，
 * 不是引擎：LICENSE 本来就该署真名，README 与 package.json 本来就该带仓库地址。
 * 所以下面所有「引擎里不许出现个人信息」的扫描都只走这份清单，而不是整个 ROOT，
 * 否则 LICENSE 里的作者名会把检查器自己逼成永远红。
 */
const ENGINE_ENTRIES = [
  'SKILL.md', 'scripts', 'references', 'assets', 'src', 'dist',
  'cordis.patch.yml', 'cordis.example.yml',
];

/** 收齐引擎里的全部文件（跳过二进制），给「不含个人信息」那几条用。 */
function engineFiles() {
  const files = [];
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const q = join(p, e.name);
      if (e.isDirectory()) walk(q);
      else if (!/\.(png|jpg|ico|pdf|zip)$/i.test(e.name)) files.push(q);
    }
  };
  for (const rel of ENGINE_ENTRIES) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
  return files;
}

const FLOW = join(ROOT, 'scripts', 'flow.mjs');
const GUARD = join(ROOT, 'scripts', 'guard.py');
const INIT = join(ROOT, 'scripts', 'init.mjs');
const PACK = join(ROOT, 'scripts', 'pack.mjs');

let pass = 0;
const failures = [];

function ok(name, detail = '') {
  pass += 1;
  if (VERBOSE) console.log(`  [PASS] ${name}${detail ? '  ' + detail : ''}`);
}
function bad(name, detail = '') {
  failures.push(`${name}${detail ? '  ' + detail : ''}`);
  console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`);
}
function assert(name, cond, detail = '') {
  cond ? ok(name, detail) : bad(name, detail);
}
function skip(name, why) {
  pass += 1;
  console.log(`  [SKIP] ${name}  ${why}`);
}
/** 只打一行说明，不参与通过/失败计数（用于「这条不判红，但你该知道」的情形）。 */
function detail(msg) {
  console.log(`  [INFO] ${msg}`);
}

/** 跑一个子进程，默认把 FLOW_GAP_MS 关掉（测试里不需要那 2 秒风控等待）。 */
function run(bin, args, { env = {}, timeout = 60000, cwd = undefined } = {}) {
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout,
    cwd,
    env: { ...process.env, FLOW_GAP_MS: '0', ...env },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function pickPython() {
  for (const bin of ['python', 'python3']) {
    const r = spawnSync(bin, ['-c', 'print(1)'], { encoding: 'utf8' });
    if (r.status === 0) return bin;
  }
  return null;
}

console.log('='.repeat(68));
console.log('AutoIntroduce 离线自检');
console.log('='.repeat(68));

// ---------------------------------------------------------------- A. 文件布局
console.log('\n[ A ] 交付文件布局（引擎，不含个人数据）');
const required = [
  'SKILL.md',
  'scripts/flow.mjs',
  'scripts/guard.py',
  'scripts/paths.mjs',
  'scripts/init.mjs',
  'scripts/pack.mjs',
  'scripts/launch-edge.sh',
  'assets/capability-graph.template.json',
  'assets/profile.template.md',
  'references/01-能力图谱.md',
  'references/02-文案与护栏.md',
  'references/03-界面事实与环境.md',
];
for (const rel of required) {
  assert(`存在 ${rel}`, existsSync(join(ROOT, rel)));
}

// 🔴 引擎目录里不许有个人数据 —— 这是「谁都能用」的前提
assert('引擎目录里没有 data/', ENGINE_ENTRIES.every((e) => !existsSync(join(ROOT, e, 'data'))));
if (existsSync(join(ROOT, 'data'))) {
  detail('仓库根有 data/ —— 那是旧版把个人数据放在 skill 目录里的位置，已被 .gitignore 忽略；' +
    '正式位置是用户目录（跑 `node scripts/init.mjs --migrate` 迁走）');
}
assert('没有伪造站点 fixture-server.mjs', !existsSync(join(ROOT, 'tools', 'fixture-server.mjs')));

// 引擎不该被几十 MB 的浏览器缓存 / 个人数据撑大
// ⚠️ 只量引擎：仓库根本来就可能躺着 data/（几百 MB 的浏览器 profile），量它会让这条永远红。
let totalKB = 0;
for (const f of engineFiles()) totalKB += statSync(f).size / 1024;
assert(`引擎体积 < 2MB（实 ${Math.round(totalKB)}KB）`, totalKB < 2048);

// ---------------------------------------------------------------- B. SKILL.md
console.log('\n[ B ] SKILL.md');
const skillMd = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
assert('frontmatter 有 name: auto-introduce', /^name:\s*auto-introduce\s*$/m.test(skillMd));
assert('frontmatter 有 description', /^description:\s*\S+/m.test(skillMd));
for (const sect of ['铁律', '状态机', '界面事实', '失败态', '执行器', '参考文件', '初始化', '数据与配置']) {
  assert(`含小节「${sect}」`, skillMd.includes(sect));
}
// 取岗路径必须写死在意向筛选上，且回列表必须带 --label（光 back 会丢意向）
assert('SKILL.md 写明用 pick --label 取岗', /pick --label/.test(skillMd));
assert('SKILL.md 写明回列表用 back --label', /back --label/.test(skillMd));
assert('SKILL.md 写明禁止批量取列表', /禁止批量取列表/.test(skillMd));
assert('SKILL.md 不再教「按位置找意向按钮」', !/按位置找/.test(skillMd));
// 通用性：意向标签来自 profile.md，不写死某个人的标签
assert('SKILL.md 用意向标签占位符（不写死某个人的标签）', /pick --label\s*"<意向标签>"/.test(skillMd));
assert('SKILL.md 说明意向标签取自 profile.md', /标签取自\s*`?profile\.md`?|标签来自\s*`?profile\.md`?/.test(skillMd));
// 发送语义（2026-10-16 用户授权改为执行器代点）
assert('SKILL.md 把 say 定为正式路径（填入并发送）', /say <文案>/.test(skillMd) && /填入并发送|填入即发送/.test(skillMd));
assert('SKILL.md 写明 fill 只填不发', /只填不发|只填不发送/.test(skillMd));
assert('SKILL.md 写明发出不可撤回', /不可撤回/.test(skillMd));
assert('SKILL.md 写明 guard 退出码 0 才允许发送', /退出码 0 才允许调用 `say`/.test(skillMd));
assert('SKILL.md 写明草稿会丢（不能把"已填入"当投递）', /草稿会丢/.test(skillMd));
assert('SKILL.md 不再写「发送由用户点」', !/发送由用户点|发送权归用户/.test(skillMd));
// 初始化引导（面向新用户）
assert('SKILL.md 引导新用户跑 init.mjs', /scripts\/init\.mjs/.test(skillMd));
assert('SKILL.md 说明引擎与个人数据分开存放', /用户数据目录|个人数据/.test(skillMd));

// ---------------------------------------------------------------- C. flow.mjs 语法与用法
console.log('\n[ C ] flow.mjs 语法与用法');
{
  const r = run(process.execPath, ['--check', FLOW]);
  assert('语法合法', r.code === 0, r.code === 0 ? '' : r.out.split('\n')[0]);
}
{
  const r = run(process.execPath, [FLOW]);
  assert('无参数 → 退出码 0 + 打用法', r.code === 0 && r.out.includes('用法'), `code=${r.code}`);
  assert('用法里列出全部命令',
    ['where', 'state', 'enter', 'pick', 'read', 'next-card', 'contact', 'say', 'send', 'fill', 'back']
      .every((c) => r.out.includes(c)));
}
{
  const r = run(process.execPath, [FLOW, 'bogus-command']);
  assert('未知命令 → 退出码 1', r.code === 1, `code=${r.code}`);
}
{
  // where 必须**不连浏览器**也能给出答案（新用户第一条命令）
  const r = run(process.execPath, [FLOW, 'where'], { env: { CDP_ENDPOINT: 'http://127.0.0.1:1' } });
  assert('where 不连浏览器即可运行（退出码 0）', r.code === 0, `code=${r.code}`);
  assert('where 报出 data_dir / graph 位置', r.out.includes('data_dir=') && r.out.includes('graph='));
}
{
  // 参数校验必须**在连浏览器之前**：否则用法错会被「连不上浏览器」掩盖
  const r = run(process.execPath, [FLOW, 'pick', '--index', 'abc']);
  assert('pick --index abc → 退出码 1', r.code === 1, `code=${r.code}`);
  assert('报的是参数非法，不是连不上浏览器', r.out.includes('参数非法') && !r.out.includes('连不上浏览器'));
}
{
  const r = run(process.execPath, [FLOW, 'wait-login', '--timeout', '-5']);
  assert('wait-login --timeout -5 → 退出码 1（非负整数校验）', r.code === 1, `code=${r.code}`);
}
{
  // --label 给了却没带值：必须在连浏览器之前就报用法错
  const r = run(process.execPath, [FLOW, 'pick', '--label']);
  assert('pick --label 缺值 → 退出码 1', r.code === 1, `code=${r.code}`);
  assert('报的是参数缺值，不是连不上浏览器', r.out.includes('参数缺值') && !r.out.includes('连不上浏览器'));
}
{
  const r = run(process.execPath, [FLOW, 'back', '--label', 'X'], { env: { CDP_ENDPOINT: 'http://127.0.0.1:1' } });
  assert('back --label 在非 CHAT 时不会误报成功', r.code !== 0, `code=${r.code}`);
}
{
  // 浏览器不存在时：退出码 2 + FAIL + FIX，且指向正确的原因
  const r = run(process.execPath, [FLOW, 'state'], { env: { CDP_ENDPOINT: 'http://127.0.0.1:1' } });
  assert('连不上浏览器 → 退出码 2', r.code === 2, `code=${r.code}`);
  assert('输出含 FAIL 与 FIX', r.out.includes('FAIL') && r.out.includes('FIX'));
}

// ---------------------------------------------------------------- D. flow.mjs 不含跑偏残留
console.log('\n[ D ] 执行器只面向真实站点');
const flowSrc = readFileSync(FLOW, 'utf8');
assert('无 FLOW_HOST 模拟宿主缝隙', !/FLOW_HOST/.test(flowSrc));
assert('无 fixture 引用', !/fixture/i.test(flowSrc));
assert('判据基于 zhipin.com', /zhipin/.test(flowSrc));
assert('导航/意向/沟通用真实鼠标点击', /Input\.dispatchMouseEvent/.test(flowSrc));
assert('选卡片用事件派发（避开 hover 浮层）', /dispatchEvent\(new MouseEvent\('click'/.test(flowSrc));
// 发送（2026-10-16 用户授权改为执行器代点）：约束从「谁都不许点发送」
// 变成「只有 sendCurrent 能点，且必须点的是 .chat-op button.btn-send、必须做发出后双核对」。
assert('SEL 里的发送按钮是 .chat-op button.btn-send（不是工具栏的 btn-sendimg）',
  /sendBtn:\s*'\.chat-op button\.btn-send'/.test(flowSrc.match(/const SEL = \{[\s\S]*?\};/)?.[0] ?? ''));
assert('发送按钮探测排除了 .btn-sendimg（发图片）', /sendimg/.test(flowSrc));
assert('发送坐标要先 scrollIntoView 并检查是否真的进了视口', /inViewport/.test(flowSrc));
assert('SEL 里我方消息用的是 item-myself', /chatMine:\s*'li\.message-item\.item-myself'/.test(flowSrc));
assert('没有任何把 item-mine 当选择器用的地方（注释里提它是为了记坑）',
  !/'li\.message-item\.item-mine'/.test(flowSrc));
{
  // 唯一发送实现：sendCurrent。say / send 都走它，别处不许出现点发送。
  const senders = [...flowSrc.matchAll(/COMMANDS\.(send|say)\s*=\s*async/g)].map((m) => m[1]).sort();
  assert('say 与 send 都存在', senders.join(',') === 'say,send', senders.join(','));
  assert('sendCurrent 是唯一的发送实现', /async function sendCurrent\(/.test(flowSrc));
  assert('say 走 sendCurrent', /COMMANDS\.say[\s\S]{0,400}?await sendCurrent\(text\)/.test(flowSrc));
  assert('send 走 sendCurrent', /COMMANDS\.send[\s\S]{0,600}?await sendCurrent\(text\)/.test(flowSrc));
  assert('发出后核对输入框已清空', /点了发送但输入框没清空/.test(flowSrc));
  assert('发出后核对我方消息已落进会话', /lastMessage', true/.test(flowSrc));
}
{
  // fill 仍是**只填不发**的预览路径：体内不得出现任何点击
  const body = flowSrc.match(/COMMANDS\.fill = async \(\) => \{[\s\S]*?\n\};/)?.[0] ?? '';
  assert('fill 命令体内没有任何点击调用（预览路径不许代发）', !!body && !/mouseClick|dispatchClick|sendCurrent/.test(body));
}
// 意向切换只能有一处实现；back 必须复用它把意向切回来（漏一步就会落回推荐流）
assert('意向切换抽成 pickExpect（唯一实现）', /async function pickExpect\(/.test(flowSrc));
assert('pick 走 pickExpect', /COMMANDS\.pick[\s\S]{0,1200}?await pickExpect\(\{ index: idx, label \}\)/.test(flowSrc));
assert('back --label 会复用 pickExpect 切回意向', /COMMANDS\.back[\s\S]{0,1400}?await pickExpect\(\{ label \}\)/.test(flowSrc));
assert('用法里给出 pick --label（取岗正路）', /pick --label/.test(flowSrc));
// 数据位置只能有一处实现
assert('数据路径解析集中在 paths.mjs', /from '\.\/paths\.mjs'/.test(flowSrc) && !/\.\.\/data\//.test(flowSrc));

// ---------------------------------------------------------------- E. 通用性：引擎不含个人数据
console.log('\n[ E ] 通用性：引擎里不夹带个人信息');
{
  const files = engineFiles();

  // 静态黑名单（明显的个人标识串）。
  // ⚠️ 用拼接写：否则这些串本身就出现在 selftest.mjs 里，扫描会把**检查器自己**当成泄漏。
  const staticLeaks = ['Ragana' + 'Bloodedge', '1806' + '015345', '1500' + '4246305', '李依' + '宸'];
  for (const s of staticLeaks) {
    const hit = files.filter((f) => readFileSync(f, 'utf8').includes(s));
    assert(`引擎不含「${s}」`, hit.length === 0, hit.map((f) => f.slice(ROOT.length + 1)).join(', '));
  }
}
{
  // 动态检查：图谱 identity 里的任何值都不该出现在引擎文件中
  const d = dataDir();
  if (!d.initialized) {
    skip('图谱 identity 未出现在引擎里', '尚无个人图谱（新装即如此）');
  } else {
    const g = JSON.parse(readFileSync(graphPath(), 'utf8'));
    const values = Object.values(g.identity ?? {}).filter((v) => typeof v === 'string' && v.length >= 5);
    const files = engineFiles();
    const leaked = [];
    for (const v of values) {
      for (const f of files) {
        if (readFileSync(f, 'utf8').includes(v)) leaked.push(`${v} → ${f.slice(ROOT.length + 1)}`);
      }
    }
    assert('图谱 identity 的每个值都不在引擎文件里', leaked.length === 0, leaked.join('; '));
  }
}

// ---------------------------------------------------------------- F. SKILL.md 子命令表 vs 代码
console.log('\n[ F ] SKILL.md 子命令表 vs flow.mjs');
{
  const fromCode = new Set(
    [...flowSrc.matchAll(/^COMMANDS(?:\.([A-Za-z][\w-]*)|\[['"]([^'"]+)['"]\])\s*=/gm)]
      .map((m) => m[1] ?? m[2]));
  const tableStart = skillMd.indexOf('## 执行器');
  const tableEnd = skillMd.indexOf('**环境变量**');
  const table = skillMd.slice(tableStart, tableEnd === -1 ? undefined : tableEnd);
  const fromDoc = new Set(
    [...table.matchAll(/^\|\s*`([a-z][\w-]*)(?:\s[^`]*)?`\s*\|/gm)].map((m) => m[1]));
  const missingInDoc = [...fromCode].filter((c) => !fromDoc.has(c));
  const missingInCode = [...fromDoc].filter((c) => !fromCode.has(c));
  assert(`代码命令 ${fromCode.size} 个全部写进 SKILL.md`, missingInDoc.length === 0, missingInDoc.join(','));
  assert(`SKILL.md 命令 ${fromDoc.size} 个都在代码里`, missingInCode.length === 0, missingInCode.join(','));
}

// ---------------------------------------------------------------- G. 初始化（全新安装也能跑通）
console.log('\n[ G ] init.mjs：全新安装 / 迁移');
const TMP = mkdtempSync(join(tmpdir(), 'ai-selftest-'));
const CLEAN_ENV = { AI_HOME: join(TMP, 'home'), AI_DATA_DIR: '' }; // AI_DATA_DIR 置空 → 走 AI_HOME
const cleanRun = (args) => run(process.execPath, args, { env: { ...CLEAN_ENV, AI_DATA_DIR: undefined } });
try {
  {
    const r = cleanRun([INIT, '--where']);
    assert('init --where 可运行（退出码 0）', r.code === 0, `code=${r.code}`);
  }
  {
    const r = cleanRun([INIT]);
    assert('全新安装：init 退出码 0', r.code === 0, r.out.split('\n').slice(-3).join(' | '));
    assert('全新安装：落了 capability-graph.json', existsSync(join(TMP, 'home', 'data', 'capability-graph.json')));
    assert('全新安装：落了 profile.md', existsSync(join(TMP, 'home', 'data', 'profile.md')));
    assert('全新安装：建了 drafts/ 目录', existsSync(join(TMP, 'home', 'data', 'drafts')));
    assert('全新安装：报告里没有残留「旧位置」告警', !/仍在用 skill 目录里的旧数据位置/.test(r.out));
  }
  {
    // 空图谱必须能被 guard 正常读取（不能崩）
    const py = pickPython();
    if (!py) {
      skip('空图谱可被 guard 读取', '找不到 python');
    } else {
      const r = run(py, [GUARD, '--where'], { env: { ...CLEAN_ENV, AI_DATA_DIR: join(TMP, 'home', 'data') } });
      assert('guard --where 指向 AI_HOME 数据目录', r.code === 0 && r.out.includes(join(TMP, 'home', 'data')), `code=${r.code}`);
      const r2 = run(py, [GUARD, '--data-dir', join(TMP, 'home', 'data'), '--text', '你好，我想应聘这个岗位。', '--require', 'x', '--focus', 'nope'],
        { env: { ...CLEAN_ENV } });
      assert('空图谱：guard 不崩（退出码 1 且有 FAIL 明细）', r2.code === 1 && r2.out.includes('FAIL'), `code=${r2.code}`);
    }
  }
  {
    // 迁移：把一个假「旧数据」放进 skill 目录会污染交付物，所以只测「不报错、
    // 且把结果说清楚」—— 有旧数据就迁走（迁进下面的临时 AI_HOME，不碰真数据），
    // 没有就明说没有。仓库根现在可能确实躺着旧版遗留的 data/，两种分支都得接受。
    const r = cleanRun([INIT, '--migrate']);
    assert('--migrate 不报错且说明结果',
      r.code === 0 && /(没有发现旧位置的数据|迁移|里没有可迁移的文件)/.test(r.out), `code=${r.code}`);
  }
  {
    const dest = join(TMP, 'bundle');
    const r = run(process.execPath, [PACK, '--to', dest]);
    assert('pack 能打出分发包（退出码 0）', r.code === 0, r.out.split('\n').slice(-2).join(' | '));
    assert('分发包里有 SKILL.md', existsSync(join(dest, 'SKILL.md')));
    assert('分发包里没有 data/（不夹带个人数据）', !existsSync(join(dest, 'data')));
    assert('分发包里没有个人图谱本体（模板除外）',
      !readdirSync(dest, { recursive: true }).some((f) => String(f).endsWith(join('capability-graph.json'))));
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

// ---------------------------------------------------------------- H. 图谱结构 + 护栏行为（有图谱才跑）
const d = dataDir();
let graph = null;
if (d.initialized) {
  try {
    graph = JSON.parse(readFileSync(graphPath(), 'utf8'));
  } catch (e) {
    bad('图谱是合法 JSON', String(e?.message));
  }
}

console.log(`\n[ H ] 能力图谱结构（${d.initialized ? graphPath() : '尚无个人图谱 → 跳过'}）`);
if (!graph) {
  skip('图谱结构断言', '尚无个人图谱（新装或未初始化）');
} else {
  // 判据限定在**引擎目录**上：仓库根可能还躺着旧版遗留的 data/（已 gitignore、不进包），
  // 那不是引擎的东西，不构成「把个人数据夹带进交付物」。真正要保证的是它别出现在
  // scripts/ references/ assets/ src/ dist/ 里。
  assert('图谱不在引擎目录里（个人数据与引擎分离）',
    !ENGINE_ENTRIES.some((e) => graphPath().startsWith(join(ROOT, e))), graphPath());
  if (graphPath().startsWith(join(ROOT, 'data'))) {
    detail('图谱正从仓库根的旧版 data/ 读出 —— 正式位置是用户数据目录（~/.auto-introduce/data），' +
      '跑一次 `node scripts/init.mjs` 后它就不会再被用到');
  }
  assert('identity.name 存在', !!graph?.identity?.name, graph?.identity?.name ?? '');
  assert('education 非空且带 jd_hits', graph.education.length > 0 && graph.education.every((e) => Array.isArray(e.jd_hits)));
  assert('experience 带 id/jd_hits/blacklist',
    graph.experience.length > 0 && graph.experience.every((e) => e.id && Array.isArray(e.jd_hits) && Array.isArray(e.blacklist)));
  assert('projects 带 id/on_resume/jd_hits/blacklist',
    graph.projects.length > 0 &&
    graph.projects.every((p) => p.id && typeof p.on_resume === 'boolean' && Array.isArray(p.jd_hits) && Array.isArray(p.blacklist)));
  assert('至少有一个 private 项目（护栏要能拒它）', graph.projects.some((p) => p.visibility === 'private'));
  assert('public 项目都有链接', graph.projects.filter((p) => p.visibility === 'public').every((p) => !!p.link));
  assert('global_blacklist 非空', graph.global_blacklist.length > 0);
  assert('writing_rules.focus_aliases 覆盖所有可用 project id（private 除外）',
    graph.projects.filter((p) => p.visibility !== 'private')
      .every((p) => Array.isArray(graph.writing_rules.focus_aliases[p.id])));
  assert('writing_rules.budget 有 resume_only / with_offresume',
    !!graph.writing_rules.budget.resume_only && !!graph.writing_rules.budget.with_offresume);
  assert('budget 的闸门区间在目标区间之外（闸门 ≥ 目标，否则 WARN 永远不会出现）', (() => {
    const b = graph.writing_rules.budget.resume_only;
    const t = b.target_chars ?? [b.min_chars, b.max_chars];
    return b.min_chars <= t[0] && b.max_chars >= t[1];
  })());
}

console.log('\n[ I ] guard.py 行为');
const py = pickPython();
if (!py) {
  bad('找不到 python，护栏行为无法自检');
} else if (!graph) {
  skip('护栏行为断言', '尚无个人图谱');
} else {
  const G = (args) => run(py, [GUARD, ...args]);
  const HOME_LINK = graph.identity.homepage;
  const EXAMPLES = {                // 从图谱里现取一个「可用主攻事实」，避免写死某个人的项目名
    focus: graph.projects.find((p) => p.visibility !== 'private')?.id,
    focusName: graph.projects.find((p) => p.visibility !== 'private')?.name,
    private: graph.projects.find((p) => p.visibility === 'private')?.id,
    offresume: graph.projects.find((p) => !p.on_resume)?.id,
  };
  assert('图谱里至少有一个可用作 --focus 的实体', !!EXAMPLES.focus, EXAMPLES.focus ?? '');

  if (EXAMPLES.focus) {
    const good =
      `我看到这个岗位在找相关方向的工程师，和我的方向很贴：` +
      `${EXAMPLES.focusName} 是我从零实现的系统，核心部分全部自己写，` +
      `并做了完整的测试与验证。我是海外高校计算机硕士，2026 年 7 月毕业。` +
      `代码在 ${HOME_LINK}。`;
    const base = ['--require', EXAMPLES.focusName.slice(0, 2), '--focus', EXAMPLES.focus];

    {
      const r = G(['--text', good, ...base]);
      assert('合格文案全绿（退出码 0）', r.code === 0, r.code === 0 ? '' : r.out.split('\n').slice(-4).join(' | '));
      assert('长度闸门取自图谱 budget（闸门与目标分别报出）', /闸门 \d+–\d+，目标 \d+–\d+/.test(r.out));
    }
    {
      const r = G(['--text', good.replace('并做了完整的测试与验证', '把吞吐提升 5.3 倍'), ...base]);
      assert('「5.3 倍」业绩数字被拦（退出码 1）', r.code === 1 && r.out.includes('禁用数字'), `code=${r.code}`);
    }
    {
      const r = G(['--text', good.replace('并做了完整的测试与验证', '由 4 个角色协同'), ...base]);
      assert('「4 个」无单位业绩数字被拦', r.code === 1 && r.out.includes('禁用数字'), `code=${r.code}`);
    }
    {
      const r = G(['--text', good, '--require', EXAMPLES.focusName.slice(0, 2)]);
      assert('未声明 --focus → FAIL', r.code === 1 && r.out.includes('主攻事实'), `code=${r.code}`);
    }
    {
      const r = G(['--text', good, ...base, '--require', 'GPU 算子融合']);
      assert('点名词缺失 → FAIL', r.code === 1 && r.out.includes('点名词'), `code=${r.code}`);
    }
    {
      const r = G(['--text', good.replace(`代码在 ${HOME_LINK}。`, ''), ...base]);
      assert('缺主页 → FAIL（可验证入口）', r.code === 1 && r.out.includes('可验证入口'), `code=${r.code}`);
    }
    {
      const r = G(['--text', good, ...base, '--allow-number', '16']);
      assert('--allow-number 无 --why → 退出码 2', r.code === 2, `code=${r.code}`);
    }
    if (EXAMPLES.private) {
      const r = G(['--text', good, '--require', EXAMPLES.focusName.slice(0, 2), '--focus', EXAMPLES.private]);
      assert('private 仓库作 --focus 被拒', r.code === 1 && r.out.includes('private'), `code=${r.code}`);
    } else {
      skip('private 仓库作 --focus 被拒', '图谱里没有 private 项目');
    }
    {
      const r = G(['--text', good, ...base, '--offresume', EXAMPLES.focus]);
      assert('--offresume 指已上简历项目 → FAIL', r.code === 1 && r.out.includes('未上简历'), `code=${r.code}`);
    }
    if (EXAMPLES.offresume) {
      const r = G(['--text', good, ...base, '--offresume', EXAMPLES.offresume]);
      assert('未上简历项目不带自己的链接 → FAIL', r.code === 1 && r.out.includes('未上简历'), `code=${r.code}`);
    } else {
      skip('未上简历项目不带链接 → FAIL', '图谱里没有 on_resume=false 的项目');
    }
  }
  {
    const r = G(['--require', 'x']);
    assert('缺 --file/--text → 退出码 2', r.code === 2, `code=${r.code}`);
  }
  {
    // 图谱里的 number_whitelist 正则写错 → 用法错（不许静默跳过）
    const TMP2 = mkdtempSync(join(tmpdir(), 'ai-guard-'));
    try {
      const broken = JSON.parse(JSON.stringify(graph));
      broken.writing_rules.number_whitelist = [{ label: '坏的', pattern: '[unclosed' }];
      const p = join(TMP2, 'capability-graph.json');
      writeFileSync(p, JSON.stringify(broken), 'utf8');
      const r = G(['--graph', p, '--text', '随便一段话。', '--focus', EXAMPLES.focus ?? 'x', '--require', 'x']);
      assert('number_whitelist 正则非法 → 退出码 2（不静默跳过）', r.code === 2 && /正则非法/.test(r.out), `code=${r.code}`);
    } finally {
      rmSync(TMP2, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------- J. 登录判据（真值表）
console.log('\n[ J ] 登录判据 decideLogin（纯函数真值表）');
{
  const { decideLogin, STATES } = await import(pathToFileURL(FLOW).href);
  const S = STATES;
  const cases = [
    // [说明, byUrl, probe, 期望 state, 期望 loggedIn]
    ['① 登录页 + 无姓名 + 无登录入口 ⇒ 未登录（**回归**：曾被假阳性判成已登录）',
      S.LOGIN, { nameVisible: false, loginEntry: false }, S.LOGIN, false],
    ['② 登录页 + 读得到姓名 ⇒ 已登录（归位 HOME）',
      S.LOGIN, { nameVisible: true, loginEntry: false }, S.HOME, true],
    ['③ 主页 + 有登录入口 ⇒ 未登录',
      S.HOME, { nameVisible: false, loginEntry: true }, S.LOGIN, false],
    ['④ 应用页 + 无姓名 + 无登录入口 ⇒ 已登录',
      S.HOME, { nameVisible: false, loginEntry: false }, S.HOME, true],
    ['⑤ JOBS 页 + 有登录入口 ⇒ 未登录（判据压过 URL 查表）',
      S.JOBS, { nameVisible: false, loginEntry: true }, S.LOGIN, false],
    ['⑥ probe 取不到 ⇒ 不猜，保持 URL 查表结果',
      S.HOME, null, S.HOME, null],
  ];
  for (const [name, byUrl, probe, wantState, wantLogged] of cases) {
    let got;
    try {
      got = decideLogin(byUrl, probe);
    } catch (e) {
      bad(name, `抛错 ${e?.message}`);
      continue;
    }
    assert(name, got.state === wantState && got.loggedIn === wantLogged,
      `得 state=${got.state} loggedIn=${got.loggedIn}，期望 state=${wantState} loggedIn=${wantLogged}`);
  }
}

// ---------------------------------------------------------------- K. dsh 插件形态
//
// 同一个仓库有两种交付形态：skill（SKILL.md + scripts + references + assets）与
// dsh 插件（package.json 的 dsh.bundle + cordis.patch.yml + src/ + dist/）。
// 下面这几条保证插件那一半不会在改动引擎时被悄悄改坏。
console.log('\n[ K ] dsh 插件形态');
if (!existsSync(join(ROOT, 'package.json'))) {
  // 纯 skill 安装（把引擎拷进 ~/.workbuddy/skills/ 那种）没有 package.json，
  // 插件那一半本来就不存在 —— 跳过，不算失败。
  skip('dsh 插件形态断言', '当前安装没有 package.json（纯 skill 安装），插件形态不适用');
} else {
  const pkgPath = join(ROOT, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  assert('包名是 dsh-bossintroduce', pkg.name === 'dsh-bossintroduce', String(pkg.name));
  assert('入口指向 dist/index.js', pkg.main === 'dist/index.js', String(pkg.main));
  assert('files 覆盖引擎（scripts/references/assets/SKILL.md）',
    ['scripts', 'references', 'assets', 'SKILL.md', 'dist'].every((f) => (pkg.files ?? []).includes(f)),
    JSON.stringify(pkg.files));
  assert('peer 声明 @deepseek-ai/dsh-tools', !!pkg.peerDependencies?.['@deepseek-ai/dsh-tools']);
  assert('发布源是 registry.npmjs.org', pkg.publishConfig?.registry === 'https://registry.npmjs.org');

  // dsh.bundle.patch 指的那个文件必须真的存在 —— 指错了插件装上是静默不生效
  const patchRel = pkg.dsh?.bundle?.patch;
  assert('package.json 声明了 dsh.bundle.patch', typeof patchRel === 'string' && patchRel.length > 0, String(patchRel));
  assert('dsh.bundle.patch 指向的文件存在', !!patchRel && existsSync(join(ROOT, patchRel)), String(patchRel));

  const patchPath = patchRel ? join(ROOT, patchRel) : '';
  const patchSrc = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
  // 顶层必须是 patch 操作序列；写成裸 insert: 映射会被静默忽略
  assert('cordis.patch.yml 顶层是 - insert: 序列', /^\s*-\s*insert:\s*$/m.test(patchSrc));
  assert('cordis.patch.yml 里 name 用包名（不写相对路径）', /name:\s*dsh-bossintroduce\s*$/m.test(patchSrc));

  const srcPath = join(ROOT, 'src', 'index.ts');
  assert('存在 src/index.ts', existsSync(srcPath));
  const src = existsSync(srcPath) ? readFileSync(srcPath, 'utf8') : '';
  // 具名导出；默认导出会让加载器丢掉 inject 等元数据
  assert('src 具名导出 name / inject / apply',
    /export const name\b/.test(src) && /export const inject\b/.test(src) && /export function apply\b/.test(src));
  // 具名导出；默认导出会让加载器丢掉 inject 等元数据。
  // ⚠️ 必须锚在行首：文件头注释里就写着「绝不 export default」，不锚会把注释本身当成违规。
  assert('src 没有 export default', !/^\s*export\s+default\b/m.test(src));
  // 参数 DSL：requiredness 只有 `required: true` 一种写法，写 false 会被 tsc 拒绝
  assert('参数 DSL 里没有 required: false', !/required:\s*false/.test(src));
  // 输出 schema 必须 as const，否则 'object' 被推宽成 string，O 塌成 never
  assert('输出 schema 用了 as const（否则 O 塌成 never）', /as const;/.test(src));

  // cordis 4 硬校验：apply 里访问 ctx.<service> 的属性前，必须先在 inject 声明那个服务，
  // 否则插件激活直接抛 `cannot get property "<service>" without inject`，整插件不生效。
  // 0.1.2 的线上故障就是这么来的（用了 systemPrompt 却只 inject 了 tools）。
  // 注意：即使走 `(ctx as unknown as {...}).systemPrompt` 这种 cast 访问，也照样要声明。
  const declared = ((src.match(/export const inject = \[([^\]]*)\]/) ?? [, ''])[1] ?? '')
    .split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const accessed = [...new Set(
    [...src.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  )].filter((k) => !['effect', 'plugin', 'logger', 'on', 'emit', 'inject'].includes(k));
  const undeclared = accessed.filter((k) => !declared.includes(k));
  assert('ctx.<service> 访问都在 inject 里声明（cordis 4 硬校验）',
    undeclared.length === 0,
    `未声明：${undeclared.join(' / ')}；inject=[${declared.join(', ')}]`);
  // 同一坑的另一半：服务名可能以 cast 形式出现（`as {...}`），ctx.<x> 那条正则扫不到，
  // 所以对已知服务名再直视一次 —— 出现在源码里就必须出现在 inject 里。
  for (const svc of ['systemPrompt', 'tools']) {
    if (!new RegExp(`\\b${svc}\\b`).test(src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''))) continue;
    assert(`用到 ${svc} 就必须在 inject 里声明`, declared.includes(svc), `inject=[${declared.join(', ')}]`);
  }
  // Electron 下 process.execPath 不是 Node，必须带 ELECTRON_RUN_AS_NODE
  assert('起了带 ELECTRON_RUN_AS_NODE 的兜底', /ELECTRON_RUN_AS_NODE/.test(src));
  // 发送权：只有 boss_say 能点到发送，且它必须先过 boss_guard（护栏是外部命令）
  assert('boss_say 走 flow 的 say/send', /\[FLOW, \.\.\.argv\]|'say'/.test(src) && /'send'/.test(src));
  assert('boss_guard 走 guard.py', /GUARD/.test(src));

  // dist 必须与 src 同批存在（发布前跑 npm run build）
  assert('存在 dist/index.js（发布前跑 npm run build）', existsSync(join(ROOT, 'dist', 'index.js')));
  assert('存在 dist/index.d.ts', existsSync(join(ROOT, 'dist', 'index.d.ts')));

  assert('存在 README.md（npm 首页用）', existsSync(join(ROOT, 'README.md')));
  assert('存在 LICENSE', existsSync(join(ROOT, 'LICENSE')));
  const lic = existsSync(join(ROOT, 'LICENSE')) ? readFileSync(join(ROOT, 'LICENSE'), 'utf8') : '';
  assert('LICENSE 是 MIT', /^MIT License/m.test(lic));
}

// ---------------------------------------------------------------- 汇总
console.log('\n' + '='.repeat(68));
if (failures.length === 0) {
  console.log(`OK  ${pass} 项全绿`);
  console.log('⚠️  这只是离线证明。选择器是否仍命中真实页面，只有真机能证明。');
  process.exit(0);
}
console.log(`FAIL  ${failures.length} 项未过（通过 ${pass} 项）`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
