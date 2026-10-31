// 从 meow-memory 迁移记忆到 maobing-memory。
//   node scripts/migrate-from-meow.mjs --src <meow 的 memory.db 路径>          # 干跑：只出对账，不写库
//   node scripts/migrate-from-meow.mjs --src <...> --go                      # 真迁移（先备份目标库！）
// 也可用环境变量 MEOW_DB 代替 --src。
// 源库永远只读打开（mode=ro）。
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

const argv = process.argv.slice(2)
const srcArgIdx = argv.indexOf('--src')
const SRC = process.env.MEOW_DB ?? (srcArgIdx >= 0 ? argv[srcArgIdx + 1] : undefined)
if (!SRC) {
  console.error(
    '缺少源库路径。\n' +
      '  用法：node scripts/migrate-from-meow.mjs --src <meow 的 memory.db 路径> [--go]\n' +
      '  或先设置环境变量 MEOW_DB。\n' +
      '  典型位置：<DSH_HOME>/storages/meow-shared/memory.db',
  )
  process.exit(2)
}
if (!existsSync(SRC)) {
  console.error(`源库不存在：${SRC}`)
  process.exit(2)
}
const DSH_HOME = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
const DST = process.env.MAOBING_DB ?? join(DSH_HOME, 'storages', 'maobing-memory', 'memory.db')
const GO = argv.includes('--go')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  uid              TEXT NOT NULL UNIQUE,
  type             TEXT NOT NULL DEFAULT 'knowledge',
  judgment         TEXT NOT NULL,
  reasoning        TEXT NOT NULL DEFAULT '',
  tags             TEXT NOT NULL DEFAULT '[]',
  project          TEXT NOT NULL DEFAULT '全局',
  strength         REAL NOT NULL DEFAULT 1.0,
  useful_score     REAL NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  last_recalled_at INTEGER NOT NULL DEFAULT 0,
  last_decay_at    INTEGER NOT NULL DEFAULT 0,
  source_session   TEXT
);
CREATE TABLE IF NOT EXISTS dream_log (id INTEGER PRIMARY KEY AUTOINCREMENT, run_at INTEGER NOT NULL, action TEXT NOT NULL, memory_id INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS soul_state (id INTEGER PRIMARY KEY CHECK (id = 1), joy REAL NOT NULL DEFAULT 0.5, anger REAL NOT NULL DEFAULT 0.5, surprise REAL NOT NULL DEFAULT 0.5, disgust REAL NOT NULL DEFAULT 0.5, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`

/** meow 的 level → 新插件 type */
const LEVEL_TYPE = {
  fact: 'knowledge',
  lesson: 'skill',
  topic: 'event',
  rules: 'knowledge',
  user: 'knowledge',
  soul: 'knowledge',
  project: 'knowledge',
}

/** project 子标签 → type（todo 归 task，其余知识） */
const SUBTYPE = { todo: 'task' }

function openRo(path) {
  return new DatabaseSync('file:///' + path.replace(/\\/g, '/') + '?mode=ro', { readOnly: true })
}

function rows(db, sql) {
  try {
    return db.prepare(sql).all()
  } catch {
    return []
  }
}

function parseTags(raw) {
  try {
    const v = JSON.parse(raw ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

function uid(now) {
  return now.toString(36).padStart(9, '0') + '-' + Math.random().toString(36).slice(2, 10)
}

function main() {
  if (!existsSync(SRC)) throw new Error(`源库不存在：${SRC}`)
  const src = openRo(SRC)
  const plan = []

  const push = (level, row) => {
    const tags = parseTags(row.keywords)
    let type = LEVEL_TYPE[level] ?? 'knowledge'
    if (level === 'project' && row.subcategory && SUBTYPE[row.subcategory]) type = SUBTYPE[row.subcategory]
    if (level === 'user') tags.push('legacy-user')
    const reasoningParts = []
    if (row.goal) reasoningParts.push(`目标：${row.goal}`)
    if (row.subcategory) reasoningParts.push(`子类：${row.subcategory}`)
    if (level !== 'fact' && level !== 'lesson' && level !== 'topic' && level !== 'project' && level !== 'rules') {
      reasoningParts.push(`来源层：${level}`)
    }
    if (row.corrected) reasoningParts.push('（纠正型记忆）')
    const status = row.status === 'active' ? 'active' : 'archived'
    plan.push({
      level,
      type,
      judgment: String(row.content ?? '').trim(),
      reasoning: reasoningParts.join('；'),
      tags: Array.from(new Set(tags)).slice(0, 13),
      project: row.project && String(row.project).trim() ? String(row.project).trim() : '全局',
      importance: Number(row.importance ?? 1),
      status,
      created_at: Number(row.created_at ?? Date.now()),
      updated_at: Number(row.updated_at ?? Date.now()),
      last_recalled_at: Number(row.last_accessed_at ?? 0),
      source_session: row.source_session ?? null,
      meow_id: row.id,
    })
  }

  for (const [level, table] of Object.entries({ fact: 'fact', lesson: 'lesson', topic: 'topic', rules: 'rules', user: 'user', project: 'project', soul: 'soul' })) {
    for (const row of rows(src, `SELECT * FROM ${table}`)) push(level, row)
  }

  const byType = {}
  const byStatus = {}
  for (const p of plan) {
    byType[p.type] = (byType[p.type] ?? 0) + 1
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1
  }
  const skipped = plan.filter((p) => !p.judgment).length

  console.log(
    JSON.stringify(
      {
        mode: GO ? 'MIGRATE' : 'DRY-RUN',
        source: SRC,
        target: DST,
        total: plan.length,
        skippedEmpty: skipped,
        byType,
        byStatus,
        sample: plan.slice(0, 3).map((p) => ({ type: p.type, project: p.project, judgment: p.judgment.slice(0, 50) })),
      },
      null,
      1,
    ),
  )

  if (!GO) {
    console.log('\n干跑结束。确认无误后加 --go 真迁移。')
    src.close()
    return
  }

  mkdirSync(DST.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
  const dst = new DatabaseSync(DST)
  dst.exec('PRAGMA journal_mode = WAL')
  dst.exec(SCHEMA)
  const existing = (dst.prepare('SELECT COUNT(*) AS n FROM memory').get() || { n: 0 }).n
  if (existing > 0) {
    console.log(`\n⚠ 目标库已有 ${existing} 条，继续会追加（不覆盖）。3 秒后开始…`)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000)
  }

  const insert = dst.prepare(
    `INSERT OR IGNORE INTO memory (uid, type, judgment, reasoning, tags, project, strength, useful_score, status, created_at, updated_at, last_recalled_at, last_decay_at, source_session)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?)`,
  )
  let inserted = 0
  dst.exec('BEGIN')
  for (const p of plan) {
    if (!p.judgment) continue
    const strength = Math.min(1, Math.max(0.1, p.importance / 4))
    const res = insert.run(
      uid(p.updated_at),
      p.type,
      p.judgment,
      p.reasoning,
      JSON.stringify(p.tags),
      p.project,
      strength,
      p.status,
      p.created_at,
      p.updated_at,
      p.last_recalled_at,
      p.source_session,
    )
    if (Number(res.changes) > 0) inserted++
  }
  dst.exec('COMMIT')
  const after = (dst.prepare('SELECT COUNT(*) AS n FROM memory').get() || { n: 0 }).n
  console.log(`\n迁移完成：计划 ${plan.length} 条，实际写入 ${inserted} 条，目标库现在 ${after} 条。`)
  dst.close()
  src.close()
}

main()
