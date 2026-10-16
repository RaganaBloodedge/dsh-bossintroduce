# dsh-bossintroduce

> npm 包名与仓库名都是 `dsh-bossintroduce`，在 dsh 的插件页输入包名即可安装。
> 同一个仓库也是一份 skill：根目录有 `SKILL.md`，`scripts/` 是零第三方依赖的引擎，
> 拷进 `~/.workbuddy/skills/` 就能用，两种形态共用同一套代码。

在 Boss 直聘（**求职者侧**）替你在一个**可见的浏览器**里翻岗位，为每一条 JD 写一段
只属于它的自我介绍，发给那位 HR。

批量投递时，给每个岗位写一段"看起来是为它写的"开场话术很费神；但同一段话投所有岗位，
HR 一眼看穿，反而扣分。**这件事的全部价值在差异化** —— 同一个人，针对不同岗位点不同的名、
上不同的事实。所以这个插件做的不是"群发"，而是把**你的能力图谱**和**JD 的具体要求**
接起来，逐条产出不同的开场话术。

---

## 它怎么工作

三段式，各管一段，边界不重叠：

| 段 | 谁做 | 内容 |
| --- | --- | --- |
| 判断 | 模型 | 读 JD，决定投不投；决定拿哪条事实当主攻；写文案 |
| 动作 | `scripts/flow.mjs` | 查状态、点意向、读描述、翻卡片、点立即沟通、填入、发送 |
| 闸门 | `scripts/guard.py` | 文案在发出去之前必须过八项检查，退出码 0 才放行 |

状态判定与动作顺序**写死在执行器里**，运行时只查表 + 检查，不做推理 —— 模型每次重新
推导一遍"现在该点哪个按钮"，是这类自动化最不稳的地方。

```
HOME ──职位──> JOBS ──意向筛选──> 逐张读 JD ──匹配──> 立即沟通 ──> CHAT ──填入并发送──> 回 JOBS
                  ↑                                                              │
                  └──────────────────── back（自动切回意向）──────────────────────┘
```

三条约束是实测撞出来的，写进引擎而不是写进文档提醒：

- **岗位只从意向筛选列表里取。** 实测：意向列表在点过「立即沟通」后会**自行刷新**
  （已沟通的岗位移出、其余重排），而在默认推荐流里点完沟通，卡片和顺序纹丝不动 ——
  所以推荐流看起来"更稳"，但它永远给你同一批岗位。
- **一张一张看，不允许批量取列表。** 因为列表会重排，任何提前批量抓下来的清单
  （索引 / 标题 / 顺序）下一轮必然错位。
- **`back` 会落回默认推荐流**，意向筛选丢失。所以回列表这一步必须带意向标签重选，
  由执行器一步做完，不指望临场记得。

### 能力图谱：事实的唯一来源

自我介绍只能引用能力图谱里的条目，不得新增事实。图谱是一份 JSON，每人一份，抽自简历 /
公开仓库 / 自述，每条事实带 `jd_hits`（这条事实能回应哪些 JD 词）、`on_resume`
（在不在简历上）、`visibility`、`blacklist`（**不能怎么写**）。

`blacklist` 是最容易被漏、也最影响可信度的一项 —— 例："写「从零实现」，不写「自研引擎」"、
"不得写「完全独立完成」"、"不许搬业绩数字"。护栏会逐条检查，所以它不靠自觉。

### 文案护栏：不可撤回动作的最后一道闸

发出去的话收不回来，所以 `boss_say` 之前必须过 `boss_guard`。八项检查：

| 检查 | 口径 |
| --- | --- |
| 长度闸门 | 可见字符数落在预算区间（区间来自图谱 `writing_rules.budget`；不写则用引擎默认 120–200 字） |
| 禁用数字 | 白名单硬失败：只放行「有出处」的数字（日期、年份、版本号、指令集、院校背书） |
| 事实来源 | 文里至少有一个能在图谱里找到对应条目的实体 |
| 点名词 | 指定的 JD 原词确实出现在文里 |
| 主攻事实 | 声明的主攻事确实落在文里（私有仓库直接拒） |
| 未上简历项 | 引用了不在简历上的项目时，必须带上它**自己的**链接 |
| 黑名单 | 条目级 + 全局黑名单均未被触犯 |
| 可验证入口 | 文案里带公开主页（最强可验证信号） |

「默认零数字」值得单独说：提速倍数、测试条数、吞吐量、百分比这类**业绩数字一律不写**。
它们对 HR 的边际价值接近零，而且一眼就能看出是从一份通用材料里搬来的。

---

## 安装

### 方式一：从 npm 装（推荐）

dsh 桌面应用 → 插件页 → 添加插件 → 填 `dsh-bossintroduce` → 重启。

