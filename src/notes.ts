/**
 * dsh-maobing-memory — 笔记（notes）。
 *
 * 笔记是**长文**，和记忆（一句判断句）分开存：正文落 Markdown 文件，SQLite 只存索引。
 * 这样正文能整篇读、能按行分页、用户也能直接拿编辑器改文件。
 *
 * 目录：<DSH_HOME>/storages/maobing-memory/notes/<id>-<slug>.md
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'

export interface NoteRow {
  id: number
  title: string
  path: string
  tags: string
  chars: number
  created_at: number
  updated_at: number
}

export interface NoteListItem extends NoteRow {
  excerpt: string
}

/** 笔记目录（跟记忆库放在同一个 storages 目录下）。 */
export function notesDir(dbPath?: string): string {
  if (dbPath) return join(dirname(dbPath), 'notes')
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'storages', 'maobing-memory', 'notes')
}

export const NOTE_SCHEMA = `
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
`

function slugify(title: string): string {
  const safe = String(title ?? '')
    .replace(/[<>:"/\\|?*\n\r\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  return (safe.length > 60 ? safe.slice(0, 60) : safe) || 'untitled'
}

/** 写一篇笔记：正文存文件，索引进 SQLite。同标题不覆盖，每次都是新文件。
 *
 *  为什么是「先 INSERT 占位、再 UPDATE 补名字」两步：文件名要带自增 id（`<id>-<slug>.md`），
 *  而 `path` 列是 `NOT NULL UNIQUE`，只能先插空串拿到 id，再写真正的文件名。
 *  ⚠️ 副作用：占位那一瞬间 `path = ''`，**同一时刻并发写两条会撞 UNIQUE 约束**。
 *  目前所有调用点（工具 / sync）都是顺序调用，撞不到；要支持并发就得改成「先落文件再入索引」。
 *  ⚠️ `chars` 最后写的是**文件全文长度**（含 `# 标题` 行与结尾换行），不是 `body.length`——
 *  面板列表里显示的「N 字」就是这个数。
 */
export function writeNote(
  db: DatabaseSync,
  dir: string,
  input: { title: string; body: string; tags?: string[] },
): NoteRow {
  mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const title = String(input.title ?? '').trim() || 'untitled'
  const body = String(input.body ?? '').replace(/\r\n/g, '\n').trim()
  const tags = (input.tags ?? []).filter((t) => typeof t === 'string' && t.trim()).slice(0, 13)

  const tmp = db.prepare(`INSERT INTO note (title, path, tags, chars, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
  const res = tmp.run(title, '', JSON.stringify(tags), body.length, now, now)
  const id = Number(res.lastInsertRowid)

  const fileName = `${id}-${slugify(title)}.md`
  const relPath = fileName
  const full = join(dir, fileName)
  const text = body.startsWith('# ') ? body : `# ${title}\n\n${body}`
  writeFileSync(full, text.endsWith('\n') ? text : text + '\n', 'utf8')

  db.prepare('UPDATE note SET path = ?, chars = ? WHERE id = ?').run(relPath, text.length, id)
  return db.prepare('SELECT * FROM note WHERE id = ?').get(id) as unknown as NoteRow
}

/** 改一篇笔记：title / body / tags 任意字段；body 变了就重写文件并重算 chars。
 *
 *  同一个 patch 里同时给多个字段时的**语义顺序**（改之前先看这里）：
 *  1. `body` 非空就走「整体替换」分支，此时 H1 用 `nextTitle`（body 自带 `# ` 开头则原样用）；
 *  2. 否则先 `replace` 后 `append` —— 顺序反了会先追加再替换，非常反直觉；
 *  3. `append` 会先吃掉正文尾部空白再续（`text.replace(/\s+$/, '')`），所以反复 append 不会越积越空。
 */
export interface NoteUpdatePatch {
  title?: string
  /** 整体替换正文（慎用：要交全文） */
  body?: string
  tags?: string[]
  /** 追加到正文末尾（补章节用这个） */
  append?: string
  /** 按字面替换（改错字/改某一段），all=true 替换全部 */
  replace?: { old: string; new: string; all?: boolean }
}

export function updateNote(db: DatabaseSync, dir: string, id: number, patch: NoteUpdatePatch): NoteRow | null {
  const row = db.prepare('SELECT * FROM note WHERE id = ?').get(id) as unknown as NoteRow | undefined
  if (!row) return null
  const now = Date.now()
  const nextTitle = typeof patch.title === 'string' && patch.title.trim() ? patch.title.trim() : row.title
  let chars = row.chars
  const full = join(dir, row.path)
  const needsRewrite = patch.body !== undefined || patch.append !== undefined || patch.replace !== undefined
  if (needsRewrite) {
    let text: string
    if (patch.body !== undefined) {
      const body = String(patch.body).replace(/\r\n/g, '\n').trim()
      text = body.startsWith('# ') ? body : `# ${nextTitle}\n\n${body}`
    } else {
      text = readFileSync(full, 'utf8')
      if (patch.replace !== undefined) {
        const { old: find, new: repl, all } = patch.replace
        if (!find) throw new Error('updateNote: replace.old 不能为空')
        if (!text.includes(find)) throw new Error('updateNote: 正文里找不到要替换的那段文字')
        text = all ? text.split(find).join(repl) : text.replace(find, repl)
      }
      if (patch.append !== undefined) {
        const add = String(patch.append).replace(/\r\n/g, '\n')
        text = `${text.replace(/\s+$/, '')}\n\n${add.trim()}\n`
      }
    }
    writeFileSync(full, text.endsWith('\n') ? text : text + '\n', 'utf8')
    chars = text.length
  }
  const sets: string[] = []
  const args: unknown[] = []
  if (nextTitle !== row.title) { sets.push('title = ?'); args.push(nextTitle) }
  if (patch.tags !== undefined) {
    const tags = patch.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 13)
    sets.push('tags = ?'); args.push(JSON.stringify(tags))
  }
  sets.push('chars = ?', 'updated_at = ?')
  args.push(chars, now, id)
  db.prepare(`UPDATE note SET ${sets.join(', ')} WHERE id = ?`).run(...args)
  return db.prepare('SELECT * FROM note WHERE id = ?').get(id) as unknown as NoteRow
}

/** 列表：按更新时间倒序，带摘要（正文前 N 字，去掉标题行）。 */
export function listNotes(db: DatabaseSync, dir: string, opts: { limit?: number; offset?: number; excerpt?: number } = {}): { rows: NoteListItem[]; total: number } {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 50))
  const offset = Math.max(0, opts.offset ?? 0)
  const excerptLen = Math.max(20, opts.excerpt ?? 160)
  const total = Number((db.prepare('SELECT COUNT(*) AS n FROM note').get() as { n: number }).n ?? 0)
  const rows = db
    .prepare('SELECT * FROM note ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as unknown as NoteRow[]
  return {
    rows: rows.map((r) => ({ ...r, excerpt: excerptOf(dir, r, excerptLen) })),
    total,
  }
}

/** 摘要：现读文件取正文前 N 字（去掉首行标题）。
 *
 *  每次列列表都会把**本页涉及的每个文件读一遍**（50 篇 = 50 次读盘）。盘上都是几十 KB 的
 *  markdown，代价可以接受；真要优化就把 excerpt 缓存进 note 表，**别**在这里加全局缓存
 *  （那会引入「文件改了缓存不失效」的脏读）。
 */
function excerptOf(dir: string, row: NoteRow, len: number): string {
  try {
    const text = readFileSync(join(dir, row.path), 'utf8')
    const body = text.replace(/^#\s.*\n+/, '').replace(/\s+/g, ' ').trim()
    return body.slice(0, len)
  } catch {
    return ''
  }
}

export interface NoteRead {
  found: boolean
  note?: NoteRow
  /** 本次返回的正文片段（按行） */
  text?: string
  /** 总行数 */
  totalLines?: number
  /** 本次起始行（1-based） */
  offset?: number
  /** 本次返回行数 */
  lines?: number
  /** 是否还有更多 */
  hasMore?: boolean
}

/** 按行读正文：offset 1-based，limit 行数上限（默认 400 行 / 约 3 万字）。
 *
 *  ⚠️ `totalLines` 取的是 `readFileSync(...).split('\n').length`：文件以换行结尾时会**多算 1 行**，
 *  于是最后一页的 `hasMore` 可能还是 true、翻过去却是空的。已知，记在 TODO 技术债里，暂不改
 *  （改了会影响「读下一段」的边界行为，要连冒烟一起动）。
 */
export function readNote(
  db: DatabaseSync,
  dir: string,
  id: number,
  opts: { offset?: number; limit?: number } = {},
): NoteRead {
  const row = db.prepare('SELECT * FROM note WHERE id = ?').get(id) as unknown as NoteRow | undefined
  if (!row) return { found: false }
  const file = join(dir, row.path)
  if (!existsSync(file)) return { found: false }
  const lines = readFileSync(file, 'utf8').split('\n')
  const offset = Math.max(1, opts.offset ?? 1)
  const limit = Math.min(1200, Math.max(1, opts.limit ?? 400))
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const end = offset - 1 + slice.length
  return {
    found: true,
    note: row,
    text: slice.join('\n'),
    totalLines: lines.length,
    offset,
    lines: slice.length,
    hasMore: end < lines.length,
  }
}

/** 全部笔记的正文（检索语料）。
 *
 *  `memory_note_search` 走这条：**每次检索都全量读盘**（当前量级几十篇，可接受；上千篇就得改缓存）。
 *  文件被删了直接跳过，别让一篇坏文件拖垮整个检索。
 */
export function noteDocs(db: DatabaseSync, dir: string): Array<{ id: number; title: string; text: string; tags: string[]; updatedAt: number }> {
  const rows = db.prepare('SELECT * FROM note').all() as unknown as NoteRow[]
  const out: Array<{ id: number; title: string; text: string; tags: string[]; updatedAt: number }> = []
  for (const r of rows) {
    try {
      const text = readFileSync(join(dir, r.path), 'utf8')
      const tags = (() => {
        try {
          const v: unknown = JSON.parse(r.tags)
          return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
        } catch {
          return []
        }
      })()
      out.push({ id: r.id, title: r.title, text, tags, updatedAt: r.updated_at })
    } catch {
      /* 文件被删了：跳过，不影响其它笔记 */
    }
  }
  return out
}

/** 删一篇笔记（文件 + 索引）。
 *
 *  顺序是故意的：先删文件，删失败也继续删索引。索引才是「真相」——留一条指向不存在文件的索引会让
 *  列表/检索一直报错；反过来留个孤儿 .md 无害（下次 syncNotesFromDisk 还会把它捡回来）。
 */
export function deleteNote(db: DatabaseSync, dir: string, id: number): boolean {
  const row = db.prepare('SELECT * FROM note WHERE id = ?').get(id) as unknown as NoteRow | undefined
  if (!row) return false
  try {
    const file = join(dir, row.path)
    if (existsSync(file)) unlinkSync(file)
  } catch {
    /* 文件删不掉也继续删索引 */
  }
  db.prepare('DELETE FROM note WHERE id = ?').run(id)
  return true
}

/** 启动时扫描目录，把手动丢进来的 .md 纳入索引（文件名里没有 id 的，分配一个）。
 *
 *  - 幂等靠 `path` 列的 UNIQUE + 先查一遍已知文件名；所以**改文件名等于改 path**，会被当成
 *    新笔记重新纳入（旧索引还在，要清得手工来）；
 *  - `updated_at` 用文件的 **mtime**（不是当前时间），这样手动编辑过的文件会自然排到列表前面。
 */
export function syncNotesFromDisk(db: DatabaseSync, dir: string): number {
  if (!existsSync(dir)) return 0
  let added = 0
  const known = new Set(
    (db.prepare('SELECT path FROM note').all() as Array<{ path: string }>).map((r) => r.path),
  )
  for (const name of readdirSync(dir)) {
    if (!/\.(md|txt)$/i.test(name) || known.has(name)) continue
    const full = join(dir, name)
    let text = ''
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    const first = text.split('\n').find((l) => l.trim().length > 0) ?? name
    const title = first.replace(/^#+\s*/, '').trim().slice(0, 80) || basename(name, '.md')
    const now = Math.floor(statSync(full).mtimeMs) || Date.now()
    const res = db
      .prepare('INSERT INTO note (title, path, tags, chars, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(title, name, '[]', text.length, now, now)
    void res
    added++
  }
  return added
}
