/**
 * maobing-memory — 存储层（骨架版）。
 *
 * 记忆单元 = 判断句 + 依据 + 标签 + 强度 + 项目。
 * 强度衰减到 0 一律归档（status='archived'），永不物理删除。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const MEMORY_TYPES = ['knowledge', 'event', 'skill', 'task', 'emotion'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export /**
 * 表结构。
 *
 * 几个字段为什么这么设计：
 *  - `uid`：外部稳定标识（迁移/去重用）。`id` 是自增短号给模型引用的，两者分开——
 *    id 可以变（重建库），uid 不行。
 *  - `status`：只有 active / archived 两态。**没有 deleted**——强度归零只归档，
 *    这是硬约定：宁可留一堆没用的，也不让任何一条记忆真的消失。
 *  - `strength`：会随每日整理衰减。归零 → archived，但它自己保留在 0，不重置。
 *  - `useful_score`：被召回时 +0.1 累加，是「衰减档位」的判据（≥10 永远不减）。
 *    注意它**只增不减**，所以一旦升档就不会掉回去。
 *  - `last_recalled_at` / `last_decay_at`：两者比较决定 T1 档今天该不该衰减
 *    （当天被召回过就跳过）。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  uid              TEXT NOT NULL UNIQUE,
  type             TEXT NOT NULL DEFAULT 'knowledge',
  judgment         TEXT NOT NULL,
  reasoning        TEXT NOT NULL DEFAULT '',
  tags             TEXT NOT NULL DEFAULT '[]',
  project          TEXT NOT NULL DEFAULT '全局',
  importance       INTEGER NOT NULL DEFAULT 1,
  strength         REAL NOT NULL DEFAULT 1.0,
  useful_score     REAL NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_recalled_at INTEGER NOT NULL DEFAULT 0,
  last_decay_at    INTEGER NOT NULL DEFAULT 0,
  source_session   TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project);
CREATE INDEX IF NOT EXISTS idx_memory_status ON memory(status);

CREATE TABLE IF NOT EXISTS dream_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at     INTEGER NOT NULL,
  action     TEXT NOT NULL,
  memory_id  INTEGER,
  note       TEXT
);

CREATE TABLE IF NOT EXISTS soul_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  joy        REAL NOT NULL DEFAULT 0.5,
  anger      REAL NOT NULL DEFAULT 0.5,
  surprise   REAL NOT NULL DEFAULT 0.5,
  disgust    REAL NOT NULL DEFAULT 0.5,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS note (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  path       TEXT NOT NULL UNIQUE,
  tags       TEXT NOT NULL DEFAULT '[]',
  chars      INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_updated ON note(updated_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`

/** 全局单库位置：<DSH_HOME>/storages/maobing-memory/memory.db */
export function defaultDbPath(): string {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'storages', 'maobing-memory', 'memory.db')
}

export function openDb(path = defaultDbPath()): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)
  // 老库兼容：schema 早期漏了 importance（bm25 要用），补一列并从强度近似还原
  try {
    db.exec('ALTER TABLE memory ADD COLUMN importance INTEGER NOT NULL DEFAULT 1')
    db.exec('UPDATE memory SET importance = MIN(4, MAX(1, CAST(ROUND(strength * 4) AS INTEGER))) WHERE importance = 1')
  } catch {
    /* 列已存在 */
  }
  return db
}

export interface MemoryRow {
  id: number
  uid: string
  type: string
  judgment: string
  reasoning: string
  tags: string
  project: string
  importance: number
  strength: number
  useful_score: number
  status: string
  created_at: number
  updated_at: number
  last_recalled_at: number
  last_decay_at: number
  source_session: string | null
}

function uid(now = Date.now()): string {
  const t = now.toString(36).padStart(9, '0')
  return `${t}-${Math.random().toString(36).slice(2, 10)}`
}