管理器做的事：`pnpm add dsh-bossintroduce` → 把它加进 profile 的 `dsh.profile.bundles` →
包自带的 `cordis.patch.yml` 作为 **bundle 层自动生效**，用户不用手写任何配置。

**这个形态下插件不需要自带 `node_modules`** —— `@deepseek-ai/*` 那类 peer 由宿主自己解析。

### 方式二：绝对路径挂载（本地开发，改代码即生效）

```bash
git clone https://github.com/RaganaBloodedge/dsh-bossintroduce.git
cd dsh-bossintroduce
npm install                                   # 顺带跑 prepare（即 tsc），产出 dist/

cp cordis.example.yml cordis.local.yml        # 把里面的 <本仓库的绝对路径> 换成真实路径
dsh --profile web --patch "<cordis.local.yml 的绝对路径>" --dump-config   # 只组合配置
dsh --profile web --patch "<cordis.local.yml 的绝对路径>"                 # 真启动
```

用绝对路径挂载时入口文件在 `node_modules` 之外，Node 找不到 `@deepseek-ai/*`，
所以必须先 `npm install`。

### 方式三：当 skill 用（WorkBuddy / 其它读 SKILL.md 的宿主）

把仓库整个拷到 `~/.workbuddy/skills/dsh-bossintroduce/`，然后照根目录的 `SKILL.md` 走。
这条路径不用 Node 依赖，只用 `scripts/` 里的引擎。

### 前置要求

| 需要 | 说明 |
| --- | --- |
| Edge 或 Chrome | 插件会起一个**可见**的浏览器并开 CDP 调试端口；用 `browserPath` 指定绝对路径，留空自动发现 |
| Python 3 | 只有文案护栏需要；用 `pythonPath` 指定，留空自动发现 |
| Node ≥ 22.6 | 本地挂载/开发时需要；桌面应用内由宿主提供（Electron 下插件自动带 `ELECTRON_RUN_AS_NODE=1`，不需要另装） |

---

## 首次使用：初始化

```bash
node scripts/init.mjs              # 建数据目录 + 落「空图谱 + 投递配置」模板
node scripts/init.mjs --migrate    # 旧版把数据放在仓库目录里 → 迁到用户目录
node scripts/flow.mjs where        # 看引擎/数据/图谱/profile 到底解析到哪
```

然后**建能力图谱**（这一步必须由模型驱动，见 `references/01-能力图谱.md` 的八步）：
从简历 PDF / 公开仓库 / 自述里抽身份、教育、荣誉、经历、项目，逐条打 `jd_hits`、分档、
标 `on_resume`/`visibility`、写黑名单。做完把关键条目念给用户逐项确认 ——
图谱里每条事实都会变成发给 HR 的一句话。

投递配置写在数据目录的 `profile.md` 里：城市、意向标签、薪资左边界、学历门槛、
毕业时间窗口、循环次数 N。

---

## 工具

| 工具 | 作用 |
| --- | --- |
| `boss_where` | 报告引擎/数据/图谱/profile/浏览器 profile 的解析结果（不连浏览器） |
| `boss_init` | 落初始化脚手架（可带 `migrate` 迁旧数据） |
| `boss_browser` | `status` 探 CDP 端口 / `launch` 起可见浏览器并等端口应答 |
| `boss_state` | 当前状态 + 登录判定（**每次开工第一件事**） |
| `boss_wait_login` | 停在登录页等用户登录完（仅在 `boss_state` 判出 LOGIN 后调用） |
| `boss_enter` | HOME → 岗位页 |
| `boss_pick` | 切到某个意向的岗位列表（`label` / `index` / `list`） |
| `boss_read` | 读右侧职位描述 |
| `boss_next_card` | 选下一张卡片（事件派发，不跳页） |
| `boss_contact` | 点「立即沟通」→ 聊天页 |
| `boss_say` | **填入并发送**（不可撤回）；不给 `text` 则发送框里已有的内容 |
| `boss_back` | 回岗位列表并**自动切回意向**（一定要带 label） |
| `boss_recover` | 失败态出口：回 HOME |
| `boss_guard` | 文案护栏，退出码 0 才允许发送 |

插件还会往系统提示词里加一节，说明开工顺序与红线 —— 否则模型只看到十四个孤立的工具名，
会把它当浏览器遥控器乱点。

### 一轮循环

```
boss_state → [LOGIN？让用户登录 + boss_wait_login]
boss_enter → boss_pick --label "<意向标签>" → boss_read → 硬过滤 + 匹配判断
   ├ 不匹配 → boss_next_card → boss_read → …
   └ 匹配   → 取 JD 头号要求 → 从图谱挑一条最相关的事实当主攻
              → 按图谱口径写文案（语气 + 长度，见 `references/02`）→ boss_guard（退出码 0）
              → boss_contact → boss_say → boss_back --label → 下一条
```

