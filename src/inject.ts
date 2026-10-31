/**
 * maobing-memory — 注入层。
 *
 * 两条注入路径（都插成独立 plugin 消息，不改写用户 prompt）：
 *  1. 首轮快照：本会话第一条真实用户消息前，插一份按项目分组的记忆概览。
 *  2. 每轮命中：从第二条起，对当前用户消息做 BM25，取 topK 插在消息前。
 *
 * DSH 会话格式 v4 要求消息 source 自报家门：kind = `plugin:maobing-memory`。
 */
import { randomUUID } from 'node:crypto'
import { search, type Doc, type Hit } from './bm25.js'

export const PLUGIN_NAME = 'dsh-maobing-memory'
export const PLUGIN_KIND = `plugin:${PLUGIN_NAME}`

export const SNAPSHOT_MARKER = '===== 长期记忆（maobing-memory）====='
export const HIT_MARKER = '可能相关的记忆，仅供参考：'

export interface MessageLike {
  id: string
  role: 'user'
  content: Array<{ type: 'text'; text: string }>
  source: { kind: string }
}

/** 造一条插件消息（等效于 dsh-llm 的 createUserMessage，但不依赖它）。 */
export function createPluginMessage(text: string): MessageLike {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: PLUGIN_KIND },
  }
}

export interface MemoryLike {
  id: number
  type: string
  judgment: string
  reasoning: string
  tags: string
  project: string
  strength: number
  importance: number
  updated_at: number
}

export function toDocs(rows: MemoryLike[]): Doc[] {
  return rows.map((r) => {
    let tags: string[] = []
    try {
      const parsed: unknown = JSON.parse(r.tags)
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string')
    } catch {
      tags = []
    }
    return {
      id: r.id,
      text: `${r.judgment}\n${r.reasoning}`.trim(),
      tags,
      strength: Number(r.strength ?? 1) || 1,
      importance: Number(r.importance ?? 1) || 1,
      updatedAt: Number(r.updated_at ?? Date.now()) || Date.now(),
    }
  })
}

function line(row: MemoryLike, max = 120): string {
  const head = row.judgment.replace(/\s+/g, ' ').slice(0, max)
  return `- #${row.id} [${row.type}] ${head}${row.judgment.length > max ? '…' : ''}`
}

/** 首轮快照：按项目分组，每组最多 N 条，总量受上限约束。 */
export function buildSnapshot(rows: MemoryLike[], opts: { perProject?: number; maxTotal?: number } = {}): string | null {
  const perProject = Math.max(1, opts.perProject ?? 8)
  const maxTotal = Math.max(1, opts.maxTotal ?? 40)
  if (rows.length === 0) return null

  const groups = new Map<string, MemoryLike[]>()
  for (const r of rows) {
    const key = r.project || '全局'
    const arr = groups.get(key) ?? []
    arr.push(r)
    groups.set(key, arr)
  }

  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
  const parts: string[] = [`${SNAPSHOT_MARKER}`, `共 ${rows.length} 条记忆，按项目分组（每项最多 ${perProject} 条）：`]
  let used = 0
  for (const [project, list] of ordered) {
    if (used >= maxTotal) break
    const sorted = [...list].sort((a, b) => b.updated_at - a.updated_at)
    const take = sorted.slice(0, Math.min(perProject, maxTotal - used))
    used += take.length
    parts.push(`【${project}】${list.length} 条`)
    for (const r of take) parts.push(line(r))
  }
  if (used < rows.length) parts.push(`（其余 ${rows.length - used} 条未展开，可用 memory_search 查询）`)
  return parts.join('\n')
}

/**
 * 小库补偿后的**实际阈值**。
 *
 * 为什么不能直接写死 6：BM25 的 idf 随库容量缩水。实测（2026-10-31，真库 566 条）：
 * 「命中一个只出现 1 次的稀有词」≈ 5.9 分；同样的命中在 3 条库里只有 ≈ 1 分。
 * 固定 6 分阈值会让刚装上的小库**一条都注入不出来**（冒烟库只有 3 条时，正确答案
 * 算下来 5.7 分，差一点就被砍掉）。所以按库容量线性放宽，≥200 条时用原阈值。
 */
