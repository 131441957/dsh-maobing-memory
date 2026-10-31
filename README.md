# dsh-maobing-memory

> ⚠️ **本项目由 AI 生成**
>
> 代码、文档、测试脚本均由 AI（DeepSeek Harness 中的助手）编写，经人工审阅与实测后发布。作者不对其正确性与适用性作担保，请自行评估风险；发现问题欢迎提 issue。

> ## 💰 装之前先读：这个插件会让你的对话变贵
>
> 默认开启「反思轮」——**每轮对话结束后会多跑一个极短的模型回合**（只输出一行情绪值）。
>
> **单轮 token 开销约为普通对话的 2 倍。** 按量付费的话，这会直接翻在你的账单上。
>
> **不想付这个钱就关掉它**（不影响记忆功能）：
>
> ```yaml
> # profile 的 cordis.patch.yml
> - id: maobing-memory
>   name: "maobing-memory"
>   config:
>     reflect: false
> ```
>
> 关掉之后：记忆照常注入与检索、面板照常可用；只是**不再自动从对话里写新记忆**，情绪也不再自动更新（要手动记就走 `memory_remember` 工具）。

DSH（DeepSeek Harness）的跨会话记忆插件：把对话里值得长期记住的东西存成结构化条目，之后按需自动带回上下文，并附一个可浏览、可检索、可整理的面板。

## 它能做什么

- **记忆**：一条记忆 = 判断句 + 依据 + 标签 + 项目，可分类（知识/事件/技能/任务/情感）、可标重要性
- **自动衰减**：每天定时做「强度衰减」，越来越久没被用到的记忆会变淡，**归零只归档、永不物理删除**
- **检索注入**：首轮给一份按项目分组的快照 + 笔记索引，之后每轮用 BM25 把最相关的带进上下文——**前几条给全文、其余给一行索引**（这样「答案排第 4」也不会漏掉）。不写进系统提示词，走独立消息，不影响缓存
- **笔记**：长文（方案、清单、读书笔记）单独存成 Markdown 文件，SQLite 只存索引，可按行分页读、可按关键词搜
- **情绪状态**：四对互斥轴（喜↔悲 / 怒↔恐 / 意料中↔出乎意料 / 厌恶↔认可），由每轮结束后的「反思」顺带更新，用来让语气随实际发生的事浮动
- **合并候选**：找出内容重复的记忆对，人工确认后并成一条
- **面板**：总览 / 记忆 / 笔记 / 检索 / 整理 五个标签页

## 安装

**前置条件**

- DSH（DeepSeek Harness）桌面版
- Node.js 18 以上（插件用了 `node:sqlite`）
- 知道你的 DSH 数据目录，下文记作 `DSH_HOME`（Windows 上通常是 `…\DSH\home`；也可以设环境变量 `DSH_HOME`）

> ⚠️ **装之前先看最上方的「成本提示」**——默认配置会让每轮对话的 token 开销翻倍，介意就先把它关掉再装。

**步骤**

```powershell
# 1) 装依赖并构建
npm install
npm run build

# 2) 装进指定 profile（把 <DSH_HOME> 与 profile 名换成你自己的）
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DshHome "<DSH_HOME>" -Profile desktop

# 3) 重启该 profile 的 DSH 实例
```

**卸载**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -DshHome "<DSH_HOME>" -Profile desktop
```

安装脚本不会写死任何路径：不传 `-DshHome` 时读环境变量 `DSH_HOME`，两者都没有就直接报错退出。卸载只摘掉插件登记与链接，**不动记忆库**。

**装完的样子**：左侧栏多一个入口（默认文字「小毛病」，可改，见下），工具列表多 12 个 `memory_*`，数据落在 `<DSH_HOME>/storages/maobing-memory/`。

## 配置

在 profile 的 `cordis.patch.yml` 里给本插件加 `config:` 即可：

```yaml
- id: maobing-memory
  name: "maobing-memory"
  config:
    sidebarLabel: "记忆"      # 侧栏显示文字，默认「小毛病」，改完刷新页面生效
    reflect: false            # 关掉反思轮（见下方「成本提示」）
    dreamAt: "22:00"          # 每日整理时间
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `sidebarLabel` | `小毛病` | 侧栏图标显示文字，最长 24 字；纯显示，不影响功能 |
| `injectEnabled` | `true` | 是否注入（首轮快照 + 每轮命中） |
| `reflect` | `true` | 反思轮：每轮结束让模型回顾本轮、顺带写记忆与情绪 |
| `recallTopK` | `3` | 每轮注入**全文**的条数 |
| `recallIndexLimit` | `8` | 每轮额外注入**一行索引**的条数（`0` = 关掉混合注入） |
| `dreamAt` | `22:00` | 每日整理时间（24 小时制） |
| `dbPath` | 自动 | 自定义记忆库路径（一般不用设） |

