/**
 * dsh-maobing-memory — host 端（DSH 插件宿主侧）。
 *
 * 这个文件只做「接线」：读配置 → 开库 → 注册 12 个工具 → 注册 17 条面板路由
 * → 挂注入钩子（首轮快照 + 每轮 BM25 命中）→ 挂反思轮（每 N 轮一次）→ 起每日整理调度。
 * 真正的算法都在同目录的独立模块里（db / bm25 / inject / mood / notes / merge / dream / logger），
 * 所以它很长但并不复杂。**要读懂结构，看下面这些 `── ` 分区注释即可：**
 *
 *   ── 配置（schema / DEFAULTS / resolveConfig）
 *   ── 工具注册 1~12（写 / 找 / 读 / 改 四组）
 *   ── 面板数据路由 `/maobing-memory/*`（按 pathname 匹配，**不校验 HTTP 方法**）
 *   ── 注入：首轮快照 + 每轮 BM25 命中
 *   ── 笔记工具（正文落 Markdown 文件，库里只存索引）
 *   ── 记忆读取 / 修改工具
 *   ── 反思轮（每 N 轮回顾一次：模型自己调工具写记忆 + 最后输出一行情绪）
 *   ── 每日整理（默认 22:00，衰减 → 归档，不删）
 *
 * 为什么不拆成多个文件：见 TODO 的 P2「拆分大文件」。要点是——长的是「注册动作」而不是逻辑，
 * 拆的收益只是好看，成本是冒烟里 4 处按**文件路径**抓源码的断言必须同步改，否则会变成假绿。
 */
import z from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { defaultDbPath, getById, insertMemory, listActive, listPage, markRecalled, openDb, recentMemories, setMemoryStatus, statsOf, updateMemory, type ListStatus, type MemoryRow } from './db.js'
import { rareTokenIdf, sanitizeQuery, search, tokenize } from './bm25.js'
import { decayAndArchive, lastDreamInfo, startDreamScheduler, type DecayResult } from './dream.js'
import { buildHits, buildSnapshot, createPluginMessage, effectiveMinScore, toDocs } from './inject.js'
import { deleteNote, listNotes, noteDocs, notesDir, readNote, syncNotesFromDisk, updateNote, writeNote, type NoteUpdatePatch } from './notes.js'
import { approach, decayedMood, formatMoodLine, writeMood } from './mood.js'
import { createLogger, type Logger } from './logger.js'
import { findMergeCandidates, mergeMemories } from './merge.js'

/** 摘要取命中词附近的一段，而不是永远从正文开头截。 */
function snippetAround(text: string, query: string, len = 120): string {
  const flat = text.replace(/\s+/g, ' ')
  const tokens = query.toLowerCase().match(/[\u4e00-\u9fff]|[a-z0-9_]+/g) ?? []
  let pos = -1
  for (const t of tokens) {
    const i = flat.toLowerCase().indexOf(t)
    if (i >= 0 && (pos < 0 || i < pos)) pos = i
  }
  if (pos < 0) return flat.slice(0, len)
  const start = Math.max(0, pos - 30)
  return (start > 0 ? '…' : '') + flat.slice(start, start + len)
}

/** 构建标记：用来确认运行时到底加载的是哪一版（排查「改了没生效」用）。
 *  2026-10-31 换过一次：之前的 `mood-v3-…` 是情绪那一版留下的，改了几轮都没动它，
 *  结果日志里的「启动：版本 …」分不出新旧构建。以后每次发版/结构性改动都要改这里。 */
const BUILD_TAG = 'v0.1.1-2026-11-10'

/** 模块级 logger：apply 里换成本插件自己的文件日志；未初始化前是空实现，绝不抛错。 */
let log: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  path: '',
}

export const name = 'dsh-maobing-memory'

/**
 * 实际注册的只读/操作路由（不含 `/maobing-memory/` 前缀）。
 * 用途：启动日志打印真实清单；冒烟会拿它跟源码里的 `url.pathname === …` 逐条比对，
 * 少写或多写都会让测试失败，防止清单再次和实现漂移（之前就写死过一份旧清单）。
 */
export const HTTP_ROUTES = [
  'stats',
  'list',
  'mark',
  'mark-batch',
  'search',
  'mood',
  'log',
  'notes',
  'note',
  'note-delete',
  'merge-candidates',
  'merge',
  'update',
  'ui-config',
  'dream-log',
  'dream',
] as const

export const inject = ['tools']

export const config = z.object({
  /** 总开关。 */
  enabled: z.boolean().default(true),
  /** 数据库位置（默认 <DSH_HOME>/storages/maobing-memory/memory.db）。 */
  dbPath: z.string().required(false),
  /** 是否开启注入（首轮快照 + 每轮命中）。 */
  injectEnabled: z.boolean().default(true),
  /** 反思轮：每轮结束后让主模型回顾本轮并自报记忆与情绪。 */
  reflect: z.boolean().default(true),
  /**
   * 反思轮频率：每 N 轮**真实对话**排一次反思（默认 3；1 = 每轮都排，旧行为）。
   *
   * 为什么要这个：每轮排一次时，单轮 token 开销约翻倍，而且**记忆碎片化**——每轮只看
   * 一小段对话，同一件事分两三轮回写成两三条，之后就变成重复条目。
   */
  reflectEveryN: z.number().min(1).max(50).default(3),
  /**
   * 每轮注入的最低总分（默认 6；0 = 不过滤）。
   *
   * 总分 =（BM25 + 标签）× 重要 × 强度 × 新鲜度，换算关系见 `effectiveMinScore`：
   * 500 条库里「命中一个稀有词」大概就是 6 分，低于它基本都是撞上了「记忆/插件」这类通用词。
   */
  hitMinScore: z.number().min(0).max(50).default(6),
  /** 每轮**给全文**的命中条数（默认 3，即「省档」；调大覆盖更全但更贵）。 */
  recallTopK: z.number().min(0).max(10).default(3),
  /** 每轮额外给**一行索引**的条数（默认 8；设为 0 等于关掉混合注入）。 */
  recallIndexLimit: z.number().min(0).max(50).default(8),
  /** 每日整理时间（HH:MM，24 小时制，默认 22:00）。`dreamAuto: false` 时不用它。 */
  dreamAt: z.string().default('22:00'),
  /**
   * 是否**自动**每日整理（默认 true）。
   *
   * 关掉之后就只剩手动：面板「整理」tab 的「立即整理一次」按钮 + `memory_dream` 工具。
   * 为什么要有这个开关（2026-11-10 用户要求）：整理是**纯本地 SQL**（不花 token），但「后台定时器」
   * 本身是看不见的自动动作，而且它只在宿主活着且恰好到点那一分钟才生效（关机/休眠就漏跑）。
   * 对不常开机的 PC 来说，手动点一次更可控。关掉后启动日志会写「已禁用（手动整理）」+ 上次整理日期，
   * 面板也会显示「已 N 天未整理」，不会因为忘了而让库无限膨胀。
   */
  dreamAuto: z.boolean().default(true),
  /**
   * 侧栏图标的显示文字。
   * 默认「小毛病」是作者用的人格名，别人装可以改成自己喜欢的（比如「记忆」「Memory」）。
   * 改完刷新页面生效。
   */
  sidebarLabel: z.string().default('小毛病'),
})

Object.assign(config.meta, { volatile: true })

interface ToolBlock {
  type: 'text'
  text: string
}

function text(t: string): ToolBlock[] {
  return [{ type: 'text', text: t }]
}

interface ResolvedConfig {
  enabled: boolean
  dbPath?: string
  injectEnabled: boolean
  reflect: boolean
  reflectEveryN: number
  hitMinScore: number
  recallTopK: number
  recallIndexLimit: number
  dreamAt: string
  dreamAuto: boolean
  sidebarLabel: string
}

const DEFAULTS: ResolvedConfig = {
  enabled: true,
  injectEnabled: true,
  reflect: true,
  reflectEveryN: 3,
  hitMinScore: 6,
  recallTopK: 3,
  recallIndexLimit: 8,
  dreamAt: '22:00',
  dreamAuto: true,
  sidebarLabel: '小毛病',
}

