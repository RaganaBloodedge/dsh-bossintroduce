#!/usr/bin/env node
/**
 * pack.mjs —— 打一个**可分发**的 skill 副本（给别人用 / 放进版本库）
 *
 * 为什么单独有它：skill 目录 = 引擎，个人数据在用户目录（见 paths.mjs）。
 * 分发时**只拷引擎**，绝不能把个人数据（能力图谱 / profile / 简历解析产物 / 浏览器 profile）带出去。
 * 本脚本按白名单拷贝，并在拷完做一次「有没有夹带个人数据」的检查。
 *
 * 用法：
 *   node scripts/pack.mjs                       # 拷到 <cwd>/dist/auto-introduce
 *   node scripts/pack.mjs --to D:/tmp/bundle   # 指定目标目录
 *   node scripts/pack.mjs --force               # 目标已存在时先清空再拷
 *
 * 退出码：0 成功 / 1 用法错 / 2 环境错
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { SKILL_ROOT } from './paths.mjs';

const ENGINE_ENTRIES = ['SKILL.md', 'scripts', 'references', 'assets'];
/**
 * 绝对不许出现在分发包里的名字（个人数据 / 缓存 / 草稿）。
 * ⚠️ 模板要放行：`capability-graph.template.json` / `profile.template.md` 是引擎的一部分，
 *    被拦下的只能是**用户数据本体**（`capability-graph.json`、`profile.md`）。
 */
const FORBIDDEN = [
  /^data$/i,
  /^capability-graph\.json$/i,
  /^profile\.md$/i,
  /^resume/i,
  /edge-profile$/i,
  /^drafts$/i,
  /__pycache__/i,
  /\.pyc$/i,
  /\.log$/i,
  /^dist$/i,
];

const argv = process.argv.slice(2);
const argVal = (name, def) => {
  const i = argv.indexOf(name);
  return i === -1 ? def : (argv[i + 1] ?? def);
};

const dest = resolve(argVal('--to', join(process.cwd(), 'dist', 'auto-introduce')));
const force = argv.includes('--force');

if (dest === SKILL_ROOT || dest.startsWith(SKILL_ROOT + '\\') || dest.startsWith(SKILL_ROOT + '/')) {
  console.error(`FAIL  目标目录不能落在 skill 目录里面：${dest}`);
  process.exit(1);
}
if (existsSync(dest)) {
  if (!force) {
    console.error(`FAIL  目标已存在：${dest}`);
    console.error('FIX  换一个 --to，或加 --force 清空后重拷');
    process.exit(1);
  }
  rmSync(dest, { recursive: true, force: true });
}

mkdirSync(dest, { recursive: true });
let files = 0;
for (const entry of ENGINE_ENTRIES) {
  const src = join(SKILL_ROOT, entry);
  if (!existsSync(src)) {
    console.error(`FAIL  引擎文件缺失：${src}（skill 安装不完整）`);
    process.exit(2);
  }
  cpSync(src, join(dest, entry), { recursive: true });
  files += statSync(src).isDirectory()
    ? readdirSync(src, { recursive: true }).length + 1
    : 1;
  console.log(`OK  拷贝 ${entry}`);
}

// ------------------------------------------------------------------ 夹带检查
//
// 「拷完再看一眼」比「拷的时候小心」可靠 —— 白名单也可能写漏。

const leaked = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (FORBIDDEN.some((rx) => rx.test(e.name))) leaked.push(p);
      else walk(p);
    } else if (FORBIDDEN.some((rx) => rx.test(e.name))) {
      leaked.push(p);
    }
  }
})(dest);

console.log('-'.repeat(68));
console.log(`KEY  dest=${dest}`);
console.log(`KEY  files=${files}`);
if (leaked.length) {
  console.error(`FAIL  分发包里疑似夹带个人数据/缓存：\n  ${leaked.join('\n  ')}`);
  process.exit(2);
}
console.log('-'.repeat(68));
console.log(`OK  已打出可分发副本：${basename(dest)}（个人数据未包含）`);
console.log('DETAIL  装给别人用：把整个目录拷到对方的 ~/.workbuddy/skills/auto-introduce/，');
console.log('        然后让对方跑 `node scripts/init.mjs` 完成初始化（见 SKILL.md §初始化引导）。');
