/**
 * paths.mjs —— 「引擎在哪」与「我的数据在哪」的**唯一**解析处（供 flow.mjs / init.mjs / pack.mjs / selftest.mjs 共用）
 *
 * 设计前提（本 skill 面向多用户）：
 *   - **skill 目录 = 引擎**（SKILL.md / scripts / references / assets），只读、可分享、可覆盖升级；
 *     里面**不许**放任何个人信息（姓名、简历、GitHub、项目事实）。
 *   - **用户数据 = 每人一份**，放在用户目录下，跨会话留存，升级 skill 不会动它。
 *
 * 解析顺序（先命中先用）：
 *   数据目录 AI_DATA_DIR
 *     → $AI_HOME/data                （默认 $HOME/.auto-introduce/data）
 *     → <skill>/data                 （**旧版遗留**：早期把数据放在 skill 里；仅当它确实存在才用，
 *                                     并提示跑 `init.mjs --migrate` 迁走 —— 否则一升级 skill 就丢）
 *
 * 环境变量：
 *   AI_HOME       用户数据根目录，默认 $HOME/.auto-introduce
 *   AI_DATA_DIR   直接指定数据目录（覆盖 AI_HOME）
 *   FLOW_PROFILE  浏览器 profile 目录，默认 $AI_HOME/edge-profile
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** skill 根目录（本文件在 <skill>/scripts/ 下）。 */
export const SKILL_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const GRAPH_FILE = 'capability-graph.json';

/**
 * 用户数据根目录。
 * @returns {string}
 */
export function aiHome() {
  return process.env.AI_HOME ? resolve(process.env.AI_HOME) : join(homedir(), '.auto-introduce');
}

/**
 * **规范化**数据目录（不带旧位置回退）—— 所有**写入**都必须落这里。
 * 读路径用 dataDir()（它可能回退到旧位置），写路径用本函数，两者别混。
 * @returns {{dir: string, source: 'AI_DATA_DIR'|'AI_HOME'}}
 */
export function canonicalDataDir() {
  if (process.env.AI_DATA_DIR) return { dir: resolve(process.env.AI_DATA_DIR), source: 'AI_DATA_DIR' };
  return { dir: join(aiHome(), 'data'), source: 'AI_HOME' };
}

/**
 * 数据目录 + 它从哪来（`source` 用于把「你正在用旧位置」这件事说清楚）。
 * @returns {{dir: string, source: 'AI_DATA_DIR'|'AI_HOME'|'legacy-skill', legacy: string|null, initialized: boolean}}
 */
export function dataDir() {
  const legacy = join(SKILL_ROOT, 'data');
  const legacyHasGraph = existsSync(join(legacy, GRAPH_FILE));
  const canonical = canonicalDataDir();

  if (existsSync(join(canonical.dir, GRAPH_FILE)) || existsSync(canonical.dir)) {
    return {
      dir: canonical.dir,
      source: canonical.source,
      legacy: legacyHasGraph ? legacy : null,
      initialized: existsSync(join(canonical.dir, GRAPH_FILE)),
    };
  }

  // 没有正式数据目录，但 skill 里躺着旧数据 ⇒ 沿用旧位置（不静默失效），同时报出迁移提示
  if (legacyHasGraph) {
    return { dir: legacy, source: 'legacy-skill', legacy, initialized: true };
  }

  return { dir: canonical.dir, source: canonical.source, legacy: null, initialized: false };
}

export function graphPath() {
  return join(dataDir().dir, GRAPH_FILE);
}

export function profilePath() {
  return join(dataDir().dir, 'profile.md');
}

export function draftsDir() {
  return join(dataDir().dir, 'drafts');
}

/** 浏览器 profile 目录（登录态要跨会话留存，所以放用户目录而不是 skill 目录）。 */
export function browserProfile() {
  return process.env.FLOW_PROFILE ? resolve(process.env.FLOW_PROFILE) : join(aiHome(), 'edge-profile');
}

/**
 * 未初始化时统一的提示语（flow / guard / init 三处口径一致，免得各说各的）。
 * @returns {string}
 */
export function notInitializedHint() {
  const d = dataDir();
  return `数据目录未初始化（缺 ${join(d.dir, GRAPH_FILE)}）。` +
    `先跑初始化：在 skill 目录下执行 \`node scripts/init.mjs\` 建立脚手架，` +
    `再按 SKILL.md §初始化引导 把简历/自述抽成能力图谱。`;
}

/**
 * 打印解析结果（`flow.mjs where` / `init.mjs --where` 共用）。
 * @param {(s: string) => void} print
 */
export function describePaths(print) {
  const d = dataDir();
  const rows = [
    ['skill_root', SKILL_ROOT],
    ['ai_home', aiHome()],
    ['data_dir', `${d.dir}  (来源 ${d.source})`],
    ['graph', `${graphPath()}  ${existsSync(graphPath()) ? '存在' : '**不存在**'}`],
    ['profile', `${profilePath()}  ${existsSync(profilePath()) ? '存在' : '**不存在**'}`],
    ['browser_profile', browserProfile()],
  ];
  for (const [k, v] of rows) print(`KEY  ${k}=${v}`);
  if (d.source === 'legacy-skill') {
    print('DETAIL  正在使用 skill 目录里的**旧数据位置** —— 升级/替换 skill 会连带丢掉个人数据，' +
      '跑 `node scripts/init.mjs --migrate` 迁到用户目录');
  }
  if (!d.initialized) print(`DETAIL  ${notInitializedHint()}`);
}