/** 宿主传进来的 config 是「解析后的值」；缺字段一律回落到出厂默认。 */
function resolveConfig(raw: unknown): ResolvedConfig {
  const src = (raw ?? {}) as Partial<ResolvedConfig>
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULTS.enabled,
    dbPath: typeof src.dbPath === 'string' && src.dbPath.trim() ? src.dbPath.trim() : undefined,
    injectEnabled: typeof src.injectEnabled === 'boolean' ? src.injectEnabled : DEFAULTS.injectEnabled,
    reflect: typeof src.reflect === 'boolean' ? src.reflect : DEFAULTS.reflect,
    // 夹取在 resolveConfig 也做一遍：宿主没跑 schema 校验时（冒烟直接调 apply({})）也不能出现 0 或 NaN
    reflectEveryN:
      typeof src.reflectEveryN === 'number' && Number.isFinite(src.reflectEveryN)
        ? Math.min(50, Math.max(1, Math.round(src.reflectEveryN)))
        : DEFAULTS.reflectEveryN,
    hitMinScore:
      typeof src.hitMinScore === 'number' && Number.isFinite(src.hitMinScore)
        ? Math.min(50, Math.max(0, src.hitMinScore))
        : DEFAULTS.hitMinScore,
    recallTopK: typeof src.recallTopK === 'number' ? src.recallTopK : DEFAULTS.recallTopK,
    recallIndexLimit:
      typeof src.recallIndexLimit === 'number' ? src.recallIndexLimit : DEFAULTS.recallIndexLimit,
    dreamAt: typeof src.dreamAt === 'string' && src.dreamAt.trim() ? src.dreamAt.trim() : DEFAULTS.dreamAt,
    dreamAuto: typeof src.dreamAuto === 'boolean' ? src.dreamAuto : DEFAULTS.dreamAuto,
    sidebarLabel:
      typeof src.sidebarLabel === 'string' && src.sidebarLabel.trim() ? src.sidebarLabel.trim().slice(0, 24) : DEFAULTS.sidebarLabel,
  }
}