（默认配置下每轮会多花一个模型回合，见最上方的成本提示。）

**关于注入宽度**：默认是「省档」——3 条给全文、8 条只给一行索引（`#id [项目] 标签… ｜ 判断句开头…`）。索引的作用是让模型知道「库里还有这些」，需要细节它会自己 `memory_read` 去读。

| 档位 | 配置 | 每轮注入 | 适用 |
|---|---|---|---|
| 省（默认） | `recallTopK: 3` `recallIndexLimit: 8` | 约 1300 字 | 日常 |
| 全 | `recallTopK: 5` `recallIndexLimit: 20` | 约 2800 字 | 记忆很多、问题很杂时 |

## 工具（12 个）

| 记忆 | 笔记 |
|---|---|
| `memory_remember` 写一条 | `memory_note_write` 写一篇 |
| `memory_search` BM25 检索（可筛项目/状态/类型） | `memory_note_search` BM25 检索 |
| `memory_read` 按 id 读全文 | `memory_note_read` 按行分页读 |
| `memory_update` 改字段 / 归档 / 恢复 | `memory_note_update` 追加 / 替换 / 整体重写 |
| `memory_recent` 最近 N 条 | |
| `memory_project` 一次取回整项目 | |
| `memory_find_similar` 给一条找相似（查重） | |
| `memory_dream` 手动整理（可 dry-run） | |

## 数据位置

```
<DSH_HOME>/storages/maobing-memory/memory.db              记忆库（SQLite，WAL）
<DSH_HOME>/storages/maobing-memory/notes/<id>-<标题>.md    笔记正文
<DSH_HOME>/storages/maobing-memory/maobing-memory.log     插件日志（2MB 滚动）
```

卸载插件**不会**删这些文件；要清就手工删。

## 记忆长什么样

```
判断句：DSH 的 plugin_manager 启停插件不会刷新模块缓存，改代码后必须重启
依据：  2026-10-28 连续三轮改代码后 disable→enable，行为一模一样
标签：  plugin_manager / 模块缓存 / 必须重启 / 改了没生效
项目：  dsh     类型：skill     重要性：4
```

注入到对话里是这样的（独立消息，不改写系统提示词）：

```
===== 长期记忆（maobing-memory）=====
共 553 条记忆，按项目分组（每项最多 8 条）：
【dsh】41 条
- #1109 [skill] 主 harness 的 host 插件代码改动不会被热重载…

【笔记索引（要全文用 memory_note_read，要检索用 memory_note_search）】
#2 maobing-memory 运维手册（7777 字）
#1 maobing-memory 开发实录（4186 字）

【情绪】喜0.57 怒0.43 惊0.37 厌0.53
```

第二轮起只带本轮相关的（**前 3 条全文 + 8 条索引**）：

```
可能相关的记忆，仅供参考：
- #1105 [knowledge] 用户拍板的规格…（BM25 31.86，标签 +4）
- #1104 [knowledge] maobing-memory 已转为可分发…（BM25 18.2）
- #1137 [skill] 召回宽度问题与修法…（BM25 15.9）

【其他可能相关（只给索引，需要细节用 memory_read 读全文）】
#1074 [meow-memory] meow-memory 已卸载 / 归档 archive / 库改名 _removed ｜ meow-memory 与它的查看面板…
#944 [meow-panel] 给 meow-memory 自建的左侧栏面板插件…

（上面只是线索。若这些都不足以回答，用 memory_search 自己再搜一次，别凭印象编。）

【情绪】喜0.57 怒0.43 惊0.37 厌0.53
```

## 面板

