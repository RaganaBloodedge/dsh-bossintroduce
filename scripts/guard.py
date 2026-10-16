#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
guard.py —— 自我介绍文案护栏（DESIGN-SPEC §4.3 的可执行版）

生成完一段自我介绍后**必须**过这里，退出码 0 才算产出。

六项检查（一项不过即 FAIL，退出码 1）：

  | 检查     | 实现                                                       |
  |----------|------------------------------------------------------------|
  | 长度闸门 | 可见字符数落在预算区间；句数不超上限                        |
  | 禁用数字 | 白名单硬失败：只放行「有出处」的数字，其余一律拦下            |
  | 事实来源 | 文里至少有一个能在能力图谱中找到对应条目的实体                |
  | 点名词   | JD 头号要求的原词确实出现在文里                              |
  | 主攻事实 | --focus 指定的事实确实落在文里（private 仓库直接拒）          |
  | 黑名单  | 用到条目的黑名单字面项、全局黑名单均未被触犯                  |

用法：
  python guard.py --file draft.txt --require "RAG" --focus <经历或项目 id>
  python guard.py --text "……" --require "推理引擎" --focus <项目 id>
  python guard.py --file draft.txt --require "RAG" --focus <id> \\
      --budget extra --offresume <未上简历的项目 id>
  python guard.py --text "……" --require "RAG" --focus <id> \\
      --allow-number "16 薪" --why "JD 原文写明的薪资结构，属岗位信息非业绩数字"
  python guard.py --where                # 只报告数据目录/图谱/profile 解析结果

参数：
  --file <path>        文案文件（与 --text 二选一）
  --text <string>      文案正文（与 --file 二选一）
  --require <term>     必须出现的点名词（JD 头号要求的原词），可重复
  --focus <id>         本条的主攻事实 id（能力图谱里的 project/experience id）
  --budget resume|extra
                       resume = 默认预算（字数/句数上限来自图谱 writing_rules.budget；
                       图谱没写时用引擎默认 120–200 字 / ≤4 句）
                       extra  = 引用了未上简历项目时的放宽预算（150–210 字，≤5 句）
                       两档的边界都可由图谱 writing_rules.budget 覆盖
  --offresume <id>     用到的未上简历仓库 id，可重复；每个都必须带自己的链接
  --allow-number <s>   显式放行某个数字字面量，**必须同时给 --why**
  --why <reason>       放行理由（与 --allow-number 配对）
  --graph <path>       能力图谱路径（默认取「数据目录」下的 capability-graph.json）
  --data-dir <path>    指定数据目录（覆盖 AI_DATA_DIR / AI_HOME）
  --where              只打印「数据目录 / 图谱 / profile」解析结果后退出（排查用）

数据位置（本 skill 面向多用户：skill 目录只放引擎，个人数据在用户目录）：
  AI_DATA_DIR  →  $AI_HOME/data（默认 ~/.auto-introduce/data）  →  <skill>/data（旧版遗留）
  环境变量 AI_HOME 可改根目录。

退出码：0 全部通过 / 1 有 FAIL / 2 用法或环境错误
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------- 路径解析
#
# ⚠️ 与 scripts/paths.mjs 的口径必须一致（Node 侧同一套顺序）：
#    AI_DATA_DIR → $AI_HOME/data → <skill>/data（旧版遗留，仅当存在）

GRAPH_FILE = "capability-graph.json"
SKILL_ROOT = Path(__file__).resolve().parent.parent


def ai_home() -> Path:
    raw = os.environ.get("AI_HOME")
    return Path(raw).expanduser().resolve() if raw else Path.home() / ".auto-introduce"


def resolve_data_dir(explicit=None):
    """→ (数据目录, 来源, 旧数据目录或 None)"""
    legacy = SKILL_ROOT / "data"
    legacy_graph = legacy / GRAPH_FILE
    legacy_hit = legacy if legacy_graph.is_file() else None

    if explicit:
        return Path(explicit).expanduser().resolve(), "AI_DATA_DIR", legacy_hit
    env_dir = os.environ.get("AI_DATA_DIR")
    if env_dir:
        return Path(env_dir).expanduser().resolve(), "AI_DATA_DIR", legacy_hit

    canonical = ai_home() / "data"
    if (canonical / GRAPH_FILE).is_file() or canonical.is_dir():
        return canonical, "AI_HOME", legacy_hit
    if legacy_hit:
        return legacy, "legacy-skill", legacy_hit
    return canonical, "AI_HOME", None

