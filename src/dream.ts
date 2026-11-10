/**
 * dsh-maobing-memory — 每日整理（三档衰减 → 归档，永不物理删除）。
 *
 * 三档策略（照 angel_memory 的设计思路，自己实现）：
 *  - T0（useful_score < 3）：每次整理 strength -= 0.02（约 50 天归零）
 *  - T1（3 ≤ useful_score < 10）：只在「上次整理后被召回却没被标记有用」时 -0.01
 *  - T2（useful_score ≥ 10）：永不衰减
 * 强度归零 → status='archived'，**正文永不删**。
 *
 * 时间：默认每天 22:00（用户拍板，不是凌晨），当天只跑一次，跑过记在 meta 表。
 */
import type { DatabaseSync } from 'node:sqlite'

export interface DecayResult {
  ok: boolean
  decayed: number
  archived: number
  reason?: string
  log: string[]
  /** true = 这是空跑（完整算了一遍但没写库）。 */
  dryRun?: boolean
}

interface Row {
  id: number
  judgment: string
  strength: number
  useful_score: number
  last_recalled_at: number
  last_decay_at: number
}

export const DEFAULTS = {
  /** T0 每次整理的衰减量 */
  t0Step: 0.02,
  /** T1 每次整理的衰减量（仅未被用到时） */
  t1Step: 0.01,
  /** 进 T1 的 useful_score 门槛 */
  t1At: 3,
  /** 进 T2（永不衰减）的 useful_score 门槛 */
  t2At: 10,
}

/**
 * 每日整理：按档位衰减强度，归零则归档（永不物理删除）。
 *
 * `dryRun: true` 时**完整走一遍计算**（算出会衰减多少条、归档哪些），但**不写数据库**——
 * 因为这是一次改全库的批量操作，得先让人看清会发生什么再真跑。
 */
export function decayAndArchive(
  db: DatabaseSync,
  opts: { now?: number; today?: string; dryRun?: boolean } = {},
): DecayResult {
  const now = opts.now ?? Date.now()
  const today = opts.today ?? new Date(now).toISOString().slice(0, 10)
  const dryRun = opts.dryRun === true

  const rows = db.prepare(`SELECT * FROM memory WHERE status = 'active'`).all() as unknown as Row[]
  const update = db.prepare(
    `UPDATE memory SET strength = ?, status = ?, last_decay_at = ?, updated_at = ? WHERE id = ?`,
  )
  const logStmt = db.prepare(`INSERT INTO dream_log (run_at, action, memory_id, note) VALUES (?, ?, ?, ?)`)
  const metaStmt = db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)

  let decayed = 0
  let archived = 0
  const log: string[] = []

  for (const r of rows) {
    const score = Number(r.useful_score ?? 0)
    const tier = score >= DEFAULTS.t2At ? 2 : score >= DEFAULTS.t1At ? 1 : 0
    let step = 0
    if (tier === 0) step = DEFAULTS.t0Step
    else if (tier === 1) step = Number(r.last_recalled_at) > Number(r.last_decay_at) ? 0 : DEFAULTS.t1Step
    if (step <= 0) continue

    const next = Math.max(0, Number(r.strength) - step)
    const status = next <= 0 ? 'archived' : 'active'
    if (dryRun) {
      // 空跑：只统计，不写库
      if (status === 'archived') {
        archived++
        log.push(`[空跑] 将归档 #${r.id}（T${tier} 强度归零）：${String(r.judgment).slice(0, 40)}`)
      } else {
        decayed++
        log.push(`[空跑] #${r.id} T${tier} ${Number(r.strength).toFixed(3)} → ${next.toFixed(3)}`)
      }
      continue
    }
    update.run(next, status, now, now, r.id)
    if (status === 'archived') {
      archived++
      log.push(`归档 #${r.id}（T${tier} 强度归零）：${String(r.judgment).slice(0, 40)}`)
      logStmt.run(now, 'archive', r.id, `T${tier} 强度归零，转归档`)
    } else {
      decayed++
      logStmt.run(now, 'decay', r.id, `T${tier} ${Number(r.strength).toFixed(3)} → ${next.toFixed(3)}`)
    }
  }

  if (!dryRun) {
    metaStmt.run('lastDreamDay', today)
    logStmt.run(now, 'run', null, `decayed=${decayed} archived=${archived} total=${rows.length}`)
  }
  return dryRun ? { ok: true, decayed, archived, log, dryRun: true } : { ok: true, decayed, archived, log }
}

/** 今天是否已经整理过。 */
export function dreamRanToday(db: DatabaseSync, today = new Date().toISOString().slice(0, 10)): boolean {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'lastDreamDay'`).get() as { value?: string } | undefined
  return row?.value === today
}

/**
 * 上次整理是哪天、距今多少天（`dreamAuto: false` 时用来做「已 N 天未整理」的提醒）。
 *
 * 为什么单独一个函数：提醒要出现在两个地方（启动日志 + 面板「整理」tab），两处必须算得一模一样；
 * 而且「从没整理过」和「昨天整理过」要能区分（前者 `day`/`days` 都是 null）。
 * 只认 `YYYY-MM-DD`；meta 里存了怪值就当没有（返回 day、days 为 null），别让坏数据把提醒搞崩。
 */
export function lastDreamInfo(db: DatabaseSync, now = Date.now()): { day: string | null; days: number | null } {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'lastDreamDay'`).get() as { value?: string } | undefined
  const day = String(row?.value ?? '').trim() || null
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return { day, days: null }
  const then = Date.parse(`${day}T00:00:00Z`)
  const today = new Date(now).toISOString().slice(0, 10)
  const now0 = Date.parse(`${today}T00:00:00Z`)
  if (!Number.isFinite(then) || !Number.isFinite(now0)) return { day, days: null }
  return { day, days: Math.max(0, Math.round((now0 - then) / 86_400_000)) }
}

/**
 * 按 HH:MM 每天跑一次。返回 disposer（timer 已 unref，不会拖住宿主退出）。
 * 每分钟检查一次，到点且当天没跑就执行。
 */
export function startDreamScheduler(
  db: DatabaseSync,
  at: string,
  onRun: (r: DecayResult) => void,
): () => void {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim())
  const hour = m ? Math.min(23, Math.max(0, Number(m[1]))) : 22
  const minute = m ? Math.min(59, Math.max(0, Number(m[2]))) : 0

  const tick = (): void => {
    const now = new Date()
    const today = new Date(now.getTime()).toISOString().slice(0, 10)
    if (now.getHours() !== hour || now.getMinutes() !== minute) return
    if (dreamRanToday(db, today)) return
    onRun(decayAndArchive(db, { now: now.getTime(), today }))
  }

  tick()
  const timer = setInterval(tick, 60_000)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}