| 标签页 | 内容 |
|---|---|
| 总览 | 统计卡 / 当前情绪（四根进度条）/ 插件日志（最近 12 行）/ 项目分布 / 最近更新 |
| 记忆 | 项目筛选、状态筛选、每页 50·100·200、多选批量归档恢复、合并候选、详情抽屉 |
| 笔记 | 列表 + 阅读抽屉（按行分页，「读下一段」） |
| 检索 | BM25 结果带可验算等式：`总分 = (bm25 + 标签) × 重要 × 强度 × 新鲜度` |
| 整理 | 每日定时自动 + 手动触发 + 整理日志 |

## 已知限制

- **反思轮有成本**：默认每轮多一个极短模型回合，单轮开销约为普通对话两倍（可关）
- **面板能改字段，但不做界面级校验**：判断句/依据/标签/项目/类型/重要性都能在详情抽屉里改，但类型与重要性只做下拉选择，不做语义检查
- **没有被动共鸣**：情绪只由当前对话决定，不随召回的旧记忆牵引
- **检索只有 BM25**：不做向量检索，同义不同词可能搜不到（靠标签和索引缓解，不根治）
- **跨版本兼容性未充分验证**：见下节

## 兼容性

| DSH 版本 | 状态 |
|---|---|
| **0.2.1-alpha.1**（Windows 桌面版） | ✅ 开发与日常使用均在此版本，插件加载、12 个工具、面板、反思轮、注入全部实测通过 |
| 0.2.1-rc.3 | ⚠️ **未实测加载**。安装/卸载脚本在该版本的隔离 profile 上跑通（链接与 patch 正确、卸载完全还原），但「插件被真正加载」这一步没验 |

依赖的宿主能力：`ctx.tools.register`、`ctx.slots.register/inject`、`agent/pre-step`、`agent/turn-stopping`、`session/event`、`ctx.inject(['webServer'])`。若你的 DSH 版本改了这些扩展点，插件可能装上了但不工作——届时看插件日志（`maobing-memory.log`）第一行有没有「启动：版本 …」即可判断。

## 许可

**GNU General Public License v3.0**，全文见 [LICENSE](LICENSE)。

选它的原因：记忆模型与情绪四轴的设计参考了同样采用 GPL v3 的 [angel_memory](https://github.com/kawayiYokami/astrbot_plugin_angel_memory)。代码全部自写、未复制（两者平台、语言、运行时都不同），但采用相同许可可以从根上免除争议。第三方来源与实现差异详见 [NOTICE.md](NOTICE.md)。

对你的影响：自己用不分发 → 无额外义务；一旦分发（发 tgz / 传仓库 / 塞进产品）→ 需附源码与同样的许可。作者本人是版权所有者，不受自己这份许可约束。

## 开发

```powershell
npm install            # 装 esbuild / typescript
npm run build          # 构建 → lib/
npm run pack           # 打包 → dist/maobing-memory-<版本>.tgz
node scripts/smoke.mjs # 冒烟测试（116 项，不启动 DSH）

# 从 meow-memory 迁移历史记忆（可选；必须给 --src，加 --go 才真写库）
node scripts/migrate-from-meow.mjs --src "<meow 的 memory.db 路径>"
node scripts/migrate-from-meow.mjs --src "<...>" --go
```

目录结构：

```
src/index.ts    host：配置、开库、12 个工具、注入、反思轮、路由
src/db.ts       存储：schema、CRUD、分页、统计
src/bm25.ts     BM25 检索（中文逐字 / 英文分词 + 标签加权 + 时间衰减）
src/inject.ts   注入文本构建（快照 / 命中）+ 插件消息构造
src/mood.ts     情绪四轴：弹性逼近、按时间回中、一行格式化
src/merge.ts    合并候选：Jaccard 相似度 + 实体过滤 + 合并
src/notes.ts    笔记：文件读写、按行分页、append/replace
src/logger.ts   文件日志（同步追加、2MB 滚动、写失败静默）
src/client.ts   面板：侧栏图标 + 整页仪表盘 + 情绪/日志卡
build.mjs       esbuild 出 lib/index.js 与 lib/client.js
scripts/        smoke.mjs / pack.mjs / install.ps1 / uninstall.ps1 / migrate-from-meow.mjs
```

⚠️ `scripts/*.ps1` 必须保持 **UTF-8 带 BOM + CRLF**，否则 Windows PowerShell 5.1 会按 GBK 读中文导致语法报错。