# ---------------------------------------------------------------- 预算表
#
# 默认值就是「中文开场自我介绍」的通用口径；图谱里写了就按图谱的来 ——
# 是**每个人自己的**文案纪律，不该写死在引擎里。

DEFAULT_BUDGETS = {
    #            目标区间(铁律)      闸门区间(硬失败线)   句数上限
    "resume": {"target": (120, 160), "gate": (120, 200), "max_sentences": 4},
    "extra": {"target": (150, 210), "gate": (150, 210), "max_sentences": 5},
}


def budgets_for(graph):
    """图谱 writing_rules.budget 覆盖默认预算。

    `resume_only` / `with_offresume` 各自的 `min_chars`/`max_chars` 定义**闸门**；
    可选的 `target_chars` 定义铁律目标区间（不给就沿用默认目标）。
    """
    budgets = {k: dict(v) for k, v in DEFAULT_BUDGETS.items()}
    wr = (graph.get("writing_rules") or {}).get("budget") or {}
    for key, gkey in (("resume", "resume_only"), ("extra", "with_offresume")):
        block = wr.get(gkey) or {}
        lo, hi = block.get("min_chars"), block.get("max_chars")
        if isinstance(lo, int) and isinstance(hi, int) and lo < hi:
            budgets[key]["gate"] = (lo, hi)
        tgt = block.get("target_chars")
        if isinstance(tgt, (list, tuple)) and len(tgt) == 2:
            budgets[key]["target"] = (int(tgt[0]), int(tgt[1]))
        ms = block.get("max_sentences")
        if isinstance(ms, int) and ms > 0:
            budgets[key]["max_sentences"] = ms
    return budgets


# ---------------------------------------------------------------- 数字白名单
#
# 铁律 1：默认零数字。只放行「有出处」的数字 —— 时间 / 身份 / 版本 / 院校背书。
# 其余任何数字（提速倍数、测试条数、吞吐量、百分比、方法数、毫秒数……）
# 一律硬失败，包括「4 个角色」这种没有单位的。
#
# 每条规则都是 (说明, 编译后的正则)。按顺序匹配，命中即放行。
# ⚠️ 顺序即正确性：**带年份的长模式必须排在裸年份前面**。
#    否则「年份」先掩掉 2026，「年月」就再也匹配不上「2026 年 7 月」，7 会被误杀。
#
# 分三段拼装：前缀（日期/年月/版本号）→ **技术栈（图谱给，没有就用兜底）** → 后缀（分数线/指令集/年份）。
# 技术栈必须能按人替换 —— 「Gemma 2」「Qwen3」只对某个用户有意义，不该写死在引擎里。

BASE_WHITELIST_PREFIX = [
    ("日期", re.compile(r"\d{4}\s*[./\-]\s*\d{1,2}(\s*[./\-]\s*\d{1,2})?")),
    ("年月", re.compile(r"\d{4}\s*年(\s*\d{1,2}\s*月)?")),
    # ⚠️ 版本号必须「长得像版本」：带 v 前缀，或至少两个点（3.13.1）。
    #    早期写成 `\d+(\.\d+)+`，结果「提速 5.3 倍」里的 5.3 被当成版本号放行 ——
    #    业绩数字成功冒充。单位型数字一律不放行。
    ("版本号", re.compile(r"[vV]\d+(?:\.\d+)*|\d+\.\d+\.\d+")),
]

BASE_WHITELIST_SUFFIX = [
    ("分数线", re.compile(r"CET-?\s*6|985|211")),
    # 指令集 / 硬件代次：AVX2、SSE4.2、x86-64、DDR5 —— 技术标识符，不是业绩数字
    ("指令集/硬件", re.compile(r"(?:AVX|SSE|MMX|DDR|PCIe|USB|HDMI|DP|x86|arm|Neon)\s?-?\d*(?:\.\d+)?", re.I)),
    ("年份", re.compile(r"(?:19|20)\d{2}")),
]

# 图谱没写 number_whitelist 时的兜底（覆盖最常见的语言/框架版本写法）
FALLBACK_STACK_WHITELIST = [
    ("语言/框架版本", re.compile(r"(?:C\+\+?\s*\d*|Qt\s*\d*|Python\s*\d+(?:\.\d+)?|Java\s*\d+|Go\s*1\.\d+|Node\.?js\s*\d*)")),
]