凑满 N 份即停，报清单：岗位 / HR / 公司 / 薪资 / 主攻事实 / 文案首句。

---

## 已知坑

都是实测踩出来的。违反了不报错，只是行为不对：

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| 明明发成功却报「最后一条消息不是刚发的文案」 | 早期把我方消息的类名猜成了 `item-mine`，实际是 `item-myself` | 已修；气泡文本可能带「已读」尾巴，所以用前缀包含比对 |
| 刚填入就点发送，报「按钮是禁用态」 | 编辑器状态是异步同步的，填入后按钮会短暂 `disabled` | 已修：等它变可点（≤6s）再点 |
| 按坐标点发送点空，且没有任何报错 | 页面比窗口宽，按钮落在视口右边外面 | 已修：先 `scrollIntoView` 再量，不在视口内就明确报错 |
| 中文输入框里塞进去的内容被插件改写 | 用了 CDP 的 `Input.insertText` 之外的路径 | 引擎走 `innerText` 直写并**读回比对**，不一致就报错 |
| `boss_state` 在登录页误判成已登录 | 早期判据是"找不到登录入口"，而登录页上就有登录入口 | 已修：抽成纯函数 `decideLogin`，真值表回归 |
| 从 HOME 点「消息」进岗位页 | 消息页没有选中 HR，右侧没有输入框 ⇒ CHAT_FAIL | 别点消息，用 `boss_enter`；进了失败态一律 `boss_recover`，不手动补救 |
| 点卡片结果跳到了职位详情页 | 卡片 hover 会浮出「立即沟通」浮层，鼠标命中浮层 | 选卡片用事件派发，不用鼠标点 |
| 窗口最小化后什么都点不到 | 坐标点击依赖元素尺寸，最小化时尺寸为 0 | 保持窗口可见 |
| `taskkill` 之后用户得重新登录 | 那会连用户已登录的浏览器一起杀掉 | **绝不 taskkill 清场**；要停就停启动它的那个任务 |

---

## 数据在哪

**引擎与个人数据是分开的**，所以升级/分享/发布插件都不会碰到你的数据：

| | 位置 | 内容 |
| --- | --- | --- |
| 引擎 | 包目录（`SKILL.md` / `scripts` / `references` / `assets` / `dist`） | 流程、执行器、护栏、模板 |
| 个人数据 | `$AI_HOME/data`（默认 `~/.auto-introduce/data`） | `capability-graph.json`、`profile.md`、`resume-raw.txt`、`drafts/` |
| 浏览器登录态 | `$AI_HOME/edge-profile` | 已登录的浏览器 profile |

解析顺序（Node 与 Python 同一套口径，见 `scripts/paths.mjs`）：
`AI_DATA_DIR` → `$AI_HOME/data` → `<包目录>/data`（旧版遗留，仅在确实存在时才用并提示迁移）。

随包发布的只有引擎。`scripts/pack.mjs` 打可分发副本时会再扫一遍**有没有夹带个人数据**
（图谱、profile、简历、浏览器缓存），有就报错退出。

---

## 自检

```bash
npm run selftest          # 引擎 + 图谱结构一起过（离线，不需要浏览器）
node scripts/flow.mjs where
```

自检在**没有个人图谱的全新环境**下也能全绿（图谱相关断言正确跳过），
所以它是"这个包收到了就能用"的最低保证。

---

## 发版（维护者）

```bash
npm version patch --no-git-tag-version    # 或 minor / major
git commit -am "chore(release): x.y.z"
npm publish --registry=https://registry.npmjs.org/
```

三件容易踩的事：

- **本机默认 registry 往往是镜像**（`registry.npmmirror.com`），它只读、不能发布 —— 必须显式带
  `--registry=https://registry.npmjs.org/`。
- **新包的第一个版本不会直接上线。** npm 2026 年起启用了暂存发布（staged publishing）：首次
  `publish` 只是把版本提交到暂存区，registry 上会出现一个 `0.0.0-stage` 占位版，真实版本要到
  npmjs.com 的 **Staged Packages** 里点 Approve 才上线（这一步需要 2FA）。**同包的后续版本直接
  上线、不再进暂存。**
- **发布凭证。** npm 现在强制「账号开着 2FA」或「一个勾了 Bypass 2FA 的 granular access token」
  才能发布 —— 关掉 2FA 反而会拿到
  `403 Two-factor authentication or granular access token with bypass 2fa enabled is required`。
  需要非交互发布时，建一个 bypass-2FA 的 granular token（Packages and scopes 给 Read and write），
  临时写进**项目内** `.npmrc`（已在 `.gitignore` 里），发完即删。

---

## License

MIT © 2026 Li Yichen (李依宸)
