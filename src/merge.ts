/**
 * maobing-memory — 合并候选。
 *
 * 干嘛的：反思轮偶尔会写出内容高度相似的两条记忆（典型：#1109 与库里早有的 #691）。
 * 与其靠人在面板上一条条翻，不如主动把「同项目内两两相似度超过阈值」的对找出来，
 * 人工确认后并成一条 —— **不自动合**，因为合并是不可逆的语义操作。
 *
 * 相似度怎么算：判断句按「字符二元组 + 中文单字」取集合，算 Jaccard。
 * 不用 BM25 是因为它天生偏向「长文档命中多」，而这里比的是「两段话说的是不是同一件事」。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryRow } from './db.js'

export interface MergeCandidate {
  a: { id: number; judgment: string; project: string; importance: number; tags: string[] }
  b: { id: number; judgment: string; project: string; importance: number; tags: string[] }
  score: number
  reason: string
}

/**
 * 提取「实体标识」：3 位以上数字串（QQ号/BattleTag 后缀/编号）。
 * 用途：两条记忆各带不同数字时，几乎一定是不同对象（不同的人、不同的条目），
 * 不能因为句式相同就判成重复 —— 实测 #243 与 #294 就是两个玩家用同一句唤词，相似度 0.977。
 */
function idTokens(text: string): Set<string> {
  return new Set(String(text ?? '').match(/\d{3,}/g) ?? [])
}

/** 两条记忆是否指向同一个实体：都没有数字 → 无法判断（算同一实体）；有交集 → 同一实体；各不同 → 不同实体。 */
function sameEntity(a: string, b: string): boolean {
  const ia = idTokens(a)
  const ib = idTokens(b)
  if (ia.size === 0 || ib.size === 0) return true
  for (const x of ia) if (ib.has(x)) return true
  return false
}

/** 取字符集合：中文单字 + 英文/数字词 + 相邻二元组（提高区分度）。 */
function tokenSet(text: string): Set<string> {
  const s = String(text ?? '').toLowerCase().replace(/\s+/g, '')
  const out = new Set<string>()
  for (const ch of s) {
    if (/[\u4e00-\u9fff]/.test(ch)) out.add(ch)
  }
  for (const w of s.match(/[a-z0-9_]{2,}/g) ?? []) out.add(w)
  for (let i = 0; i + 1 < s.length; i++) {
    const pair = s.slice(i, i + 2)
    if (/[\u4e00-\u9fff]{2}/.test(pair)) out.add(pair)
  }
  return out
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  const small = a.size <= b.size ? a : b
  const big = a.size <= b.size ? b : a
  for (const x of small) if (big.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

function parseTags(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * 找合并候选：只在**同一项目内**两两比较（跨项目合并通常是错的），
 * 跳过完全相同判定句（那是纯重复，应该直接归档）。
 */
export function findMergeCandidates(
  db: DatabaseSync,
  opts: { threshold?: number; limit?: number; project?: string } = {},
): MergeCandidate[] {
  const threshold = Math.min(0.95, Math.max(0.3, opts.threshold ?? 0.55))
  const limit = Math.min(200, Math.max(1, opts.limit ?? 40))

  const rows = (
    db
      .prepare(`SELECT * FROM memory WHERE status = 'active' ORDER BY project, id`)
      .all() as unknown as MemoryRow[]
  ).filter((r) => (opts.project ? r.project === opts.project : true))

  const byProject = new Map<string, MemoryRow[]>()
  for (const r of rows) {
    const arr = byProject.get(r.project) ?? []
    arr.push(r)
    byProject.set(r.project, arr)
  }

  const found: MergeCandidate[] = []
  for (const [project, list] of byProject) {
    if (list.length < 2) continue
    const sets = list.map((r) => tokenSet(r.judgment))
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        const ja = a.judgment.trim()
        const jb = b.judgment.trim()
        if (ja === jb) continue // 完全重复交给归档处理，不算"候选合并"
        // 实体不同（各带不同编号/ID）→ 不是重复，跳过
        if (!sameEntity(ja, jb)) continue
        const score = jaccard(sets[i], sets[j])
        if (score < threshold) continue
        found.push({
          a: { id: a.id, judgment: a.judgment, project, importance: a.importance, tags: parseTags(a.tags) },
          b: { id: b.id, judgment: b.judgment, project, importance: b.importance, tags: parseTags(b.tags) },
          score: Math.round(score * 1000) / 1000,
          reason: score >= 0.8 ? '几乎同一件事' : score >= 0.65 ? '高度重叠' : '内容相近',
        })
      }
    }
  }

  found.sort((x, y) => y.score - x.score)
  return found.slice(0, limit)
}

export interface MergeResult {
  ok: boolean
  keptId: number
  mergedId: number
  /** 合并后的判断句 */
  judgment: string
  tags: string[]
}

/**
 * 合并：把 drop 那条并进 keep。
 * - 判断句取更长的（信息更全）
 * - reasoning 拼接（去重）
 * - tags 取并集（最多 13 个）
 * - 强度取两者较大值，重要性取较大值
 * - drop 那条标 archived（不物理删）
 */
export function mergeMemories(db: DatabaseSync, keepId: number, dropId: number): MergeResult {
  const get = (id: number) =>
    db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as unknown as MemoryRow | undefined
  const keep = get(keepId)
  const drop = get(dropId)
  if (!keep) throw new Error(`mergeMemories: 找不到 #${keepId}`)
  if (!drop) throw new Error(`mergeMemories: 找不到 #${dropId}`)
  if (keep.id === drop.id) throw new Error('mergeMemories: 不能和自己合并')
  // 幂等：drop 已经是归档状态 → 说明合并过了，直接返回现状（不重复并内容、不重复写日志）
  if (drop.status === 'archived') {
    return { ok: true, keptId: keep.id, mergedId: drop.id, judgment: keep.judgment, tags: parseTags(keep.tags) }
  }

  const judgment = drop.judgment.trim().length > keep.judgment.trim().length ? drop.judgment : keep.judgment
  const reasonParts = [keep.reasoning.trim(), drop.reasoning.trim()].filter((x) => x !== '')
  const reasoning = reasonParts.length > 0 ? Array.from(new Set(reasonParts)).join('\n') : ''
  const tags = Array.from(new Set([...parseTags(keep.tags), ...parseTags(drop.tags)])).slice(0, 13)
  const importance = Math.max(keep.importance, drop.importance)
  const strength = Math.max(keep.strength, drop.strength)
  const now = Date.now()

  db.prepare(
    `UPDATE memory SET judgment = ?, reasoning = ?, tags = ?, importance = ?, strength = ?, updated_at = ? WHERE id = ?`,
  ).run(judgment, reasoning, JSON.stringify(tags), importance, strength, now, keepId)
  db.prepare(`UPDATE memory SET status = 'archived', updated_at = ? WHERE id = ?`).run(now, dropId)

  try {
    db.prepare('INSERT INTO dream_log (run_at, action, memory_id, note) VALUES (?, ?, ?, ?)').run(
      now,
      'merge',
      keepId,
      `合并 #${dropId} 进 #${keepId}（#${dropId} 已归档）`,
    )
  } catch {
    /* 留痕失败不影响结果 */
  }

  return { ok: true, keptId: keepId, mergedId: dropId, judgment, tags }
}