def whitelist_for(graph):
    """按图谱 writing_rules.number_whitelist 组装白名单。

    图谱写法（每项 `{"label": 说明, "pattern": 正则}`；也可直接给正则字符串）：
        "number_whitelist": [{"label": "技术栈版本", "pattern": "Gemma\\s*\\d|Qwen\\s*\\d*"}]
    正则写错 → 抛 ValueError，由 main 变成用法错（退出码 2），**不静默跳过**。
    """
    rules = list(BASE_WHITELIST_PREFIX)
    user_rules = []
    for item in ((graph.get("writing_rules") or {}).get("number_whitelist") or []):
        if isinstance(item, dict):
            label, pattern = item.get("label") or "自定义", item.get("pattern") or ""
        else:
            label, pattern = "自定义", str(item)
        if not pattern:
            continue
        try:
            user_rules.append((label, re.compile(pattern)))
        except re.error as e:
            raise ValueError(f"图谱 writing_rules.number_whitelist 里的正则非法：{pattern}（{e}）")
    rules += user_rules or FALLBACK_STACK_WHITELIST
    rules += BASE_WHITELIST_SUFFIX
    return rules

# 这些片段不是「业绩数字」，是标识符 / 链接，扫描前先摘掉
NON_NUMBER_CONTEXT = [
    re.compile(r"https?://\S+"),
    re.compile(r"\bwww\.\S+"),
    re.compile(r"\b[\w.-]+\.(?:com|cn|io|org|net|dev)/\S*"),
    re.compile(r"\b[\w.-]+@[\w.-]+\.\w+"),
]

# 黑名单短语里的「禁止字面项」：否定词 + 引号
NEGATION_CUES = ("不得", "不要", "不能", "禁止", "严禁", "不写", "勿写", "别写", "不得写")
QUOTE_PAIRS = [("「", "」"), ("“", "”"), ("\"", "\""), ("'", "'")]


# ---------------------------------------------------------------- 工具

def visible_chars(text):
    """可见字符数：去掉空白后的全部字符（含英文与技术词、主页）。"""
    return len(re.sub(r"\s", "", text))


def chinese_chars(text):
    return len(re.findall(r"[\u4e00-\u9fff]", text))


def split_sentences(text):
    parts = re.split(r"[。！？!?…]+|\n+", text)
    return [p.strip() for p in parts if p.strip()]


