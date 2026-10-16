#!/usr/bin/env node
/**
 * init.mjs —— 初始化用户数据目录（**新用户的第一条命令**；不需要浏览器）
 *
 * 为什么需要它：本 skill 面向多用户，**引擎（skill 目录）与个人数据分开**。
 * 引擎可以随便升级、分享、覆盖；个人数据放在用户目录里，跨会话留存。
 * 这个脚本负责：建目录 → 落模板 → （可选）把旧位置的数据迁过来。
 *
 * 用法：
 *   node scripts/init.mjs               # 建目录 + 落模板（**已存在的文件不覆盖**）
 *   node scripts/init.mjs --migrate     # 把 <skill>/data 里的旧数据迁到用户目录
 *   node scripts/init.mjs --where       # 只打印解析结果，不写任何文件
 *   node scripts/init.mjs --force       # 模板也覆盖（图谱/profile 已有内容会被冲掉，慎用）
 *
 * 退出码：0 成功 / 1 用法错 / 2 环境错（写不进去）
 *
 * ⚠️ 本脚本**不会**替你把简历抽成图谱 —— 那是 Agent 按 SKILL.md §初始化引导 面试用户后做的。
 *    它只把「地基」放好：一个合法的空图谱 + 一份投递配置模板。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  SKILL_ROOT, browserProfile, canonicalDataDir, dataDir, describePaths,
} from './paths.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const ASSETS = join(SKILL_ROOT, 'assets');
const TEMPLATES = [
  ['capability-graph.template.json', 'capability-graph.json'],
  ['profile.template.md', 'profile.md'],
];
const MIGRATE_FILES = ['capability-graph.json', 'profile.md', 'resume-raw.txt'];

const out = (s) => console.log(s);
const ok = (s) => out(`OK  ${s}`);
const detail = (s) => out(`DETAIL  ${s}`);
const fail = (msg, fix, code = 2) => {
  out(`FAIL  ${msg}`);
  if (fix) out(`FIX  ${fix}`);
  process.exit(code);
};

if (has('--where')) {
  describePaths(out);
  process.exit(0);
}

// ⚠️ 写路径一律用 canonicalDataDir()（**不回退到旧位置**）；
//    读路径才用 dataDir()（它会回退）。两者混用会让「迁移」这一步静默失效。
const target = canonicalDataDir();
const before = dataDir();

out('='.repeat(68));
out(`AutoIntroduce 初始化   数据目录 = ${target.dir}   （来源 ${target.source}）`);
out('='.repeat(68));

// ------------------------------------------------------------------ 建目录

try {
  mkdirSync(join(target.dir, 'drafts'), { recursive: true });
  mkdirSync(browserProfile(), { recursive: true });
} catch (e) {
  fail(`建目录失败：${e?.message}`, '确认对目标路径有写权限，或用 AI_HOME/AI_DATA_DIR 换一个位置');
}

// ------------------------------------------------------------------ 迁移旧数据
//
// 早期版本把个人数据放在 <skill>/data 里 —— 一升级 skill 就丢。这里一次性搬走。
// ⚠️ **必须在落模板之前做**：否则空模板会先占住目标路径，迁移被「已存在」跳过 ——
//    表现是"迁移成功"但读到的还是空图谱。

if (has('--migrate')) {
  const legacy = existsSync(join(SKILL_ROOT, 'data', 'capability-graph.json')) ? join(SKILL_ROOT, 'data') : null;
  if (!legacy) {
    detail('没有发现旧位置的数据（<skill>/data），无需迁移');
  } else {
    let moved = 0;
    for (const name of MIGRATE_FILES) {
      const from = join(legacy, name);
      const to = join(target.dir, name);
      if (!existsSync(from)) continue;
      if (existsSync(to) && !has('--force')) {
        detail(`${name} 目标已存在 —— 跳过（要覆盖加 --force）`);
        continue;
      }
      try {
        copyFileSync(from, to);
      } catch (e) {
        fail(`迁移 ${name} 失败：${e?.message}`, `手工把 ${from} 复制到 ${target.dir}`);
      }
      ok(`迁移 ${name}  ${legacy} → ${target.dir}`);
      moved += 1;
    }
    if (moved) {
      detail(`旧目录仍在：${legacy} —— 确认新位置无误后可自行删除（**本脚本不删任何文件**）`);
    } else {
      detail(`${legacy} 里没有可迁移的文件`);
    }
  }
}

// ------------------------------------------------------------------ 落模板

for (const [tpl, name] of TEMPLATES) {
  const src = join(ASSETS, tpl);
  const dst = join(target.dir, name);
  if (!existsSync(src)) fail(`模板缺失：${src}`, 'skill 安装不完整，重新拷贝整个 skill 目录');
  if (existsSync(dst) && !has('--force')) {
    detail(`${name} 已存在（${Math.round(statSync(dst).size / 1024)}KB）—— 不动它（要覆盖加 --force）`);
    continue;
  }
  copyFileSync(src, dst);
  ok(`写入 ${dst}`);
}

// ------------------------------------------------------------------ 收尾
//
// ⚠️ 收尾必须**复读一次解析结果**：读路径只有在正式目录里出现 capability-graph.json 后
//    才会切过去，所以「迁移/落盘是否真的生效」要实测，不能只凭「复制成功」下结论。

const after = dataDir();
let userName = '';
if (after.initialized) {
  try {
    userName = JSON.parse(readFileSync(join(after.dir, 'capability-graph.json'), 'utf8'))?.identity?.name ?? '';
  } catch {
    /* 空图谱或还没填，忽略 */
  }
}

out('-'.repeat(68));
out(`KEY  data_dir=${after.dir}`);
out(`KEY  source=${after.source}`);
out(`KEY  graph=${join(after.dir, 'capability-graph.json')}  ${after.initialized ? '存在' : '缺失'}`);
out(`KEY  profile=${join(after.dir, 'profile.md')}  ${existsSync(join(after.dir, 'profile.md')) ? '存在' : '缺失'}`);
out(`KEY  browser_profile=${browserProfile()}`);
if (userName) out(`KEY  user_name=${userName}`);
out('-'.repeat(68));

if (!after.initialized) {
  fail('初始化未完成：数据目录里没有 capability-graph.json',
    '加 --migrate 迁旧数据；或确认模板落盘成功（看上面 OK/DETAIL 行）');
}
if (after.source === 'legacy-skill') {
  detail('⚠️ 仍在用 skill 目录里的旧数据位置 —— 迁移没生效，检查上面几行');
}
if (before.source === 'legacy-skill' && after.source !== 'legacy-skill') {
  ok('已从 skill 目录切到用户数据目录（重启会话后依然生效）');
}
if (!userName) {
  detail('图谱里 identity.name 还是空的 —— 这是**下一步**：按 SKILL.md §初始化引导 把简历抽成图谱');
}
ok('脚手架就绪（下一步：建能力图谱 → 起浏览器 → 走状态机）');