export async function apply(ctx: any, rawConfig: unknown): Promise<void> {
  const cfg = resolveConfig(rawConfig)
  if (!cfg.enabled) {
    log.info('[dsh-maobing-memory] disabled by config')
    return
  }

  const path = cfg.dbPath ?? defaultDbPath()
  const db = openDb(path)
  log = createLogger(dirname(path))
  const stat = statsOf(db)
  log.info(`启动：版本 ${BUILD_TAG}，库 ${path}`)
  log.info(
    `就绪：工具 12 个，记忆 ${stat.total}（活跃 ${stat.active} / 归档 ${stat.archived}），` +
      `注入=${cfg.injectEnabled ? `on(总分≥${cfg.hitMinScore})` : 'off'}，` +
      `反思=${cfg.reflect ? `on(每${cfg.reflectEveryN}轮)` : 'off'}，整理 ${cfg.dreamAuto ? cfg.dreamAt : '手动'}`,
  )

  // ── 工具注册 ──────────────────────────────────────────────────────────────
  //
  // 一共 12 个，分四组，分组逻辑是「模型在这一步想干什么」：
  //   写：remember / note_write        —— 记下新东西
  //   找：search / recent / project / find_similar / note_search
  //                                    —— 不确定是哪条时先找（find_similar 专门用来查重）
  //   读：read / note_read             —— 已经知道 id，要全文
  //   改：update / note_update / dream —— 修正、归档、整理
  //
  // 为什么工具要自己实现而不是让模型直接读写 SQLite：
  // ① 写库要保证 uid 去重、tags 合法 JSON、强度/重要性夹取，散在每个调用点会漏；
  // ② 检索要走 BM25 + 标签 + 强度加权，模型手搓 SQL 得不到一样的排序；
  // ③ 每个工具的输出都必须过 `output.render` 返回 ContentBlock[]（宿主 PTC 路径会对
  //    result.content 调 .some()，返回字符串会直接抛 "content.some is not a function"）。
  //
  // 【将来拆到 tools.ts 的缝】这一组（含下面笔记 4 个、记忆读写 5 个）只依赖 `db / cfg / log`
  // 与 `notesDir(path)`，**不碰任何 session 状态**，是最干净的一刀：
  //   export function registerTools(ctx, deps: { db, cfg, log, notesDir }): Array<() => void>
  // 注意两点：a) 每个 register 都返回 dispose，现在靠文件末尾统一调用，拆了要把返回数组传回去；
  //           b) 工具描述是模型可见文案，搬的时候别顺手改写（有冒烟断言盯着 set 里的名字）。

  // ── 工具 1：写入一条记忆 ────────────────────────────────────────────────
  const disposeRemember = ctx.tools.register({
    name: 'memory_remember',
    description:
      '写入一条长期记忆：判断句（judgment）+ 依据（reasoning）+ 检索标签（tags）+ 项目（project）。' +
      '判断句要独立、清楚、可检索；依据只写理由与来源；标签写 8~13 个锚点词。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['judgment', 'project', 'tags'],
      properties: {
        judgment: { type: 'string', description: '记忆本体：一句独立、可检索的判断句。' },
        reasoning: { type: 'string', description: '依据/背景/来源，可为空。' },
        tags: { type: 'array', items: { type: 'string' }, description: '检索锚点，8~13 个。' },
        project: { type: 'string', description: '所属项目；全局信息填「全局」。' },
        type: {
          type: 'string',
          enum: ['knowledge', 'event', 'skill', 'task', 'emotion'],
          default: 'knowledge',
          description: '记忆类型。',
        },
        importance: { type: 'integer', default: 2, description: '重要性 1~4，决定初始强度。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'number' },
          project: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: any) =>
        text(
          value?.ok
            ? `✅ 已记下 #${value.id}（项目：${value.project}｜标签：${(value.tags ?? []).join(' / ')}）`
            : '❌ 写入失败',
        ),
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as Record<string, unknown>
      const judgment = typeof a.judgment === 'string' ? a.judgment.trim() : ''
      if (!judgment) throw new Error('memory_remember: judgment 不能为空')
      const project = typeof a.project === 'string' && a.project.trim() ? a.project.trim() : '全局'
      const tags = Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === 'string').slice(0, 13) : []
      if (tags.length === 0) throw new Error('memory_remember: tags 至少给 1 个（建议 8~13 个）')
      const row: MemoryRow = insertMemory(db, {
        judgment,
        reasoning: typeof a.reasoning === 'string' ? a.reasoning : '',
        tags,
        project,
        type: typeof a.type === 'string' ? a.type : 'knowledge',
        importance: typeof a.importance === 'number' ? a.importance : 2,
      })
      return { ok: true, id: row.id, project: row.project, tags }
    },
  })

  // ── 工具 2：看最近记忆 ──────────────────────────────────────────────────
  const disposeRecent = ctx.tools.register({
    name: 'memory_recent',
    description: '按更新时间倒序列出最近的记忆（只排序、不做检索；要按关键词找用 memory_search）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', default: 5, description: '条数 1~50。' },
        project: { type: 'string', description: '只看某个项目。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count'],
        properties: {
          count: { type: 'number' },
          lines: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: any) =>
        text(
          value?.count === 0
            ? '（还没有任何记忆）'
            : `最近 ${value.count} 条：\n` + (value.lines ?? []).map((l: string) => `- ${l}`).join('\n'),
        ),
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as { limit?: number; project?: string }
      const rows = recentMemories(db, { limit: a.limit, project: a.project })
      return {
        count: rows.length,
        lines: rows.map(
          (r) => `#${r.id} [${r.type}] ${r.judgment.slice(0, 80)}｜项目：${r.project}｜强度 ${r.strength.toFixed(2)}`,
        ),
      }
    },
  })

  // ── 面板数据路由（只读，前缀 /maobing-memory）──────────────────────────
  //
  // 【将来拆到 routes.ts 的缝 —— 这是**最该先拆**的一段】
  //  - 依赖只有 `db / cfg / log / path`，不碰 session、不碰注入状态，纯函数边界；
  //  - 建议签名：`export function installRoutes(webServer, deps): () => void`（现在的
  //    routeDisposers 数组就是那个返回值）；
  //  - ⚠️ 路径字符串 `/maobing-memory/xxx` 是前端契约：client.ts 的 ROUTE_PREFIX、冒烟里的
  //    「client 前缀 == host 路由」对账都盯着它——搬走时一个字符都别改；
  //  - ⚠️ 这里**不校验 HTTP 方法**，且有副作用的路由（update / mark / merge / note-delete /
  //    dream?go=1）也走 GET，原因和代价见文件头注释；搬走时保持原样，别顺手改语义。
  const routeDisposers: Array<() => void> = []
  const installRoutes = (webServer: any): void => {
    try {
      if (webServer !== undefined && typeof webServer.register === 'function') {
      const json = (res: any, status: number, body: unknown): void => {
        const text = JSON.stringify(body)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(text)
      }
      routeDisposers.push(
        webServer.register({
          kind: 'prefix',
          path: '/maobing-memory',
          handler: (req: any, res: any) => {
            let url: URL
            try {
              url = new URL(req.url ?? '/', 'http://localhost')
            } catch {
              return json(res, 400, { error: 'bad url' })
            }
            try {
              if (url.pathname === '/maobing-memory/stats') return json(res, 200, statsOf(db))
              if (url.pathname === '/maobing-memory/list') {
                const raw = url.searchParams.get('status') ?? 'active'
                const status: ListStatus = raw === 'archived' || raw === 'all' ? raw : 'active'
                const project = url.searchParams.get('project') ?? undefined
                const limit = Number(url.searchParams.get('limit') ?? 200)
                const offset = Number(url.searchParams.get('offset') ?? 0)
                return json(res, 200, listPage(db, { status, project, limit, offset }))
              }
              if (url.pathname === '/maobing-memory/mark') {
                const id = Number(url.searchParams.get('id') ?? 0)
                const want = url.searchParams.get('status')
                if (!Number.isFinite(id) || id <= 0 || (want !== 'active' && want !== 'archived')) {
                  return json(res, 400, { error: 'need id and status=active|archived' })
                }
                const ok = setMemoryStatus(db, id, want)
                log.info(`[dsh-maobing-memory] 状态变更：${want === 'active' ? '恢复' : '归档'} #${id} → ${ok}`)
                return json(res, 200, { ok, id, status: want })
              }
              if (url.pathname === '/maobing-memory/search') {
                const q = url.searchParams.get('q') ?? ''
                const k = Math.min(30, Math.max(1, Number(url.searchParams.get('k') ?? 10)))
                const rows = listActive(db)
                const hits = search(q, toDocs(rows), { k })
                const byId = new Map(rows.map((r) => [r.id, r]))
                return json(res, 200, {
                  hits: hits.map((h) => ({
                    id: h.id,
                    judgment: byId.get(h.id)?.judgment ?? '',
                    project: byId.get(h.id)?.project ?? '',
                    type: byId.get(h.id)?.type ?? '',
                    score: Math.round(h.score * 1000) / 1000,
                    detail: h.detail,
                  })),
                })
              }
              if (url.pathname === '/maobing-memory/merge-candidates') {
                const threshold = Number(url.searchParams.get('threshold') ?? 0.55)
                const limit = Number(url.searchParams.get('limit') ?? 40)
                const project = url.searchParams.get('project') ?? undefined
                const list = findMergeCandidates(db, { threshold, limit, project })
                return json(res, 200, { count: list.length, threshold, candidates: list })
              }
              if (url.pathname === '/maobing-memory/merge') {
                const keep = Number(url.searchParams.get('keep') ?? 0)
                const drop = Number(url.searchParams.get('drop') ?? 0)
                if (!Number.isFinite(keep) || !Number.isFinite(drop) || keep <= 0 || drop <= 0) {
                  return json(res, 400, { error: 'need keep=<id>&drop=<id>' })
                }
                const r = mergeMemories(db, keep, drop)
                log.info(`合并：#${drop} → #${keep}`)
                return json(res, 200, r)
              }
              if (url.pathname === '/maobing-memory/update') {
                // 面板上直接改一条记忆（judgment / reasoning / tags / project / type / importance）
                const id = Number(url.searchParams.get('id') ?? 0)
                if (!Number.isFinite(id) || id <= 0) return json(res, 400, { error: 'need id' })
                const patch: Record<string, unknown> = {}
                const j = url.searchParams.get('judgment')
                if (j !== null && j.trim() !== '') patch.judgment = j.trim()
                const rs = url.searchParams.get('reasoning')
                if (rs !== null) patch.reasoning = rs
                const tg = url.searchParams.get('tags')
                if (tg !== null) {
                  try {
                    const v: unknown = JSON.parse(tg)
                    if (Array.isArray(v)) patch.tags = v.filter((x): x is string => typeof x === 'string').slice(0, 13)
                  } catch {
                    return json(res, 400, { error: 'tags 必须是 JSON 字符串数组' })
                  }
                }
                const pj = url.searchParams.get('project')
                if (pj !== null && pj.trim() !== '') patch.project = pj.trim()
                const ty = url.searchParams.get('type')
                if (ty !== null && MEMORY_TYPES_LIST.includes(ty)) patch.type = ty
                const im = url.searchParams.get('importance')
                if (im !== null && Number.isFinite(Number(im))) patch.importance = Math.min(4, Math.max(1, Number(im)))
                if (Object.keys(patch).length === 0) return json(res, 400, { error: '没有要改的字段' })
                const row = updateMemory(db, id, patch as never)
                if (!row) return json(res, 404, { error: 'not found' })
                try {
                  db.prepare('INSERT INTO dream_log (run_at, action, memory_id, note) VALUES (?, ?, ?, ?)').run(
                    Date.now(),
                    'edit',
                    id,
                    `面板修改：${Object.keys(patch).join(',')}`,
                  )
                } catch {
                  /* 留痕失败不影响结果 */
                }
                log.info(`面板修改记忆 #${id}：${Object.keys(patch).join(',')}`)
                return json(res, 200, {
                  ok: true,
                  id: row.id,
                  judgment: row.judgment,
                  reasoning: row.reasoning,
                  project: row.project,
                  type: row.type,
                  importance: row.importance,
                  tags: row.tags,
                })
              }
              if (url.pathname === '/maobing-memory/log') {
                const n = Math.min(2000, Math.max(1, Number(url.searchParams.get('lines') ?? 200)))
                try {
                  const text = readFileSync(log.path, 'utf8')
                  const arr = text.split('\n').filter((x) => x !== '')
                  return json(res, 200, { path: log.path, lines: arr.length, tail: arr.slice(-n) })
                } catch (e) {
                  return json(res, 200, { path: log.path, lines: 0, tail: [], note: e instanceof Error ? e.message : String(e) })
                }
              }
              if (url.pathname === '/maobing-memory/ui-config') {
                return json(res, 200, { label: cfg.sidebarLabel })
              }
              if (url.pathname === '/maobing-memory/mood') {
                return json(res, 200, decayedMood(db))
              }
              if (url.pathname === '/maobing-memory/notes') {
                const limit = Number(url.searchParams.get('limit') ?? 50)
                const offset = Number(url.searchParams.get('offset') ?? 0)
                return json(res, 200, listNotes(db, dir, { limit, offset }))
              }
              if (url.pathname === '/maobing-memory/mark-batch') {
                const ids = (url.searchParams.get('ids') ?? '')
                  .split(',')
                  .map((x) => Number(x.trim()))
                  .filter((n) => Number.isFinite(n) && n > 0)
                const want = url.searchParams.get('status')
                if (ids.length === 0 || (want !== 'active' && want !== 'archived')) {
                  return json(res, 400, { error: 'need ids=1,2,3 and status=active|archived' })
                }
                const stmt = db.prepare('UPDATE memory SET status = ?, updated_at = ? WHERE id = ?')
                const now = Date.now()
                let updated = 0
                for (const id of ids) updated += Number(stmt.run(want, now, id).changes)
                log.info(`[dsh-maobing-memory] 批量${want === 'active' ? '恢复' : '归档'}：${updated}/${ids.length}`)
                return json(res, 200, { ok: true, updated, requested: ids.length, status: want })
              }
              if (url.pathname === '/maobing-memory/note') {
                const id = Number(url.searchParams.get('id') ?? 0)
                const offset = Number(url.searchParams.get('offset') ?? 1)
                const limit = Number(url.searchParams.get('limit') ?? 800)
                return json(res, 200, readNote(db, dir, id, { offset, limit }))
              }
              if (url.pathname === '/maobing-memory/note-delete') {
                const id = Number(url.searchParams.get('id') ?? 0)
                return json(res, 200, { ok: deleteNote(db, dir, id), id })
              }
              if (url.pathname === '/maobing-memory/dream-log') {
                const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)))
                const rows = db.prepare('SELECT * FROM dream_log ORDER BY id DESC LIMIT ?').all(limit)
                // 面板「整理」tab 要用这三个字段显示「自动/手动 + 上次整理距今几天」
                const info = lastDreamInfo(db)
                return json(res, 200, {
                  rows,
                  dreamAuto: cfg.dreamAuto,
                  dreamAt: cfg.dreamAt,
                  lastDreamDay: info.day,
                  daysSinceDream: info.days,
                })
              }
              if (url.pathname === '/maobing-memory/dream') {
                // 不带 go=1 就是空跑：完整算一遍并告诉你会发生什么，但不写库。
                const go = url.searchParams.get('go') === '1'
                const r = decayAndArchive(db, { dryRun: !go })
                if (go) {
                  log.info(`[dsh-maobing-memory] 手动整理：衰减 ${r.decayed}，归档 ${r.archived}`)
                } else {
                  log.info(`[dsh-maobing-memory] 手动整理（空跑）：将衰减 ${r.decayed}，将归档 ${r.archived}`)
                }
                return json(res, 200, {
                  ok: r.ok,
                  dryRun: r.dryRun === true,
                  decayed: r.decayed,
                  archived: r.archived,
                  hint: go ? undefined : '这是空跑结果，没有写库；加 ?go=1 才会真的执行',
                  sample: r.log.slice(0, 5),
                })
              }
              return json(res, 404, { error: 'not found' })
            } catch (e) {
              return json(res, 500, { error: e instanceof Error ? e.message : String(e) })
            }
          },
        }),
      )
      log.info(`[dsh-maobing-memory] routes: ${HTTP_ROUTES.map((r) => `/maobing-memory/${r}`).join(' ')}`)
      } else {
        log.info('[dsh-maobing-memory] webServer.register 不可用，面板数据路由未注册')
      }
    } catch (e) {
      log.warn(`[dsh-maobing-memory] 路由注册失败（面板数据不可用）：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // webServer 可能在 apply 时还没就绪：等它就绪后再挂路由（插件本身不等，工具/注入照常）
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (wctx: any) => {
      installRoutes(wctx.webServer)
      return () => {
        for (const d of routeDisposers.splice(0).reverse()) {
          try {
            d()
          } catch {
            /* 忽略 */
          }
        }
      }
    })
  } else {
    installRoutes((ctx as any).webServer)
  }

  // ── 注入：首轮快照 + 每轮 BM25 命中 ────────────────────────────────────
  //
  // 【将来拆到 inject-hook.ts 的缝，但要和「反思轮」那段**一起**拆】
  //  - 这里持有 session 级状态：firstTurned（首轮只给快照）、injectedBySession（seen 去重）；
  //  - 反思轮那边持有 reflectTurns / reflectCountedTurn / reflectQueuedTurn / reflectCooldown；
  //  - 两段都以 sid 为 key，拆一半会变成「两份 session 状态各自漂移」，所以要么一起搬，
  //    要么干脆不拆（现在的选择）。
  //  - 注入失败一律放行原始消息（记忆层坏掉不能拖垮对话）——这条策略别在搬家时丢掉。
  const firstTurned = new Set<string>()
  const injectedBySession = new Map<string, Set<number>>()

  ctx.on('agent/pre-step', async (payload: any, next: () => Promise<unknown>) => {
    const decision: any = await next()
    if (!cfg.injectEnabled) return decision
    try {
      if (decision === undefined || decision?.kind !== 'enter') return decision
      const messages: any[] = Array.isArray(decision.messages) ? decision.messages : []
      if (messages.length === 0) return decision
      const users = messages.filter((m: any) => m?.source?.kind === 'user')
      if (users.length === 0) return decision

      const sid: string = payload?.agent?.session?.header?.id ?? payload?.agent?.id ?? 'unknown'
      const rows = listActive(db)
      if (rows.length === 0) return decision

        // ── 首轮：快照 + 笔记索引 + 情绪行，合成一条 plugin 消息插在用户消息之前 ──
        //
        // 为什么三样东西拼在一条消息里：
        // ① 都是「开局背景」，分开发等于三条独立消息，占用更多轮次边界；
        // ② 都只在首轮给一次，第二轮的 pre-step 会走下面的「命中」分支；
        // ③ 走 createPluginMessage 而不是改写 system prompt —— 系统提示词变了会让
        //    宿主的 prompt 缓存整段失效，代价远大于这一点信息量。
        //
        // 笔记索引为什么必须有：库里存着几千字的长笔记，但注入里若一个字都不提，
        // 模型根本不知道它们存在，于是永远想不起来 memory_note_read（2026-10-31 实测引用率极低）。
        if (!firstTurned.has(sid)) {
        firstTurned.add(sid)
        const snapshot = buildSnapshot(rows, { perProject: 8, maxTotal: 40 })
        if (snapshot === null) return decision
        const moodLine = formatMoodLine(decayedMood(db))
        // 笔记索引：只在首轮给一次。没有这段的话，模型根本不知道库里还有笔记，
        // 于是永远不会去 memory_note_search / memory_note_read（实测笔记引用率极低）。
        let noteIndex = ''
        try {
          const noteResult = listNotes(db, notesDir(path), { limit: 10, excerpt: 20 })
          const notes = noteResult.rows
          if (notes.length > 0) {
            noteIndex =
              `\n\n【笔记索引（要全文用 memory_note_read，要检索用 memory_note_search）】\n` +
              notes.map((n) => `#${n.id} ${n.title}（${n.chars} 字）`).join('\n')
          }
        } catch {
          /* 拿不到笔记不影响记忆注入 */
        }
        const text = `${snapshot}${noteIndex}\n\n${moodLine}\n（情绪只用来调整语气，别主动提、别报数字、别说"我现在很生气"。）`
        const rewritten = [...messages]
        rewritten.splice(rewritten.indexOf(users[0]), 0, createPluginMessage(text))
        log.info(
          `[dsh-maobing-memory] snapshot injected sid=${sid.slice(0, 8)} rows=${rows.length} chars=${text.length}`,
        )
        return { ...decision, messages: rewritten }
      }

      const lastUser = users[users.length - 1]
      const query = ((lastUser?.content ?? []) as any[])
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => String(b.text))
        .join(' ')
      if (query.trim().length === 0) return decision

      const seen = injectedBySession.get(sid) ?? new Set<number>()
      injectedBySession.set(sid, seen)
      // ── 第二轮起：BM25 命中，混合注入 ────────────────────────────────────
      //
      // 为什么是「前 k 条全文 + 若干条只给索引」，而不是简单的 top-N 全文：
      // 只给 top-N 时，正确答案排在第 N+1 位就等于不存在（2026-10-31 实测：问
      // 「这个库现在叫什么」，答案排第 4，而 N=3，模型于是去查了 GitHub）。
      // 调大 N 只是把边界往后推，成本却线性上涨；换成索引后，覆盖 11 条只花 1360 字，
      // 而且模型看到索引知道「库里还有这些」，需要细节会自己 memory_read。
      //
      // `seen` 是会话级去重：同一批命中不重复注入，否则连着几轮都是同样几条，白烧 token。
      const hits = buildHits(rows, query, {
        k: cfg.recallTopK,
        indexLimit: cfg.recallIndexLimit,
        seen,
        minScore: cfg.hitMinScore,
      })
      const moodLine = formatMoodLine(decayedMood(db))
      if (hits === null) {
        // 没命中记忆也把情绪带上（它是状态，不是检索结果）
        const rewritten = [...messages]
        rewritten.splice(rewritten.indexOf(lastUser), 0, createPluginMessage(moodLine))
        return { ...decision, messages: rewritten }
      }
      const rewritten = [...messages]
      rewritten.splice(rewritten.indexOf(lastUser), 0, createPluginMessage(`${hits.text}\n\n${moodLine}`))
      for (const id of hits.ids) seen.add(id)
      markRecalled(db, hits.ids, 0.1)
      log.info(`[dsh-maobing-memory] hits injected sid=${sid.slice(0, 8)} n=${hits.ids.length}`)
      return { ...decision, messages: rewritten }
    } catch (e) {
      // 注入失败一律放行原始消息：记忆层坏掉不能拖垮对话。
      log.warn(
        `[dsh-maobing-memory] 注入失败（放行原始消息）：${e instanceof Error ? e.message : String(e)}`,
      )
      return decision
    }
  })

  // ── 笔记工具（长文，正文落 Markdown 文件）──────────────────────────────
  //
  // 【将来拆到 tools.ts 的缝（同一批）】只依赖 `db / log / notesDir(path)`。
  // 拆的时候注意：笔记正文在磁盘上、索引在库里，启动时的 `syncNotesFromDisk` 是**唯一**把
  // 文件重新纳入库的入口（用户手放 md 进目录就靠它），搬家时别把它留在 index.ts 里忘了执行。
  const dir = notesDir(path)
  try {
    const synced = syncNotesFromDisk(db, dir)
    if (synced > 0) log.info(`[dsh-maobing-memory] 笔记目录新纳入 ${synced} 篇`)
  } catch (e) {
    log.warn(`[dsh-maobing-memory] 笔记目录扫描失败：${e instanceof Error ? e.message : String(e)}`)
  }

  const disposeNoteWrite = ctx.tools.register({
    name: 'memory_note_write',
    description:
      '写一篇笔记（长文）：正文存 Markdown 文件，索引进库。适合放整段资料、方案、清单、读书笔记这类"记忆一句话装不下"的内容。' +
      '写完会返回 note_id，之后用 memory_note_read 按 id 读、memory_note_search 按关键词搜。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'body'],
      properties: {
        title: { type: 'string', description: '标题，简短概括主题（会进文件名）。' },
        body: { type: 'string', description: '正文，Markdown 格式，建议用 #/## 分节。' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选：检索标签。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'number' },
          title: { type: 'string' },
          chars: { type: 'number' },
          path: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) =>
        text(v?.ok ? `📝 笔记 #${v.id}《${v.title}》已保存（${v.chars} 字）→ ${v.path}` : '❌ 笔记写入失败'),
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as { title?: unknown; body?: unknown; tags?: unknown }
      const title = typeof a.title === 'string' ? a.title.trim() : ''
      const body = typeof a.body === 'string' ? a.body : ''
      if (!title) throw new Error('memory_note_write: title 不能为空')
      if (!body.trim()) throw new Error('memory_note_write: body 不能为空')
      const tags = Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === 'string') : []
      const row = writeNote(db, dir, { title, body, tags })
      return { ok: true, id: row.id, title: row.title, chars: row.chars, path: row.path }
    },
  })

  const disposeNoteRead = ctx.tools.register({
    name: 'memory_note_read',
    description: '读一篇笔记的正文，按行分页（offset 从 1 开始，limit 默认 400 行）；返回里带 totalLines 与 hasMore，没读完就继续读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'integer', description: '笔记 id（列表/检索结果里的那个数字）。' },
        offset: { type: 'integer', default: 1, description: '起始行（1-based）。' },
        limit: { type: 'integer', default: 400, description: '最多读多少行。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['found'],
        properties: {
          found: { type: 'boolean' },
          title: { type: 'string' },
          text: { type: 'string' },
          totalLines: { type: 'number' },
          offset: { type: 'number' },
          hasMore: { type: 'boolean' },
        },
      },
      render: (_a: unknown, v: any) =>
        v?.found
          ? text(`# ${v.title}\n（第 ${v.offset} 行起，共 ${v.totalLines} 行${v.hasMore ? '，还有更多' : ''}）\n\n${v.text}`)
          : text('未找到该笔记'),
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as { id?: unknown; offset?: unknown; limit?: unknown }
      const id = Number(a.id ?? 0)
      const r = readNote(db, dir, id, {
        offset: Number.isFinite(Number(a.offset)) ? Number(a.offset) : 1,
        limit: Number.isFinite(Number(a.limit)) ? Number(a.limit) : 400,
      })
      if (!r.found) return { found: false }
      return { found: true, title: r.note?.title ?? '', text: r.text ?? '', totalLines: r.totalLines ?? 0, offset: r.offset ?? 1, hasMore: r.hasMore ?? false }
    },
  })

  const disposeNoteSearch = ctx.tools.register({
    name: 'memory_note_search',
    description:
      '按关键词搜笔记（标题 + 正文，BM25）。**遇到资料性/方案性/长文类问题先搜这里**：' +
      '查历史结论、找之前的方案、回忆某件事的细节、用户问「我们之前怎么定的」——都先搜，命中再 memory_note_read 读全文。' +
      '笔记不进每轮注入（省 token），所以这个工具是唯一的入口，别光写不读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '检索词。' },
        k: { type: 'integer', default: 5, description: '返回条数上限。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count'],
        properties: {
          count: { type: 'number' },
          hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_a: unknown, v: any) =>
        text(
          v?.count === 0
            ? '没有命中笔记'
            : (v.hits as Array<{ id: number; title: string; score: number; excerpt: string }>)
                .map((hh) => `#${hh.id}「${hh.title}」(${hh.score.toFixed(2)}) ${hh.excerpt}`)
                .join('\n'),
        ),
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as { query?: unknown; k?: unknown }
      const q = typeof a.query === 'string' ? a.query.trim() : ''
      if (!q) throw new Error('memory_note_search: query 不能为空')
      const k = Math.min(20, Math.max(1, Number(a.k ?? 5)))
      const docs = noteDocs(db, dir).map((n) => ({
        id: n.id,
        text: `${n.title}\n${n.text}`,
        tags: n.tags,
        strength: 1,
        importance: 2,
        updatedAt: n.updatedAt,
      }))
      const hits = search(q, docs, { k })
      const titles = new Map(noteDocs(db, dir).map((n) => [n.id, n.title]))
      return {
        count: hits.length,
        hits: hits.map((hh) => ({
          id: hh.id,
          title: titles.get(hh.id) ?? '',
          score: Math.round(hh.score * 1000) / 1000,
          excerpt: snippetAround(hh.text, q, 120),
        })),
      }
    },
  })

  // ── 记忆读取/修改工具（补齐「能写不能查」的缺口）──────────────────────
  //
  // 【将来拆到 tools.ts 的缝（同一批）】只依赖 `db / log`，是四组工具里最干净的一组。
  // 这组的共同约定：read/search/project 只读；update 既能改字段也能改 status（归档/恢复），
  // **没有物理删除**——归档是唯一的下线方式，别在搬家时"顺手"加个 delete。
  const MEMORY_TYPES_LIST = ['knowledge', 'event', 'skill', 'task', 'emotion']

  const disposeNoteUpdate = ctx.tools.register({
    name: 'memory_note_update',
    description:
      '改一篇笔记（只改传入的字段）：title / tags / append（追加一段）/ replace（替换一段）/ body（整体替换）。' +
      '补内容优先用 append，改错字用 replace，**不要为了加一段就交全文**——' +
      '笔记写错了、要补充、要换标题时用它，不要靠再写一篇新的把旧的晾着。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'integer', description: '笔记 id。' },
        title: { type: 'string', description: '新标题（只改索引，文件名不变）。' },
        body: { type: 'string', description: '新正文（Markdown，**整体替换**——要补内容请用 append）。' },
        append: { type: 'string', description: '追加到正文末尾（Markdown）。补章节用这个，不用交全文。' },
        replace: {
          type: 'object',
          additionalProperties: false,
          required: ['old', 'new'],
          description: '按字面替换正文里的一段（改错字/改某段用这个，不用交全文）。',
          properties: {
            old: { type: 'string', description: '要被替换的原文片段（必须在正文里存在）。' },
            new: { type: 'string', description: '替换成的文字。' },
            all: { type: 'boolean', description: '是否替换全部出现（默认只替换第一处）。' },
          },
        },
        tags: { type: 'array', items: { type: 'string' }, description: '新标签（整体替换）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'number' },
          title: { type: 'string' },
          chars: { type: 'number' },
          changed: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_a: unknown, v: any) =>
        text(v?.ok ? `📝 已更新笔记 #${v.id}《${v.title}》（${v.chars} 字；改动：${(v.changed ?? []).join(' / ') || '无'}）` : '❌ 未找到该笔记，或没有可改的字段'),
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as Record<string, unknown>
      const id = Number(a.id ?? 0)
      const patch: NoteUpdatePatch = {}
      if (typeof a.title === 'string' && a.title.trim()) patch.title = a.title.trim()
      if (typeof a.body === 'string') patch.body = a.body
      if (typeof a.append === 'string' && a.append.trim()) patch.append = a.append
      if (a.replace !== null && typeof a.replace === 'object') {
        const r = a.replace as { old?: unknown; new?: unknown; all?: unknown }
        if (typeof r.old === 'string' && r.old !== '' && typeof r.new === 'string') {
          patch.replace = { old: r.old, new: r.new, all: r.all === true }
        }
      }
      if (Array.isArray(a.tags)) patch.tags = a.tags.filter((t): t is string => typeof t === 'string')
      const changed = Object.keys(patch)
      if (changed.length === 0) throw new Error('memory_note_update: 没有要改的字段')
      const row = updateNote(db, dir, id, patch)
      if (!row) return { ok: false }
      return { ok: true, id: row.id, title: row.title, chars: row.chars, changed }
    },
  })

  const disposeSearch = ctx.tools.register({
    name: 'memory_search',
    description:
      '检索记忆库（BM25：关键词 × 标签 × 重要性 × 强度 × 新鲜度）。**想知道「我们之前怎么定的」「那条关于 XX 的记忆」时用这个**，' +
      '不要靠 memory_recent 一条条翻。返回 id / 判断句 / 项目 / 类型 / 总分；要读全文用 memory_read。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '检索词/句子。' },
        k: { type: 'integer', default: 5, description: '返回条数 1~50。' },
        project: { type: 'string', description: '只看某个项目。' },
        status: { type: 'string', enum: ['active', 'archived', 'all'], default: 'active', description: '状态范围。' },
        type: { type: 'string', enum: MEMORY_TYPES_LIST, description: '只看某种记忆类型。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count'],
        properties: { count: { type: 'number' }, hits: { type: 'array', items: { type: 'object', additionalProperties: true } } },
      },
      render: (_a: unknown, v: any) =>
        text(
          v?.count === 0
            ? '没有命中记忆'
            : (v.hits as Array<{ id: number; judgment: string; project: string; type: string; score: number }>)
                .map((x) => `#${x.id} [${x.type}] (${Number(x.score ?? 0).toFixed(2)}) ${x.judgment.slice(0, 90)}｜${x.project}`)
                .join('\n'),
        ),
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as { query?: unknown; k?: unknown; project?: unknown; status?: unknown; type?: unknown }
      const q = typeof a.query === 'string' ? a.query.trim() : ''
      if (!q) throw new Error('memory_search: query 不能为空')
      const k = Math.min(50, Math.max(1, Number(a.k ?? 5)))
      const raw = String(a.status ?? 'active')
      const status: ListStatus = raw === 'archived' || raw === 'all' ? raw : 'active'
      const project = typeof a.project === 'string' && a.project.trim() ? a.project.trim() : undefined
      let rows = listPage(db, { status, project, limit: 5000 }).rows
      if (typeof a.type === 'string' && MEMORY_TYPES_LIST.includes(a.type)) rows = rows.filter((r) => r.type === a.type)
      const hits = search(q, toDocs(rows), { k })
      return {
        count: hits.length,
        hits: hits.map((h) => {
          const row = rows.find((r) => r.id === h.id)
          return {
            id: h.id,
            judgment: row?.judgment ?? '',
            project: row?.project ?? '',
            type: row?.type ?? '',
            score: Math.round(h.score * 1000) / 1000,
            detail: h.detail,
          }
        }),
      }
    },
  })

  const disposeRead = ctx.tools.register({
    name: 'memory_read',
    description: '按 id 读一条记忆的完整内容（判断句、依据、标签、项目、强度、状态、时间）。看到注入或检索结果里的 id 想看全貌时用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: { id: { type: 'integer', description: '记忆 id。' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['found'],
        properties: {
          found: { type: 'boolean' },
          id: { type: 'number' },
          judgment: { type: 'string' },
          reasoning: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          project: { type: 'string' },
          type: { type: 'string' },
          importance: { type: 'number' },
          strength: { type: 'number' },
          useful_score: { type: 'number' },
          status: { type: 'string' },
          created_at: { type: 'number' },
          updated_at: { type: 'number' },
        },
      },
      render: (_a: unknown, v: any) =>
        v?.found
          ? text(
              [
                `#${v.id} [${v.type}] ${v.judgment}`,
                v.reasoning ? `依据：${v.reasoning}` : '',
                `项目：${v.project}｜重要性 ${v.importance}｜强度 ${Number(v.strength ?? 0).toFixed(2)}｜有用分 ${Number(v.useful_score ?? 0).toFixed(2)}｜${v.status}`,
                `标签：${(v.tags ?? []).join(' / ')}`,
                `创建 ${new Date(v.created_at).toLocaleString('zh-CN')}｜更新 ${new Date(v.updated_at).toLocaleString('zh-CN')}`,
              ]
                .filter(Boolean)
                .join('\n'),
            )
          : text('未找到该记忆'),
    },
    async execute(args: unknown) {
      const id = Number((args as { id?: unknown })?.id ?? 0)
      const row = getById(db, id)
      if (!row) return { found: false }
      markRecalled(db, [id], 0)
      let tags: string[] = []
      try {
        const v: unknown = JSON.parse(row.tags)
        if (Array.isArray(v)) tags = v.filter((x): x is string => typeof x === 'string')
      } catch {
        tags = []
      }
      return {
        found: true,
        id: row.id,
        judgment: row.judgment,
        reasoning: row.reasoning,
        tags,
        project: row.project,
        type: row.type,
        importance: row.importance,
        strength: row.strength,
        useful_score: row.useful_score,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }
    },
  })

  const disposeUpdate = ctx.tools.register({
    name: 'memory_update',
    description:
      '改一条记忆（只改传入的字段）：判断句 / 依据 / 标签 / 项目 / 类型 / 重要性 / 状态。' +
      '发现记忆过时、写错、或需要归档/恢复时用它，不要靠再写一条新的来覆盖。改动会记进整理日志留痕。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'integer', description: '记忆 id。' },
        judgment: { type: 'string', description: '新的判断句。' },
        reasoning: { type: 'string', description: '新的依据。' },
        tags: { type: 'array', items: { type: 'string' }, description: '新的标签（整体替换）。' },
        project: { type: 'string', description: '新的项目归属。' },
        type: { type: 'string', enum: MEMORY_TYPES_LIST, description: '新的类型。' },
        importance: { type: 'integer', description: '新的重要性 1~4。' },
        status: { type: 'string', enum: ['active', 'archived'], description: '归档或恢复。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: { ok: { type: 'boolean' }, id: { type: 'number' }, changed: { type: 'array', items: { type: 'string' } } },
      },
      render: (_a: unknown, v: any) =>
        text(v?.ok ? `✅ 已更新 #${v.id}（${(v.changed ?? []).join(' / ') || '无字段变化'}）` : '❌ 未找到该记忆，或没有可改的字段'),
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as Record<string, unknown>
      const id = Number(a.id ?? 0)
      const patch: Record<string, unknown> = {}
      if (typeof a.judgment === 'string' && a.judgment.trim()) patch.judgment = a.judgment.trim()
      if (typeof a.reasoning === 'string') patch.reasoning = a.reasoning
      if (Array.isArray(a.tags)) patch.tags = a.tags.filter((t): t is string => typeof t === 'string').slice(0, 13)
      if (typeof a.project === 'string' && a.project.trim()) patch.project = a.project.trim()
      if (typeof a.type === 'string' && MEMORY_TYPES_LIST.includes(a.type)) patch.type = a.type
      if (a.importance !== undefined && Number.isFinite(Number(a.importance))) patch.importance = Math.min(4, Math.max(1, Number(a.importance)))
      if (a.status === 'active' || a.status === 'archived') patch.status = a.status
      const changed = Object.keys(patch)
      if (changed.length === 0) throw new Error('memory_update: 没有要改的字段')
      const row = updateMemory(db, id, patch as never)
      if (!row) return { ok: false }
      try {
        db.prepare('INSERT INTO dream_log (run_at, action, memory_id, note) VALUES (?, ?, ?, ?)').run(
          Date.now(),
          'edit',
          id,
          `手动修改：${changed.join(',')}`,
        )
      } catch {
        /* 留痕失败不影响结果 */
      }
      return { ok: true, id, changed }
    },
  })

  const disposeProject = ctx.tools.register({
    name: 'memory_project',
    description:
      '取回某个项目的全部记忆（按类型分组，一口气给全）。想了解一个项目的历史、决策、现状时用它，不要用 memory_search 一条条拼。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['project'],
      properties: {
        project: { type: 'string', description: '项目名（如 maobing-memory / workbench / dsh）。' },
        status: { type: 'string', enum: ['active', 'all'], default: 'active', description: '是否含归档。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count'],
        properties: {
          project: { type: 'string' },
          count: { type: 'number' },
          groups: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_a: unknown, v: any) =>
        text(
          v?.count === 0
            ? `项目「${v?.project ?? ''}」下没有记忆`
            : [
                `【${v.project}】共 ${v.count} 条`,
                ...(v.groups as Array<{ type: string; items: Array<{ id: number; judgment: string }> }>).map(
                  (g) => `## ${g.type}（${g.items.length}）\n` + g.items.map((x) => `- #${x.id} ${x.judgment.slice(0, 100)}`).join('\n'),
                ),
              ].join('\n'),
        ),
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as { project?: unknown; status?: unknown }
      const project = typeof a.project === 'string' ? a.project.trim() : ''
      if (!project) throw new Error('memory_project: project 不能为空')
      const status: ListStatus = a.status === 'all' ? 'all' : 'active'
      const rows = listPage(db, { status, project, limit: 3000 }).rows
      const byType = new Map<string, MemoryRow[]>()
      for (const r of rows) {
        const arr = byType.get(r.type) ?? []
        arr.push(r)
        byType.set(r.type, arr)
      }
      const groups = [...byType.entries()].map(([type, items]) => ({
        type,
        items: items.map((r) => ({
          id: r.id,
          judgment: r.judgment,
          importance: r.importance,
          strength: r.strength,
          status: r.status,
        })),
      }))
      return { project, count: rows.length, groups }
    },
  })

  const disposeSimilar = ctx.tools.register({
    name: 'memory_find_similar',
    description:
      '给一条记忆找相似条目（BM25 相似度）——用于查重、找冲突、判断某条是否已有近似记录。写新记忆前先查重可以避免重复。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'integer', description: '基准记忆 id。' },
        k: { type: 'integer', default: 5, description: '返回条数 1~20。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['found'],
        properties: {
          found: { type: 'boolean' },
          id: { type: 'number' },
          similar: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_a: unknown, v: any) =>
        text(
          v?.found === false
            ? '未找到该记忆'
            : (v.similar as Array<{ id: number; judgment: string; score: number }>).length === 0
              ? `#${v.id} 没有相似条目`
              : (v.similar as Array<{ id: number; judgment: string; score: number }>)
                  .map((x) => `#${x.id} (${Number(x.score ?? 0).toFixed(2)}) ${x.judgment.slice(0, 90)}`)
                  .join('\n'),
        ),
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as { id?: unknown; k?: unknown }
      const id = Number(a.id ?? 0)
      const base = getById(db, id)
      if (!base) return { found: false }
      const k = Math.min(20, Math.max(1, Number(a.k ?? 5)))
      let tags: string[] = []
      try {
        const v: unknown = JSON.parse(base.tags)
        if (Array.isArray(v)) tags = v.filter((x): x is string => typeof x === 'string')
      } catch {
        tags = []
      }
      const rows = listPage(db, { status: 'all', limit: 5000 }).rows.filter((r) => r.id !== id)
      const hits = search(`${base.judgment} ${tags.join(' ')}`, toDocs(rows), { k })
      const byId = new Map(rows.map((r) => [r.id, r]))
      return {
        found: true,
        id,
        similar: hits.map((h) => ({
          id: h.id,
          judgment: byId.get(h.id)?.judgment ?? '',
          project: byId.get(h.id)?.project ?? '',
          score: Math.round(h.score * 1000) / 1000,
        })),
      }
    },
  })

  // ── 反思轮：每 N 轮结束回顾一次（写记忆 + 情绪自评，一次调用两件事）──────────
  //
  // 【将来拆到 reflect.ts 的缝，但**必须和上面的「注入」一起拆**】
  //  - 这一段持有 4 个 session 级 Map（queuedTurn / cooldown / turns / countedTurn），
  //    注入那边持有 firstTurned / injectedBySession，都以 sid 为 key、都在 turn 边界上读写；
  //  - 只拆一半 = 两份 session 状态各自漂移（当初无限套娃就是这么来的），所以要么一起搬，
  //    要么就留在 index.ts（当前选择）；
  //  - 拆出去后这里只剩一行 `ctx.on('agent/turn-stopping', ...)` 挂载 + 一行 dispose。
  const REFLECT_MARKER = '[maobing-memory-reflect]'
  // ── 反思轮：攒够 N 轮（reflectEveryN）才让模型回顾一次 ────────────────────
  //
  // 四层闸门，缺一层就会出问题（前三层是防无限套娃，第四层是防「太密」）：
  //  ①反射消息标记：插件自己插入的反思指令带 [maobing-memory-reflect] 前缀，
  //    下一轮进来先看最近一条用户消息是不是它——是就跳过（否则反思的反思的反思…）；
  //  ②同 turn 不重复排：reflectQueuedTurn 记着「这一轮已经排过」，重复的 pre-step 不排；
  //  ③冷却时间戳**只能刷新不能 delete**：早期写的是 delete，等于冷却记录消失，
  //    下一轮又能排——这就是当初无限循环的直接原因。
  //    （用 set 刷新时间戳，记录一直在，冷却才真的有效。）
  //  ④轮次计数 reflectTurns：每轮真实对话 +1，攒够 reflectEveryN 才排一次，排完归零。
  //    为什么要有：每轮都反思不只贵（单轮 token 翻倍），还会**把同一件事切成好几条**记忆
  //    （每轮只看到一小段对话），之后就变成重复条目。
  const reflectQueuedTurn = new Map<string, number>()
  /** sid → 上次排反思的时间戳。**只刷新、不删除**（删掉 = 冷却失效 = 无限套娃）。 */
  const reflectCooldown = new Map<string, number>()
  /** sid → 距上次反思攒了几轮真实对话。 */
  const reflectTurns = new Map<string, number>()
  /** sid → 最近一次被计入计数的 turn 号（同一轮多次触发只算一次）。 */
  const reflectCountedTurn = new Map<string, number>()
  const REFLECT_COOLDOWN_MS = 60_000

  /** 反思提示词（内嵌：esbuild 不打 .md；源码同份在 src/prompts/zh/reflect.md）。
   *  骨架参考了同类记忆插件的反思做法：让模型**自己调工具**查重与写入，情绪只作为副产品多输出一行。 */
  const REFLECT_PROMPT = [
    '记忆反思任务（自动触发，不是用户在提问）',
    '',
    '回顾从上次反思到现在的对话，做两件事。',
    '',
    '【一】用工具处理记忆（写入前必须先查重）',
    '',
    '**硬规则（违反就算这次反思失败）**：',
    '调用 memory_find_similar / memory_search 后，只要返回的相似度里有**任意一条 ≥ 0.70**，',
    '就必须 `memory_update` **那一条**（补充、纠正、合并都写进它），**禁止再 memory_remember 新建**。',
    '只有「查不到任何 ≥ 0.70 的」才允许新建。宁可把老条目改得更全，也不要新建一条像它的。',
    '（同一个东西换个说法，分数就会掉到 0.7 以下——拿不准就换 2~3 组说法各查一次，别偷懒只查一次。）',
    '',
    '1. 有价值的东西：新的事实、拍板的决策、约定、偏好、踩过的坑与修法、被用户纠正的地方。',
    '   → 先 memory_find_similar（或 memory_search）查重，再按上面的硬规则决定 update / remember。',
    '2. 上下文里注入的记忆如果有已经过时的、写错的，→ memory_update 修正，或改成 archived。',
    '3. 没有值得记的就什么都不做（不要硬凑）。',
    '',
    '记忆规范：judgment 写成一句独立可检索的判断句；tags 给 8~13 个锚点词（想“用户提到哪些词时该命中它”）；',
    'project 写所属项目（全局信息写「全局」）；importance 1~4（4 = 长期规矩或红线）。',
    '',
    '【二】最后输出一行情绪（必填，任何情况下都要有）',
    '',
    'SOUL joy=0.xx anger=0.xx surprise=0.xx disgust=0.xx',
    '',
    '四个 0~1 的数，0.5 = 平常心：joy 喜↔悲、anger 怒↔恐、surprise 意料中↔出乎意料、disgust 厌恶↔认可。',
    '如实反映这一轮实际发生的事（被夸/被骂/出错/被纠正），不是用户要求你表现的情绪；没起伏就都接近 0.5。',
    '这一行必须出现，且是你在本任务里唯一要输出的文字。',
  ].join('\n')

  const eventsOf = (agent: any): any[] => {
    const ev = agent?.session?.events
    if (typeof ev === 'function') {
      try {
        const out = ev.call(agent.session)
        return Array.isArray(out) ? out : []
      } catch {
        return []
      }
    }
    return Array.isArray(ev) ? ev : []
  }

  const textOfMessage = (e: any): string => {
    const blocks = e?.data?.content ?? e?.data?.message?.content ?? []
    return (Array.isArray(blocks) ? blocks : [])
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => String(b.text ?? ''))
      .join('\n')
  }

  ctx.on('agent/turn-stopping', (payload: any) => {
    try {
      if (!cfg.reflect) return
      const agent = payload?.agent
      const turn = payload?.turn as number | undefined
      if (agent === undefined) return
      if (agent?.session?.header?.origin === 'subagent') return
      const sid = String(agent?.session?.header?.id ?? 'unknown')

      // ① 本 turn 就是反思轮（最近一条用户消息就是反思指令）→ 不计数、不套娃。
      //    顺序很关键：这一支必须排在「计数」之前，否则反思轮自己会被当成一次真实对话。
      const events = eventsOf(agent)
      let lastUser = ''
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === 'user/message') {
          lastUser = textOfMessage(events[i])
          break
        }
      }
      if (lastUser.includes(REFLECT_MARKER)) {
        reflectCooldown.set(sid, Date.now()) // 反思轮自己结束，续一次冷却
        reflectTurns.set(sid, 0) // 这一段已经反思过了，计数器归零重新攒
        return
      }

      // ② 攒轮次：同一 turn 只计一次（重复的 turn-stopping 不能把 1 轮当 2 轮）
      let turns = reflectTurns.get(sid) ?? 0
      const alreadyCounted = turn !== undefined && reflectCountedTurn.get(sid) === turn
      if (!alreadyCounted) {
        turns += 1
        reflectTurns.set(sid, turns)
        if (turn !== undefined) {
          reflectCountedTurn.set(sid, turn)
          while (reflectCountedTurn.size > 200) {
            const oldest = reflectCountedTurn.keys().next().value
            if (oldest === undefined) break
            reflectCountedTurn.delete(oldest)
          }
        }
      }
      if (turns < cfg.reflectEveryN) return

      // ③ 冷却（唯一靠得住的闸门；必须刷新时间戳，绝不能 delete）
      const last = reflectCooldown.get(sid) ?? 0
      if (Date.now() - last < REFLECT_COOLDOWN_MS) return

      // ④ 同一 turn 不重复排
      if (turn !== undefined && reflectQueuedTurn.get(sid) === turn) return

      const followup = (agent as { followup?: (m: unknown) => void })?.followup
      if (typeof followup !== 'function') return

      followup.call(agent, createPluginMessage(`${REFLECT_MARKER}\n\n${REFLECT_PROMPT}`))
      reflectCooldown.set(sid, Date.now())
      reflectTurns.set(sid, 0)
      if (turn !== undefined) {
        reflectQueuedTurn.set(sid, turn)
        while (reflectQueuedTurn.size > 200) {
          const oldest = reflectQueuedTurn.keys().next().value
          if (oldest === undefined) break
          reflectQueuedTurn.delete(oldest)
        }
      }
      log.warn(
        `[dsh-maobing-memory] 反思轮已排队 sid=${sid.slice(0, 8)} turn=${turn ?? '-'}（每 ${cfg.reflectEveryN} 轮一次）`,
      )
    } catch (e) {
      log.warn(`[dsh-maobing-memory] 反思轮排队失败（忽略）：${e instanceof Error ? e.message : String(e)}`)
    }
  })

  /** 从回复里抠 JSON（兼容 ```json 包裹）。 */
  const extractJson = (text: string): any | null => {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
    const raw = fenced?.[1] ?? text
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {
      return null
    }
  }

  // 抓反思结果：情绪从 SOUL 行取；记忆已由模型在反思轮里用工具写好（含查重）
  ctx.on('session/event', (session: any, event: any) => {
    try {
      if (event?.type !== 'assistant/message') return
      const text = textOfMessage(event)
      const soulLine = /SOUL\s+joy\s*[=:：]\s*([\d.]+)[\s\S]{0,24}?anger\s*[=:：]\s*([\d.]+)[\s\S]{0,24}?surprise\s*[=:：]\s*([\d.]+)[\s\S]{0,24}?disgust\s*[=:：]\s*([\d.]+)/i.exec(text)
      if (soulLine !== null) {
        const target = {
          joy: Number(soulLine[1]),
          anger: Number(soulLine[2]),
          surprise: Number(soulLine[3]),
          disgust: Number(soulLine[4]),
        }
        const next = approach(decayedMood(db), target)
        next.updated_at = Date.now()
        writeMood(db, next)
        reflectCooldown.set(String(session?.header?.id ?? 'unknown'), Date.now())
        log.warn(`[dsh-maobing-memory] 反思完成（情绪已更新）`)
        return
      }
      if (!text.includes('soul_state') && !text.includes('memories')) return
      const parsed = extractJson(text)
      if (parsed === null) return
      const sid = String(session?.header?.id ?? 'unknown')

      let wrote = 0
      const list = Array.isArray(parsed.memories) ? parsed.memories : []
      for (const m of list.slice(0, 6)) {
        try {
          const judgment = String(m?.judgment ?? '').trim()
          if (judgment.length < 6) continue
          insertMemory(db, {
            judgment,
            reasoning: String(m?.reasoning ?? ''),
            tags: Array.isArray(m?.tags) ? m.tags.filter((t: unknown): t is string => typeof t === 'string') : [],
            project: String(m?.project ?? '全局') || '全局',
            type: MEMORY_TYPES_LIST.includes(String(m?.type)) ? String(m.type) : 'knowledge',
            importance: Number.isFinite(Number(m?.importance)) ? Number(m.importance) : 2,
            source_session: sid,
          })
          wrote++
        } catch {
          /* 单条失败不影响其它 */
        }
      }

      const soul = parsed.soul_state
      if (soul !== null && typeof soul === 'object') {
        const target = {
          joy: Number(soul.joy),
          anger: Number(soul.anger),
          surprise: Number(soul.surprise),
          disgust: Number(soul.disgust),
        }
        const next = approach(decayedMood(db), target)
        next.updated_at = Date.now()
        writeMood(db, next)
      }

      reflectCooldown.set(sid, Date.now())
      log.warn(`[dsh-maobing-memory] 反思完成：写入 ${wrote} 条记忆`)
    } catch {
      /* 解析失败不影响对话 */
    }
  })

  // ── 每日整理（默认 22:00，衰减 → 归档，不删）────────────────────────────
  //
  // 【可拆性】这个工具只有十几行、调度器本身在 dream.ts，拆不拆都无所谓；
  // 真要拆就跟上面的工具区一起搬进 tools.ts（同源依赖：db / log / dream）。
  // 注意 `dryRun`（空跑）必须不写库也不写 meta.lastDreamDay，否则当晚的定时整理会被跳过。
  //
  // 自动/手动（`dreamAuto`）：整理是**纯本地 SQL、不花 token**，但定时器只在「宿主活着 + 恰好到点那一分钟」
  // 时生效，关机就漏跑；不常开机的机器干脆关掉自动，改成手动点 + 「已 N 天未整理」提醒。
  const dreamInfo = lastDreamInfo(db)
  let stopScheduler: () => void = () => {}
  if (cfg.dreamAuto) {
    stopScheduler = startDreamScheduler(db, cfg.dreamAt, (r) => {
      log.info(`[dsh-maobing-memory] ${cfg.dreamAt} 整理完成：衰减 ${r.decayed}，归档 ${r.archived}`)
    })
    log.info(`[dsh-maobing-memory] dream 调度已启动：每天 ${cfg.dreamAt}`)
    if (dreamInfo.days !== null && dreamInfo.days >= 7) {
      log.warn(
        `[dsh-maobing-memory] 已有 ${dreamInfo.days} 天没整理（上次 ${dreamInfo.day}）——定时器只在到点那一刻生效，漏了就在面板手动点一次`,
      )
    }
  } else {
    const ago =
      dreamInfo.days === null ? '（从没整理过）' : dreamInfo.days === 0 ? '（今天）' : `（${dreamInfo.days} 天前）`
    log.info(
      `[dsh-maobing-memory] dream 调度：已禁用（手动整理）——上次整理 ${dreamInfo.day ?? '从未'}${ago}；` +
        '需要时在面板「整理」tab 点「立即整理一次」，或让模型调 memory_dream',
    )
  }

  const disposeDreamTool = ctx.tools.register({
    name: 'memory_dream',
    description:
      '手动触发一次整理：按强度三档衰减，强度归零的记忆转为归档（不删除）。' +
      '默认每天 22:00 自动跑一次；配了 `dreamAuto: false` 时就只能手动调这个工具或点面板按钮。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dryRun: { type: 'boolean', default: false, description: '只统计不落库。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          decayed: { type: 'number' },
          archived: { type: 'number' },
          log: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: any) =>
        text(
          value?.ok
            ? `整理完成：衰减 ${value.decayed} 条，归档 ${value.archived} 条${(value.log ?? []).length ? '\n' + (value.log ?? []).join('\n') : ''}`
            : '整理失败',
        ),
    },
    async execute(args: unknown) {
      const a = (args ?? {}) as { dryRun?: boolean }
      if (a.dryRun) {
        const rows = listActive(db)
        const wouldDecay = rows.filter((r) => Number(r.useful_score ?? 0) < 10).length
        return { ok: true, decayed: 0, archived: 0, log: [`dryRun：${rows.length} 条 active，其中 ${wouldDecay} 条会参与衰减`] }
      }
      const r: DecayResult = decayAndArchive(db)
      log.info(`[dsh-maobing-memory] dream: decayed=${r.decayed} archived=${r.archived}`)
      return { ok: r.ok, decayed: r.decayed, archived: r.archived, log: r.log.slice(0, 20) }
    },
  })

  ctx.on('dispose', () => {
    try {
      disposeRemember()
      disposeRecent()
      disposeDreamTool()
      disposeNoteWrite()
      disposeNoteRead()
      disposeNoteSearch()
      disposeNoteUpdate()
      disposeSearch()
      disposeRead()
      disposeUpdate()
      disposeProject()
      disposeSimilar()
      stopScheduler()
      for (const d of routeDisposers.reverse()) d()
      db.close()
    } catch {
      /* 卸载失败不阻塞 */
    }
  })
}

export { approach, regress, decayedMood, formatMoodLine, readMood, writeMood, DEFAULT_MOOD, AXES, AXIS_LABEL } from './mood.js'

export { createLogger } from './logger.js'

export { findMergeCandidates, mergeMemories } from './merge.js'

export { buildHits, buildSnapshot } from './inject.js'
export { decayAndArchive, lastDreamInfo } from './dream.js'

/** 冒烟专用：把「查询清洗 / 分词 / 阈值当量」直接暴露出来，好在不启 DSH 的情况下单测。
 *  宿主只用 tools / apply / 槽位，不会碰这几个名字。 */
export const _testing = { sanitizeQuery, tokenize, rareTokenIdf, effectiveMinScore }