def load_graph(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def entity_aliases(graph):
    """图谱里全部实体 → 别名列表。用于「事实来源」与「主攻事实」检查。

    ⚠️ 别名表必须**包含 writing_rules.focus_aliases**（简称表）。
    项目全名往往很长（例：「某项目（一句话副标题）」），
    文案里只会写简称 —— 只用全名去匹配会让「事实来源」误判成编造。
    这一条曾漏过：同一份图谱里 check_focus 认简称、check_facts 不认，两处口径不一致。
    """
    out = {}
    wr_aliases = (graph.get("writing_rules", {}) or {}).get("focus_aliases", {}) or {}

    def add(eid, names):
        names = [n for n in names if n]
        if eid and names:
            out.setdefault(eid, [])
            for n in names:
                if n not in out[eid]:
                    out[eid].append(n)

    for p in graph.get("projects", []):
        add(p.get("id"), [p.get("name"), p.get("link")] + list(wr_aliases.get(p.get("id"), [])))
    for e in graph.get("experience", []):
        add(e.get("id"), [e.get("org"), e.get("role")] + list(wr_aliases.get(e.get("id"), [])))
    for s in graph.get("education", []):
        add(s.get("school"), [s.get("school")])
    return out


def focus_alias_map(graph):
    """id → 认简称用的别名表（writing_rules.focus_aliases）。"""
    m = {}
    for k, v in (graph.get("writing_rules", {}).get("focus_aliases", {}) or {}).items():
        m[k] = list(v)
    return m


def strip_non_number_context(text):
    out = text
    for rx in NON_NUMBER_CONTEXT:
        out = rx.sub(" ", out)
    return out


def find_forbidden_literals(graph):
    """从黑名单短语里抽出「被禁止的字面词」。

    规则：引号前面不远处出现否定词（不得 / 不要 / 不写 / 禁止……）才禁止；
    单纯的「写『从零实现』」是**允许**项，不能误杀。
    连续引号共享同一个前缀（「不得写『A』『B』」）。
    """
    forbidden = set()

    def scan(phrase):
        if not phrase:
            return
        for open_q, close_q in QUOTE_PAIRS:
            for m in re.finditer(re.escape(open_q) + r"([^" + re.escape(open_q) + re.escape(close_q) + r"]{1,40})" + re.escape(close_q), phrase):
                inner = m.group(1).strip()
                start = m.start()
                # 往前看 10 个字符，跳过其它引号和标点，找否定词
                window = phrase[max(0, start - 10):start]
                window = re.sub(r"[」”\"'\)*、，,。.：:\s—-]+", "", window)
                if any(cue in window for cue in NEGATION_CUES):
                    for piece in re.split(r"\s*/\s*|\s*、\s*", inner):
                        piece = piece.strip(" *")
                        if piece:
                            forbidden.add(piece)

    for entry in graph.get("global_blacklist", []) or []:
        scan(entry)
    for item in graph.get("projects", []) + graph.get("experience", []):
        for entry in item.get("blacklist", []) or []:
            scan(entry)
    return sorted(forbidden)


# ---------------------------------------------------------------- 检查项

class Report:
    def __init__(self):
        self.rows = []

    def add(self, name, ok, detail):
        self.rows.append((name, ok, detail))

    @property
    def failed(self):
        return [r for r in self.rows if not r[1]]

    def render(self):
        width = max(len(n) for n, _, _ in self.rows)
        for name, ok, detail in self.rows:
            mark = "PASS" if ok else "FAIL"
            print(f"  [{mark}] {name.ljust(width)}  {detail}")
        return len(self.failed) == 0


def check_length(text, budget, rep):
    lo, hi = budget["gate"]
    tlo, thi = budget["target"]
    n_vis, n_cn = visible_chars(text), chinese_chars(text)
    sents = split_sentences(text)
    n_sent = len(sents)

    in_gate = lo <= n_vis <= hi
    in_target = tlo <= n_vis <= thi
    sent_ok = n_sent <= budget["max_sentences"]

    detail = f"可见 {n_vis} 字（中文 {n_cn}）/ {n_sent} 句；闸门 {lo}–{hi}，目标 {tlo}–{thi}，句数上限 {budget['max_sentences']}"
    rep.add("长度闸门", in_gate and sent_ok, detail)

    if in_gate and not in_target:
        print(f"  [WARN] 长度 {n_vis} 字超出铁律目标区间 {tlo}–{thi}（仍在闸门内）——按铁律 3 应重写压缩")
    if in_gate and not sent_ok:
        print(f"  [WARN] 句数 {n_sent} 超过上限 {budget['max_sentences']}——按铁律 3 应重写压缩")
    return n_vis, n_sent


def mask_whitelisted(text, whitelist):
    """把白名单片段整体掩掉，剩下的数字才是「无出处」的。

    必须掩**上下文**而不能只掩数字本身：`Gemma 2` 里被放行的是「Gemma 2」这个整体，
    `2026 年 7 月` 里被放行的是整个日期 —— 只掩 `2` / `7` 会永远掩不中。
    掩码用等长空格，保证后续上下文切片的位置仍然对。
    """
    masked = text
    for _, rx in whitelist:
        masked = rx.sub(lambda m: " " * len(m.group(0)), masked)
    return masked


def check_numbers(text, allowed_literals, whitelist, rep):
    scan = strip_non_number_context(mask_whitelisted(text, whitelist))
    hits = []
    for m in re.finditer(r"\d+(?:\.\d+)*", scan):
        literal = m.group(0)
        if literal in allowed_literals:
            continue
        ctx = scan[max(0, m.start() - 14):m.end() + 14].replace("\n", " ")
        hits.append((literal, ctx))

    if hits:
        shown = "；".join(f"「{lit}」（…{ctx}…）" for lit, ctx in hits[:6])
        rep.add("禁用数字", False,
                f"发现 {len(hits)} 个无出处数字：{shown}。"
                f"铁律 1 默认零数字；确需放行用 --allow-number <字面量> --why <理由>")
    else:
        rep.add("禁用数字", True, "未发现无出处数字（白名单内的年份/日期/版本/分数线已放行）")


def check_facts(graph, text, rep):
    aliases = entity_aliases(graph)
    present = []
    for eid, names in aliases.items():
        if any(n and n.lower() in text.lower() for n in names):
            present.append(eid)
    if present:
        rep.add("事实来源", True, f"文中实体可在图谱中找到：{', '.join(sorted(set(present)))}")
    else:
        rep.add("事实来源", False, "文中没有任何能在能力图谱里找到对应条目的实体——不得编造事实")
    return present


def check_required_terms(text, terms, rep):
    if not terms:
        rep.add("点名词", True, "未指定 --require（本轮不卡点名词）")
        return
    missing = [t for t in terms if t.lower() not in text.lower()]
    if missing:
        rep.add("点名词", False, f"JD 头号要求的原词未出现在文里：{', '.join(missing)}（铁律 5）")
    else:
        rep.add("点名词", True, f"全部命中：{', '.join(terms)}")


def check_focus(graph, text, focus_id, rep):
    if not focus_id:
        rep.add("主攻事实", False, "未指定 --focus。铁律 4：每条自我介绍只挑一条主攻事实，必须声明")
        return

    projects = {p.get("id"): p for p in graph.get("projects", [])}
    experience = {e.get("id"): e for e in graph.get("experience", [])}
    entry = projects.get(focus_id) or experience.get(focus_id)
    if entry is None:
        rep.add("主攻事实", False, f"--focus {focus_id} 在能力图谱里不存在（可用 id：{', '.join(sorted(list(projects) + list(experience)))}）")
        return

    if entry.get("visibility") == "private" or entry.get("usable") is False:
        rep.add("主攻事实", False,
                f"{focus_id} 是 private 仓库（无公开链接，无法验证）——不得作为主攻事实，也不得写进自我介绍")
        return

    aliases = focus_alias_map(graph).get(focus_id, [])
    names = [entry.get("name"), entry.get("org")] + aliases
    hit = next((n for n in names if n and n.lower() in text.lower()), None)
    if hit:
        rep.add("主攻事实", True, f"主攻事实 {focus_id} 落在文里（命中「{hit}」）")
    else:
        rep.add("主攻事实", False,
                f"主攻事实 {focus_id} 没有落在文里。可用写法：{', '.join(n for n in names if n)}")


def check_offresume(graph, text, ids, rep):
    if not ids:
        return
    projects = {p.get("id"): p for p in graph.get("projects", [])}
    bad = []
    for oid in ids:
        p = projects.get(oid)
        if p is None:
            bad.append(f"{oid} 不在图谱里")
            continue
        if not p.get("on_resume", True):
            link = (p.get("link") or "").replace("https://", "").replace("http://", "").rstrip("/")
            if not link:
                bad.append(f"{oid} 没有公开链接，不可用")
            elif link.lower() not in text.lower():
                bad.append(f"{oid} 未上简历，必须带上它自己的链接 {link}")
        else:
            bad.append(f"{oid} 已在简历上，不需要 --offresume")
    if bad:
        rep.add("未上简历项", False, "；".join(bad) + "（HR 在简历上看不到它，不给上下文等于没头没尾）")
    else:
        rep.add("未上简历项", True, f"{len(ids)} 个未上简历项目均已带链接")


def check_blacklist(graph, text, used_ids, rep):
    forbidden = find_forbidden_literals(graph)

    # 只用「文中确实出现」的条目的黑名单；全局黑名单恒查
    scoped = list(forbidden)
    projects = {p.get("id"): p for p in graph.get("projects", [])}
    experience = {e.get("id"): e for e in graph.get("experience", [])}
    entry_black = set()
    for eid in used_ids:
        entry = projects.get(eid) or experience.get(eid)
        if entry:
            entry_black.update(entry.get("blacklist", []) or [])
    # 条目黑名单里的字面项也按同一规则抽（entry 级）
    for phrase in entry_black:
        for open_q, close_q in QUOTE_PAIRS:
            for m in re.finditer(re.escape(open_q) + r"([^" + re.escape(open_q) + re.escape(close_q) + r"]{1,40})" + re.escape(close_q), phrase):
                inner = m.group(1).strip()
                window = re.sub(r"[」”\"'\)*、，,。.：:\s—-]+", "", phrase[max(0, m.start() - 10):m.start()])
                if any(cue in window for cue in NEGATION_CUES):
                    for piece in re.split(r"\s*/\s*|\s*、\s*", inner):
                        piece = piece.strip(" *")
                        if piece:
                            scoped.append(piece)

    triggered = [f for f in sorted(set(scoped)) if f and f.lower() in text.lower()]
    if triggered:
        rep.add("黑名单", False, f"触犯黑名单字面项：{', '.join(triggered)}")
    else:
        rep.add("黑名单", True, f"未触犯黑名单（字面项 {len(set(scoped))} 条已查）")


def check_homepage(graph, text, rep):
    """可验证入口：GitHub 主页是最强信号，未上简历仓库的入口，必须带。"""
    hp = (graph.get("identity", {}).get("homepage") or "").strip()
    if not hp:
        return
    bare = hp.replace("https://", "").replace("http://", "").rstrip("/")
    if bare.lower() in text.lower():
        rep.add("可验证入口", True, f"主页 {bare} 在文里")
    else:
        rep.add("可验证入口", False, f"缺少主页 {bare}——它是最强的可验证信号，也是所有未上简历仓库的入口")


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("--file")
    ap.add_argument("--text")
    ap.add_argument("--require", action="append", default=[])
    ap.add_argument("--focus")
    ap.add_argument("--budget", default="resume", choices=list(DEFAULT_BUDGETS))
    ap.add_argument("--offresume", action="append", default=[])
    ap.add_argument("--allow-number", action="append", default=[])
    ap.add_argument("--why", action="append", default=[])
    ap.add_argument("--graph")
    ap.add_argument("--data-dir")
    ap.add_argument("--where", action="store_true")
    args = ap.parse_args()

    data_dir, source, legacy = resolve_data_dir(args.data_dir)

    # --where：只报告位置，供排查「到底在读哪份图谱」
    if args.where:
        gpath = Path(args.graph).expanduser().resolve() if args.graph else data_dir / GRAPH_FILE
        for k, v in (("skill_root", SKILL_ROOT), ("ai_home", ai_home()),
                     ("data_dir", f"{data_dir}  (来源 {source})"),
                     ("graph", f"{gpath}  {'存在' if gpath.is_file() else '**不存在**'}"),
                     ("profile", f"{data_dir / 'profile.md'}  {'存在' if (data_dir / 'profile.md').is_file() else '**不存在**'}")):
            print(f"KEY  {k}={v}")
        if source == "legacy-skill":
            print("DETAIL  正在使用 skill 目录里的**旧数据位置** —— 跑 `node scripts/init.mjs --migrate` 迁到用户目录")
        return 0

    if not args.file and not args.text:
        print("FAIL 用法错误：必须给 --file 或 --text")
        return 2
    if args.file and args.text:
        print("FAIL 用法错误：--file 与 --text 只能给一个")
        return 2

    if args.file:
        if not os.path.isfile(args.file):
            print(f"FAIL 找不到文案文件：{args.file}")
            return 2
        with open(args.file, "r", encoding="utf-8") as f:
            text = f.read()
    else:
        text = args.text

    graph_path = Path(args.graph).expanduser().resolve() if args.graph else data_dir / GRAPH_FILE
    if not graph_path.is_file():
        print(f"FAIL 找不到能力图谱：{graph_path}")
        print("FIX  先跑初始化：`node scripts/init.mjs` 建脚手架，再按 SKILL.md §初始化引导 建图谱；"
              "或用 --graph/--data-dir 指定路径")
        return 2
    graph = load_graph(str(graph_path))

    try:
        whitelist = whitelist_for(graph)
    except ValueError as e:
        print(f"FAIL {e}")
        return 2
    budgets = budgets_for(graph)

    # --allow-number 必须成对且带理由
    allowed_literals = []
    for lit in args.allow_number:
        allowed_literals.append(lit)
    if args.allow_number and not args.why:
        print("FAIL 用法错误：--allow-number 必须同时给 --why（放行要留理由）")
        return 2
    if len(args.allow_number) != len(args.why):
        print("FAIL 用法错误：--allow-number 与 --why 数量不一致")
        return 2

    budget = budgets[args.budget]
    rep = Report()

    print("=" * 68)
    print(f"护栏检查  预算={args.budget}  点名词={args.require or '（未指定）'}  主攻={args.focus or '（未声明）'}")
    if source == "legacy-skill":
        print(f"⚠️  图谱取自 skill 目录（旧位置）：{graph_path} —— 建议 `node scripts/init.mjs --migrate`")
    print("=" * 68)

    check_length(text, budget, rep)
    check_numbers(text, allowed_literals, whitelist, rep)
    used = check_facts(graph, text, rep)
    check_required_terms(text, args.require, rep)
    check_focus(graph, text, args.focus, rep)
    check_offresume(graph, text, args.offresume, rep)
    check_blacklist(graph, text, used, rep)
    check_homepage(graph, text, rep)

    print("-" * 68)
    ok = rep.render()
    print("-" * 68)
    if ok:
        print("OK  护栏全绿 —— 这是发出前的最后一道闸，可以交给 say 发出")
        return 0
    print(f"FAIL  {len(rep.failed)} 项未过：{', '.join(n for n, _, _ in rep.failed)}")
    print("FIX  按上述明细改写后重跑；文案一旦发出不可撤回，别带病发")
    return 1


if __name__ == "__main__":
    sys.exit(main())