export function effectiveMinScore(minScore: number, docCount: number): number {
  if (!(minScore > 0)) return 0
  const scale = Math.min(1, Math.max(0, docCount) / 200)
  return minScore * scale
}

/**
 * 每轮命中：**混合注入**。
 *
 * 前 k 条给全文（最可能是答案的），其余最多 indexLimit 条只给一行索引。
 * 这么改的原因（2026-10-31 实测）：只注入 topK 条时，正确答案排第 4 就等于不存在
 * （问「meow 的库现在叫什么」，#1074 排第 4 被丢掉，模型转头去查 GitHub）。
 * 给索引能让模型知道「库里还有这些」，需要细节再 memory_read——覆盖从 3 条提到 25 条。
 *
 * `minScore`（总分门槛，默认 6）再砍一刀：总分 =（BM25 + 标签）× 重要 × 强度 × 新鲜度，
 * 低于门槛的**全文和索引都不给**。原因是语料多了以后，每轮 top11 里常有三五条只是
 * 撞上「记忆」「插件」这种通用词（实测把群友闲聊也捞出来），每轮白烧 300~500 token。
 */
export function buildHits(
  rows: MemoryLike[],
  query: string,
  opts: { k?: number; indexLimit?: number; seen?: Set<number>; now?: number; minScore?: number } = {},
): { text: string; ids: number[] } | null {
  const k = Math.max(1, opts.k ?? 5)
  const indexLimit = Math.max(0, opts.indexLimit ?? 8)
  const docs = toDocs(rows).filter((d) => !opts.seen?.has(d.id))
  if (docs.length === 0 || query.trim().length === 0) return null
  // 先全量打分再按门槛过滤：若直接取 k+indexLimit 条再滤，被砍掉的位置不会回填，
  // 结果就是「阈值一把注入宽度也砍没了」。
  const minScore = effectiveMinScore(opts.minScore ?? 0, docs.length)
  const hits: Hit[] = search(query, docs, { k: Math.max(1, docs.length), now: opts.now }).filter(
    (h) => h.score >= minScore,
  )
  if (hits.length === 0) return null
  const byId = new Map(rows.map((r) => [r.id, r]))

  const head = hits.slice(0, k)
  const tail = hits.slice(k, k + indexLimit)

  const parts = [HIT_MARKER]
  for (const h of head) {
    const row = byId.get(h.id)
    if (!row) continue
    parts.push(`${line(row)}（BM25 ${h.detail.bm25}${h.detail.tag > 0 ? `，标签 +${h.detail.tag}` : ''}）`)
  }

  if (tail.length > 0) {
    parts.push('')
    parts.push('【其他可能相关（只给索引，需要细节用 memory_read 读全文）】')
    for (const h of tail) {
      const row = byId.get(h.id)
      if (!row) continue
      const flat = String(row.judgment).replace(/\s+/g, ' ')
      // 标签是天然的关键词锚点，信息密度比判断句开头高得多（判断句往往先铺垫场景，
      // 关键信息在中后段——例如 #1074 的「库改名 _removed」在第 4 个标签里，
      // 而判断句前 40 字只是「meow-memory 与它的查看面板…」）。
      const tagList = Array.isArray(row.tags) ? row.tags.slice(0, 4) : []
      const tagPart = tagList.length > 0 ? `${tagList.join(' / ')} ｜ ` : ''
      parts.push(`#${row.id} [${row.project}] ${tagPart}${flat.slice(0, 32)}${flat.length > 32 ? '…' : ''}`)
    }
  }

  parts.push('')
  parts.push('（上面只是线索。若这些都不足以回答，用 memory_search 自己再搜一次，别凭印象编。）')

  // ids 只报**真正注入过的**那些：调用方拿它去 markRecalled / 记 seen。
  // 门槛以上但排在 k+indexLimit 之外的条目没花 token，不该被标记成「已用/已注入」。
  return { text: parts.join('\n'), ids: [...head, ...tail].map((h) => h.id) }
}
