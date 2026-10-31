/**
 * maobing-memory — BM25 检索（精简自研实现）。
 *
 * 中文按字切、英文/数字按词切；BM25 打分之外再乘三样东西：
 * 强度（strength）、标签命中加权、艾宾浩斯式时间衰减。
 * 不依赖任何外部库，纯函数，可单测。
 */

export interface Doc {
  id: number
  text: string
  tags: string[]
  strength: number
  importance: number
  updatedAt: number
}

export interface Hit extends Doc {
  score: number
  /** 命中明细，面板"检索调试"直接用 */
  detail: { bm25: number; tag: number; imp: number; strength: number; recency: number }
}

const CJK = /[\u4e00-\u9fff\u3040-\u30ff]/
const WORD = /[a-z0-9_]+/gi

/** 中文单字成词；英文数字按词（小写、去停用词）。 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  let i = 0
  while (i < lower.length) {
    const ch = lower[i]
    if (CJK.test(ch)) {
      out.push(ch)
      i += 1
      continue
    }
    const m = lower.slice(i).match(/^[a-z0-9_]+/)
    if (m) {
      out.push(m[0])
      i += m[0].length
      continue
    }
    i += 1
  }
  return out.filter((t) => t.length > 0 && !STOP.has(t))
}

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'was', 'were', 'for', 'on', 'at', 'it', 'this', 'that',
  'be', 'as', 'with', 'by', 'from', 'not', 'but', 'if', 'then', 'so', 'we', 'you', 'i', 'he', 'she', 'they',
  '的', '了', '是', '在', '和', '有', '就', '也', '都', '而', '与', '这', '那', '你', '我', '他', '她', '它',
])

/** 艾宾浩斯式时间衰减：越久越轻，但不会掉到 0。 */
export function recencyWeight(ageMs: number, halfLifeDays = 30): number {
  const days = Math.max(0, ageMs) / 86_400_000
  return Math.max(0.15, Math.pow(0.5, days / halfLifeDays))
}

export interface SearchOptions {
  k?: number
  now?: number
  /** 标签命中一次的加权（相对 BM25 原始分），默认 0.8 */
  tagBoost?: number
}

/**
 * 最终得分 = (BM25 + 标签命中分) × 重要性 × 强度 × 新鲜度。
 *
 * 为什么是相乘而不是相加：
 *  - BM25 与标签分是「相关性」，加法归到一起；
 *  - 重要性 / 强度 / 新鲜度是三个**独立的质量因子**，任意一个趋近 0 都该把整条压下去
 *    （一条三个月没被召回、强度快归零的记忆，就算关键词完全命中也不该冒到最前面），
 *    乘法天然表达这个意思，加法做不到。
 *
 * 各因子为什么存在：
 *  - `tagBoost`（默认 0.8）：标签是人工给的锚点词，命中比正文命中更有意义；
 *  - `importance`：`1 + 0.25×(imp-1)`，即 1~4 映射成 1 / 1.25 / 1.5 / 1.75，
 *    避免 4 倍差距把 BM25 的相关性彻底淹没；
 *  - `strength`：`0.5 + 0.5×strength`，兜底 0.5 是为了让快归零的记忆还能被搜到；
 *  - `recencyWeight`：30 天半衰，让新记忆在同等相关度下略占优。
 */
export function search(query: string, docs: Doc[], opts: SearchOptions = {}): Hit[] {
  const k = Math.max(1, opts.k ?? 5)
  const now = opts.now ?? Date.now()
  const tagBoost = opts.tagBoost ?? 0.8
  const qTokens = Array.from(new Set(tokenize(query)))
  if (qTokens.length === 0 || docs.length === 0) return []

  const docTokens = docs.map((d) => tokenize(`${d.text} ${d.tags.join(' ')}`))
  const avgLen = docTokens.reduce((s, t) => s + t.length, 0) / docs.length || 1
  const df = new Map<string, number>()
  for (const tokens of docTokens) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const idf = (t: string) => {
    const n = df.get(t) ?? 0
    return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))
  }

  const K1 = 1.2
  const B = 0.75
  const hits: Hit[] = []

  docs.forEach((doc, idx) => {
    const tokens = docTokens[idx]
    if (tokens.length === 0) return
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)

    let bm25 = 0
    let matched = 0
    for (const q of qTokens) {
      const f = tf.get(q)
      if (!f) continue
      matched++
      bm25 += idf(q) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * tokens.length) / avgLen)))
    }
    if (matched === 0) return

    const lowerTags = doc.tags.map((t) => t.toLowerCase())
    let tagHits = 0
    for (const q of qTokens) {
      if (lowerTags.some((t) => t.includes(q) || q.includes(t))) tagHits++
    }
    const tagScore = tagHits * tagBoost
    const strengthScore = 0.5 + 0.5 * Math.min(1, Math.max(0, doc.strength))
    const rec = recencyWeight(now - doc.updatedAt)
    const impWeight = 1 + 0.25 * ((Number(doc.importance ?? 1) || 1) - 1)
    const weight = impWeight * strengthScore * rec
    const score = (bm25 + tagScore) * weight

    hits.push({ ...doc, score, detail: { bm25: round(bm25), tag: round(tagScore), imp: round(impWeight), strength: round(strengthScore), recency: round(rec) } })
  })

  return hits.sort((a, b) => b.score - a.score).slice(0, k)
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