export function insertMemory(
  db: DatabaseSync,
  input: {
    judgment: string
    reasoning?: string
    tags?: string[]
    project?: string
    type?: string
    importance?: number
    sourceSession?: string | null
  },
): MemoryRow {
  const now = Date.now()
  const type = MEMORY_TYPES.includes((input.type ?? 'knowledge') as MemoryType) ? (input.type ?? 'knowledge') : 'knowledge'
  const strength = Math.min(1, Math.max(0.1, (input.importance ?? 1) / 4))
  const stmt = db.prepare(
    `INSERT INTO memory (uid, type, judgment, reasoning, tags, project, importance, strength, created_at, updated_at, source_session)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const res = stmt.run(
    uid(now),
    type,
    input.judgment,
    input.reasoning ?? '',
    JSON.stringify(input.tags ?? []),
    input.project ?? '全局',
    Math.min(4, Math.max(1, Math.round(input.importance ?? 1))),
    strength,
    now,
    now,
    input.sourceSession ?? null,
  )
  const id = Number(res.lastInsertRowid)
  return db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as unknown as MemoryRow
}

export function recentMemories(
  db: DatabaseSync,
  opts: { limit?: number; project?: string } = {},
): MemoryRow[] {
  const limit = Math.min(2000, Math.max(1, opts.limit ?? 5))
  if (opts.project) {
    return db
      .prepare(`SELECT * FROM memory WHERE project = ? AND status = 'active' ORDER BY updated_at DESC LIMIT ?`)
      .all(opts.project, limit) as unknown as MemoryRow[]
  }
  return db
    .prepare(`SELECT * FROM memory WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as unknown as MemoryRow[]
}

export function statsOf(db: DatabaseSync): {
  total: number
  active: number
  archived: number
  projects: Array<{ project: string; n: number }>
  projectsActive: Array<{ project: string; n: number }>
} {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM memory').get() as { n: number }).n
  const active = (db.prepare(`SELECT COUNT(*) AS n FROM memory WHERE status = 'active'`).get() as { n: number }).n
  const archived = (db.prepare(`SELECT COUNT(*) AS n FROM memory WHERE status = 'archived'`).get() as { n: number }).n
  const projects = db
    .prepare(`SELECT project, COUNT(*) AS n FROM memory GROUP BY project ORDER BY n DESC`)
    .all() as unknown as Array<{ project: string; n: number }>
  const projectsActive = db
    .prepare(`SELECT project, COUNT(*) AS n FROM memory WHERE status = 'active' GROUP BY project ORDER BY n DESC`)
    .all() as unknown as Array<{ project: string; n: number }>
  return { total, active, archived, projects, projectsActive }
}

export type ListStatus = 'active' | 'archived' | 'all'

export interface PageQuery {
  status?: ListStatus
  project?: string
  offset?: number
  limit?: number
}

/** 分页 + 状态筛选的列表（面板用）。total = 同条件下的总条数。 */
export function listPage(
  db: DatabaseSync,
  q: PageQuery = {},
): { rows: MemoryRow[]; total: number; offset: number; limit: number } {
  const status = q.status ?? 'active'
  const limit = Math.min(5000, Math.max(1, q.limit ?? 200))
  const offset = Math.max(0, q.offset ?? 0)
  const where: string[] = []
  const args: unknown[] = []
  if (status !== 'all') {
    where.push('status = ?')
    args.push(status)
  }
  if (q.project) {
    where.push('project = ?')
    args.push(q.project)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM memory ${whereSql}`).get(...args) as { n: number }).n ?? 0,
  )
  const rows = db
    .prepare(`SELECT * FROM memory ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset) as unknown as MemoryRow[]
  return { rows, total, offset, limit }
}

/** 改状态：恢复（archived → active）或归档（active → archived）。 */
export function setMemoryStatus(db: DatabaseSync, id: number, status: 'active' | 'archived'): boolean {
  const res = db.prepare('UPDATE memory SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id)
  return Number(res.changes) > 0
}

/** 按 id 取一条（面板与工具共用）。 */
export function getById(db: DatabaseSync, id: number): MemoryRow | null {
  const row = db.prepare('SELECT * FROM memory WHERE id = ?').get(id) as unknown as MemoryRow | undefined
  return row ?? null
}

export interface MemoryPatch {
  judgment?: string
  reasoning?: string
  tags?: string[]
  project?: string
  type?: string
  importance?: number
  status?: 'active' | 'archived'
}

/** 改一条记忆的字段（只改传入的），返回更新后的行。 */
export function updateMemory(db: DatabaseSync, id: number, patch: MemoryPatch): MemoryRow | null {
  const sets: string[] = []
  const args: unknown[] = []
  if (patch.judgment !== undefined) { sets.push('judgment = ?'); args.push(patch.judgment) }
  if (patch.reasoning !== undefined) { sets.push('reasoning = ?'); args.push(patch.reasoning) }
  if (patch.tags !== undefined) { sets.push('tags = ?'); args.push(JSON.stringify(patch.tags)) }
  if (patch.project !== undefined) { sets.push('project = ?'); args.push(patch.project) }
  if (patch.type !== undefined) { sets.push('type = ?'); args.push(patch.type) }
  if (patch.importance !== undefined) { sets.push('importance = ?'); args.push(patch.importance) }
  if (patch.status !== undefined) { sets.push('status = ?'); args.push(patch.status) }
  if (sets.length === 0) return getById(db, id)
  sets.push('updated_at = ?')
  args.push(Date.now())
  args.push(id)
  db.prepare(`UPDATE memory SET ${sets.join(', ')} WHERE id = ?`).run(...args)
  return getById(db, id)
}

/** 全部 active 记忆（检索语料）。limit 只是保险，不参与排序。 */
export function listActive(db: DatabaseSync, limit = 800): MemoryRow[] {
  return db
    .prepare(`SELECT * FROM memory WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as unknown as MemoryRow[]
}

/** 命中回写：刷新 last_recalled_at 并小幅加 useful_score。 */
export function markRecalled(db: DatabaseSync, ids: number[], usefulDelta = 0): void {
  if (ids.length === 0) return
  const now = Date.now()
  const stmt = db.prepare(
    'UPDATE memory SET last_recalled_at = ?, useful_score = useful_score + ? WHERE id = ?',
  )
  for (const id of ids) stmt.run(now, usefulDelta, id)
}
