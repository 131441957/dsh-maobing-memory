/**
 * dsh-maobing-memory — client 端（面板）。
 *
 * 信息架构参考 angel_memory 的 dashboard（侧栏导航式布局、统计卡片、筛选栏 + 表格 + 详情），
 * 代码全部自写（React + DSH 主题 token），未使用其 Vue 代码。
 *
 * 挂载：
 *  - sidebar.panellist：左侧栏「记忆」图标
 *  - main(key=`dsh-maobing-memory`)：中央整页面板（总览 / 记忆 / 笔记 / 检索 / 整理 五个 tab）
 *
 * 数据全部走 host 路由 `/maobing-memory/*`（**注意前缀不是插件名**，见下面 ROUTE_PREFIX）：
 *  - 只读：stats / list / search / mood / log / notes / note / merge-candidates / ui-config / dream-log
 *  - 有副作用：update / mark / mark-batch / merge / note-delete / dream?go=1
 *
 * 这些**全用 GET**（含写操作）：host 按 pathname 匹配、不校验 HTTP 方法，面板统一走 getJson 省事。
 * 只监听 127.0.0.1 + 单机单用户的前提下可以接受；真要对外多用户，就得改 POST + 校验，
 * 否则任何本地页面都能替你归档记忆。这条记在 TODO 的「技术债」里。
 *
 * 分区（改哪块直接按下面的 `// ── ` 找）：
 *   ── 设计令牌 / 类型 / 工具函数 / 小组件 / 表格行 / 详情抽屉 / 主面板
 */
import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react'

export const inject = ['slots']

const PLUGIN_ID = 'dsh-maobing-memory'
/**
 * 面板请求的 host 路由前缀。
 *
 * ⚠️ **它故意不等于 `PLUGIN_ID`**：host 端路由一直挂在 `/maobing-memory/*` 上
 * （数据目录同名、前端 20+ 处写死、改名无收益，是项目红线）。2026-10-31 改名到
 * `dsh-maobing-memory` 时这里跟着 PLUGIN_ID 一起变，结果面板**所有接口 404**——
 * 而冒烟只验了 host 端的 HTTP_ROUTES，一条都没拦住。现在改成显式常量，
 * 并在冒烟里加了「client 前缀必须等于 host 路由前缀」的断言。
 */
const ROUTE_PREFIX = 'maobing-memory'
const BASE = `/${ROUTE_PREFIX}`

// ── 设计令牌（全部用 DSH 主题变量，跟随明暗切换）─────────────────────────────
const T = {
  bg: 'var(--dsw-alias-bg-base)',
  card: 'var(--dsw-alias-bg-layer-1)',
  card2: 'var(--dsw-alias-bg-layer-2)',
  border: 'var(--dsw-alias-border-l1)',
  border2: 'var(--dsw-alias-border-l2)',
  accent: 'var(--dsw-alias-brand-primary)',
  text: 'var(--dsw-alias-label-primary)',
  text2: 'var(--dsw-alias-label-secondary)',
  ok: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  err: 'var(--dsw-alias-state-error-primary)',
  idle: 'var(--dsw-alias-state-idle-primary)',
}

const card: Record<string, unknown> = {
  background: T.card,
  border: `1px solid ${T.border}`,
  borderRadius: 14,
  padding: '16px 18px',
}

const muted: Record<string, unknown> = { color: T.text2, fontSize: 12 }

// ── 类型 ────────────────────────────────────────────────────────────────────
interface Stats {
  total: number
  active: number
  archived: number
  projects: Array<{ project: string; n: number }>
  projectsActive?: Array<{ project: string; n: number }>
}

interface Row {
  id: number
  type: string
  judgment: string
  reasoning: string
  tags: string
  project: string
  strength: number
  useful_score: number
  status: string
  created_at: number
  updated_at: number
  last_recalled_at: number
}

interface Hit {
  id: number
  judgment: string
  project: string
  type: string
  score: number
  detail: { bm25: number; tag: number; strength: number; recency: number }
}

interface MoodState {
  joy: number
  anger: number
  surprise: number
  disgust: number
  updated_at: number
}

interface MergePair {
  a: { id: number; judgment: string; project: string; importance: number; tags: string[] }
  b: { id: number; judgment: string; project: string; importance: number; tags: string[] }
  score: number
  reason: string
}

interface LogPayload {
  path: string
  lines: number
  tail: string[]
}

interface NoteRow {
  id: number
  title: string
  path: string
  tags: string
  chars: number
  created_at: number
  updated_at: number
  excerpt: string
}

interface NoteReadState {
  found: boolean
  title?: string
  text?: string
  totalLines?: number
  offset?: number
  hasMore?: boolean
}

interface DreamEntry {
  id: number
  run_at: number
  action: string
  memory_id: number | null
  note: string
}

const TYPE_TONE: Record<string, string> = {
  knowledge: '#3b82f6',
  event: '#8b5cf6',
  skill: '#10b981',
  task: '#f59e0b',
  emotion: '#ec4899',
}

// ── 工具函数 ────────────────────────────────────────────────────────────────
//
// 【将来拆到 client-api.ts 的缝（client 端唯一值得先抽的一块）】
//  这里 + 上面的「类型」段 + 时间/标签/颜色格式化（约 120 行）是**纯函数 + 一种 HTTP 封装**，
//  不持有任何 React 状态，抽出去零风险：`import { getJson, parseTags, relTime, type Row } from './client-api'`。
//  抽完以后主面板里只剩「取数 → 渲染」，也顺便把「BASE 由 ROUTE_PREFIX 拼、不是 PLUGIN_ID」
//  这条契约收在一个文件里（2026-10-31 面板 404 就是因为这条约定散在 client.ts 深处）。
async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`)
  return (await res.json()) as T
}

function parseTags(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function relTime(ts: number): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const hh = Math.floor(m / 60)
  if (hh < 24) return `${hh} 小时前`
  const d = Math.floor(hh / 24)
  if (d < 30) return `${d} 天前`
  return new Date(ts).toLocaleDateString('zh-CN')
}

function pct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`
}

// ── 小组件 ──────────────────────────────────────────────────────────────────
function StatCard({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: string }): unknown {
  return h(
    'div',
    { style: { ...card, flex: '1 1 150px', minWidth: 140 } },
    h('div', { style: { fontSize: 28, fontWeight: 680, lineHeight: 1.15, color: tone ?? T.text } }, String(value)),
    h('div', { style: { ...muted, marginTop: 6 } }, label),
    hint ? h('div', { style: { fontSize: 11, color: T.text2, opacity: 0.75, marginTop: 4 } }, hint) : null,
  )
}

function MoodBar({ label, value, tone }: { label: string; value: number; tone: string }): unknown {
  const pct = Math.max(0, Math.min(1, value)) * 100
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 8 } },
    h('span', { style: { fontSize: 12, color: T.text2, width: 16 } }, label),
    h(
      'div',
      { style: { position: 'relative', flex: 1, height: 6, borderRadius: 3, background: T.card2, overflow: 'hidden' } },
      h('div', { style: { width: `${pct}%`, height: '100%', background: tone, borderRadius: 3, transition: 'width .3s ease' } }),
      h('div', {
        style: { position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: T.border2, opacity: 0.6 },
      }),
    ),
    h('span', { style: { fontSize: 11.5, color: T.text2, width: 34, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } }, value.toFixed(2)),
  )
}

function TypeChip({ type }: { type: string }): unknown {
  const color = TYPE_TONE[type] ?? T.idle
  return h(
    'span',
    {
      style: {
        display: 'inline-block',
        fontSize: 11,
        lineHeight: '18px',
        padding: '0 8px',
        borderRadius: 999,
        color,
        background: `${color}1f`,
        border: `1px solid ${color}33`,
        whiteSpace: 'nowrap',
      },
    },
    type,
  )
}

function TagChip({ text }: { text: string }): unknown {
  return h(
    'span',
    {
      style: {
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 6,
        background: T.card2,
        border: `1px solid ${T.border}`,
        color: T.text2,
        whiteSpace: 'nowrap',
      },
    },
    text,
  )
}

function StrengthBar({ v }: { v: number }): unknown {
  const w = Math.max(0, Math.min(1, v)) * 100
  const color = v > 0.6 ? T.ok : v > 0.3 ? T.warn : T.err
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 96 } },
    h(
      'div',
      { style: { flex: 1, height: 5, borderRadius: 3, background: T.card2, overflow: 'hidden' } },
      h('div', { style: { width: `${w}%`, height: '100%', background: color, borderRadius: 3 } }),
    ),
    h('span', { style: { fontSize: 11, color: T.text2, fontVariantNumeric: 'tabular-nums', width: 30 } }, pct(v)),
  )
}

function Btn({ children, onClick, kind }: { children: unknown; onClick?: () => void; kind?: 'primary' | 'ghost' }): unknown {
  const primary = kind === 'primary'
  return h(
    'button',
    {
      onClick,
      style: {
        fontSize: 12.5,
        padding: '6px 14px',
        borderRadius: 8,
        cursor: 'pointer',
        border: `1px solid ${primary ? T.accent : T.border}`,
        background: primary ? T.accent : 'transparent',
        color: primary ? '#fff' : T.text,
        transition: 'opacity .15s ease',
      },
    },
    children,
  )
}

function Empty({ text, action }: { text: string; action?: unknown }): unknown {
  return h(
    'div',
    { style: { padding: '26px 16px', textAlign: 'center', color: T.text2, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' } },
    h('span', null, text),
    action ?? null,
  )
}

// ── 表格行 ──────────────────────────────────────────────────────────────────
const COLS = '28px 64px 88px minmax(160px,1fr) 120px 96px 76px'

function TableHead({ allChecked, onToggleAll }: { allChecked?: boolean; onToggleAll?: () => void } = {}): unknown {
  const cell = (t: string, align?: string) =>
    h('span', { style: { fontSize: 11, color: T.text2, textAlign: align ?? 'left' } }, t)
  return h(
    'div',
    {
      style: {
        display: 'grid',
        gridTemplateColumns: COLS,
        gap: 12,
        padding: '8px 12px',
        borderBottom: `1px solid ${T.border}`,
        alignItems: 'center',
      },
    },
    onToggleAll
      ? h('input', {
          type: 'checkbox',
          checked: Boolean(allChecked),
          onChange: onToggleAll,
          style: { width: 14, height: 14, cursor: 'pointer', accentColor: 'var(--dsw-alias-brand-primary)' },
        })
      : h('span'),
    cell('ID'),
    cell('类型'),
    cell('判断句'),
    cell('项目'),
    cell('强度'),
    cell('更新', 'right'),
  )
}

function RowItem({
  row,
  onClick,
  active,
  checked,
  onCheck,
}: {
  row: Row
  onClick: () => void
  active: boolean
  checked?: boolean
  onCheck?: (id: number, next: boolean) => void
}): unknown {
  const [hover, setHover] = useState(false)
  return h(
    'div',
    {
      onClick,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      style: {
        display: 'grid',
        gridTemplateColumns: COLS,
        gap: 12,
        alignItems: 'center',
        padding: '9px 12px',
        borderBottom: `1px solid ${T.border}`,
        cursor: 'pointer',
        background: active ? `${T.accent}14` : hover ? T.card2 : 'transparent',
        transition: 'background .12s ease',
      },
    },
    onCheck
      ? h('input', {
          type: 'checkbox',
          checked: Boolean(checked),
          onClick: (e: unknown) => (e as { stopPropagation: () => void }).stopPropagation(),
          onChange: (e: unknown) => onCheck(row.id, Boolean((e as { target: { checked: boolean } }).target.checked)),
          style: { width: 14, height: 14, cursor: 'pointer', accentColor: 'var(--dsw-alias-brand-primary)' },
        })
      : h('span'),
    h('span', { style: { fontSize: 12, color: T.text2, fontVariantNumeric: 'tabular-nums' } }, `#${row.id}`),
    h(TypeChip, { type: row.type }),
    h(
      'span',
      {
        style: {
          fontSize: 13,
          color: T.text,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
        title: row.judgment,
      },
      row.judgment,
    ),
    h('span', { style: { fontSize: 12, color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.project),
    h(StrengthBar, { v: row.strength }),
    h('span', { style: { fontSize: 11.5, color: T.text2, textAlign: 'right', whiteSpace: 'nowrap' } }, relTime(Number(row.updated_at ?? 0))),
  )
}

// ── 详情抽屉 ────────────────────────────────────────────────────────────────
/**
 * 详情抽屉：查看态 / 编辑态共用一个组件。
 *
 * 编辑态为什么是「整套表单」而不是逐字段就地编辑：
 *  - 改多字段时逐个 PATCH 会连发好几条请求，中间态还可能被并发覆盖；
 *  - 一次 `GET /update?…` 带齐所有字段，服务端一次写库，要么全成要么全不动。
 *    （是 GET 而不是 POST：面板所有请求都过 getJson，host 也只按 pathname 匹配不校验方法；
 *      写操作走 GET 的代价见文件头的说明。）
 *
 * 保存成功后**关掉抽屉并刷新列表**，不用返回的 row 就地更新：
 * 更新后 `updated_at`、`strength` 这些派生字段会变，抽屉里的旧快照会跟列表不一致，
 * 与其在本地重建一遍，不如重新拉一次干净数据。
 */
function Detail({
  row,
  onClose,
  onToggle,
  onSave,
}: {
  row: Row
  onClose: () => void
  onToggle: (row: Row) => void
  onSave: () => void
}): unknown {
  const tags = parseTags(row.tags)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [form, setForm] = useState({
    judgment: row.judgment,
    reasoning: row.reasoning ?? '',
    tags: tags.join(', '),
    project: row.project,
    type: row.type,
    importance: String(row.importance ?? 2),
  })

  const inputStyle = {
    fontSize: 13,
    padding: '6px 9px',
    borderRadius: 7,
    border: `1px solid ${T.border}`,
    background: T.card2,
    color: T.text,
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box' as const,
    resize: 'vertical' as const,
  }

  const field = (label: string, node: unknown) =>
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 0', borderBottom: `1px solid ${T.border}` } },
      h('span', { style: { ...muted } }, label),
      node as never,
    )

  const save = (): void => {
    const tagList = form.tags
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
    setBusy(true)
    setErr(null)
    const q = new URLSearchParams({
      id: String(row.id),
      judgment: form.judgment,
      reasoning: form.reasoning,
      tags: JSON.stringify(tagList),
      project: form.project,
      type: form.type,
      importance: form.importance,
    })
    getJson<{ ok: boolean }>(`/update?${q.toString()}`)
      .then(() => {
        setEditing(false)
        onSave()
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const kv = (k: string, v: unknown) =>
    h(
      'div',
      { style: { display: 'flex', gap: 10, padding: '7px 0', borderBottom: `1px solid ${T.border}`, alignItems: 'flex-start' } },
      h('span', { style: { ...muted, width: 76, flexShrink: 0, paddingTop: 2 } }, k),
      h('span', { style: { fontSize: 13, color: T.text, flex: 1, wordBreak: 'break-word' } }, v as never),
    )

  return h(
    'div',
    {
      style: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(480px, 48%)',
        background: T.card,
        borderLeft: `1px solid ${T.border}`,
        boxShadow: '-8px 0 32px rgba(0,0,0,.12)',
        padding: '18px 20px',
        overflow: 'auto',
        zIndex: 20,
      },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' } },
      h('span', { style: { fontSize: 15, fontWeight: 650, color: T.text } }, `记忆 #${row.id}`),
      h(TypeChip, { type: row.type }),
      h('span', { style: { flex: 1 } }),
      editing
        ? h(Btn, { children: busy ? '保存中…' : '保存', onClick: save, kind: 'primary' })
        : h(Btn, { children: '编辑', onClick: () => setEditing(true) }),
      editing
        ? h(Btn, {
            children: '取消',
            onClick: () => {
              setEditing(false)
              setErr(null)
              setForm({
                judgment: row.judgment,
                reasoning: row.reasoning ?? '',
                tags: tags.join(', '),
                project: row.project,
                type: row.type,
                importance: String(row.importance ?? 2),
              })
            },
          })
        : h(
            'button',
            {
              onClick: () => onToggle(row),
              style: {
                fontSize: 12,
                padding: '5px 12px',
                borderRadius: 7,
                cursor: 'pointer',
                border: `1px solid ${row.status === 'active' ? T.border : T.ok}`,
                background: 'transparent',
                color: row.status === 'active' ? T.text2 : T.ok,
              },
            },
            row.status === 'active' ? '归档' : '恢复',
          ),
      h('button', {
        onClick: onClose,
        style: { border: 'none', background: 'transparent', color: T.text2, cursor: 'pointer', fontSize: 18, lineHeight: 1 },
      }, '×'),
    ),
    err !== null ? h('div', { style: { fontSize: 12, color: T.err ?? T.accent, marginBottom: 8 } }, err) : null,
    editing
      ? h(
          'div',
          null,
          field(
            '判断句',
            h('textarea', {
              value: form.judgment,
              rows: 4,
              onChange: (e: unknown) => setForm({ ...form, judgment: (e as { target: { value: string } }).target.value }),
              style: inputStyle,
            }),
          ),
          field(
            '依据',
            h('textarea', {
              value: form.reasoning,
              rows: 3,
              onChange: (e: unknown) => setForm({ ...form, reasoning: (e as { target: { value: string } }).target.value }),
              style: inputStyle,
            }),
          ),
          field(
            '标签（逗号分隔，最多 13 个）',
            h('input', {
              value: form.tags,
              onChange: (e: unknown) => setForm({ ...form, tags: (e as { target: { value: string } }).target.value }),
              style: inputStyle,
            }),
          ),
          field(
            '项目',
            h('input', {
              value: form.project,
              onChange: (e: unknown) => setForm({ ...form, project: (e as { target: { value: string } }).target.value }),
              style: inputStyle,
            }),
          ),
          field(
            '类型',
            h(
              'select',
              {
                value: form.type,
                onChange: (e: unknown) => setForm({ ...form, type: (e as { target: { value: string } }).target.value }),
                style: inputStyle,
              },
              ...['knowledge', 'event', 'skill', 'task', 'emotion'].map((t) => h('option', { key: t, value: t }, t)),
            ),
          ),
          field(
            '重要性（1~4）',
            h(
              'select',
              {
                value: form.importance,
                onChange: (e: unknown) => setForm({ ...form, importance: (e as { target: { value: string } }).target.value }),
                style: inputStyle,
              },
              ...[1, 2, 3, 4].map((n) => h('option', { key: String(n), value: String(n) }, String(n))),
            ),
          ),
        )
      : h(
          'div',
          null,
          kv('判断句', row.judgment),
          row.reasoning ? kv('依据', row.reasoning) : null,
          kv('项目', row.project),
          kv('重要性', String(row.importance ?? 1)),
          kv('强度', pct(Number(row.strength ?? 0))),
          kv('有用分', Number(row.useful_score ?? 0).toFixed(1)),
          kv('状态', row.status === 'active' ? '活跃' : '归档'),
          kv('创建', new Date(row.created_at).toLocaleString('zh-CN')),
          kv('更新', new Date(row.updated_at).toLocaleString('zh-CN')),
          kv('上次召回', row.last_recalled_at ? relTime(row.last_recalled_at) : '从未'),
          tags.length > 0
            ? h(
                'div',
                { style: { padding: '10px 0' } },
                h('div', { style: { ...muted, marginBottom: 6 } }, '标签'),
                h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } }, ...tags.map((t) => h(TagChip, { key: t, text: t }))),
              )
            : null,
        ),
  )
}

// ── 主面板 ──────────────────────────────────────────────────────────────────
//
// 【不建议拆的一块】约 940 行、31 个 useState、3 个 useEffect，且状态是**横向交织**的：
//  列表的筛选/分页、抽屉的打开行、笔记的阅读偏移、检索的关键词、整理的日志刷新都挂在同一个
//  组件上，彼此通过 tab 切换互相影响（例如切 tab 要清掉抽屉、保存后要重拉列表）。
//  真要拆，正确顺序不是"按行号切"，而是**按 tab 切**：先给每个 tab 建独立的取数 hook
//  （useListData / useNotesData / useSearchData / useDreamData / useOverview），把共享的
//  `tab`、`error`、`refresh` 三个状态留在外壳，最后才把渲染拆成 5 个组件。
//  在那之前别动——拆 React 组件引入的 hook 依赖 bug，比文件长本身贵得多。
type TabKey = 'overview' | 'list' | 'notes' | 'search' | 'dream'

/**
 * 主面板：五个 tab 共用一个组件，靠 `tab` 状态切换。
 *
 * 每个 tab 的数据来源（都在首次进入时按需拉，不预加载）：
 *  - 总览：`/stats` + `/mood` + `/log` —— 统计、当前情绪四轴、插件日志尾部
 *  - 记忆：`/list`（分页，项目/状态筛选）—— 行点击开详情抽屉
 *  - 笔记：`/notes`（列表）+ `/note`（阅读，按行分页）
 *  - 检索：`/search` —— 结果里带可验算的分数分解（bm25/标签/重要/强度/新鲜度）
 *  - 整理：`/dream-log` + `/dream` —— 定时整理日志，手动触发走 go=1
 *
 * 为什么不共用一次 `/list` 全量拉：
 * 库里有上千条，全量传过来前端再筛，首屏会明显卡；分页查询的代价小得多。
 */
function MemoryPanel(): unknown {
  const [tab, setTab] = useState<TabKey>('overview')
  const [stats, setStats] = useState<Stats | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Row | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [project, setProject] = useState<string>('')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(50)
  const [status, setStatus] = useState<'active' | 'archived' | 'all'>('active')
  const [mood, setMood] = useState<MoodState | null>(null)
  const [logInfo, setLogInfo] = useState<LogPayload | null>(null)
  const [mergePairs, setMergePairs] = useState<MergePair[] | null>(null)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [mergeNotice, setMergeNotice] = useState<string | null>(null)
  const [notes, setNotes] = useState<NoteRow[] | null>(null)
  const [noteTotal, setNoteTotal] = useState(0)
  const [noteRead, setNoteRead] = useState<NoteReadState | null>(null)
  const [noteId, setNoteId] = useState<number | null>(null)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [noteBusy, setNoteBusy] = useState(false)
  const [dreamLog, setDreamLog] = useState<DreamEntry[] | null>(null)
  const [dreamBusy, setDreamBusy] = useState(false)
  /** 自动/手动整理 + 上次整理距今几天（由 /dream-log 一起带回来）。 */
  const [dreamInfo, setDreamInfo] = useState<{
    auto: boolean
    dreamAt: string
    lastDreamDay: string | null
    daysSinceDream: number | null
  } | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    Promise.all([
      getJson<Stats>('/stats'),
      getJson<{ rows: Row[]; total: number }>('/list?status=all&limit=5000'),
      getJson<MoodState>('/mood').catch(() => null),
      getJson<LogPayload>('/log?lines=12').catch(() => null),
    ])
      .then(([st, l, m, lg]) => {
        setStats(st)
        setRows(l.rows ?? [])
        if (m !== null) setMood(m)
        if (lg !== null) setLogInfo(lg)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const loadNotes = useCallback(() => {
    getJson<{ rows: NoteRow[]; total: number }>('/notes?limit=200')
      .then((r) => {
        setNotes(r.rows ?? [])
        setNoteTotal(r.total ?? 0)
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const openNote = useCallback((id: number, offset = 1) => {
    setNoteId(id)
    setNoteBusy(true)
    getJson<NoteReadState>(`/note?id=${id}&offset=${offset}&limit=800`)
      .then((r) => setNoteRead({ ...r, offset: r.offset ?? offset }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setNoteBusy(false))
  }, [])

  const loadDreamLog = useCallback(() => {
    getJson<{
      rows: DreamEntry[]
      dreamAuto?: boolean
      dreamAt?: string
      lastDreamDay?: string | null
      daysSinceDream?: number | null
    }>('/dream-log?limit=50')
      .then((r) => {
        setDreamLog(r.rows ?? [])
        setDreamInfo({
          auto: r.dreamAuto !== false,
          dreamAt: r.dreamAt ?? '22:00',
          lastDreamDay: r.lastDreamDay ?? null,
          daysSinceDream: r.daysSinceDream ?? null,
        })
      })
      .catch((e: unknown) => {
        setDreamLog([])
        setError(e instanceof Error && e.message.includes('404') ? '整理接口要重启插件才生效（host 端改动不会热重载）' : e instanceof Error ? e.message : String(e))
      })
  }, [])

  const runDream = useCallback(() => {
    setDreamBusy(true)
    getJson<{ ok: boolean; decayed: number; archived: number }>(`${'/dream'}?go=1`)
      .then(() => {
        load()
        loadDreamLog()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDreamBusy(false))
  }, [load, loadDreamLog])

  const loadMergeCandidates = useCallback(
    (project?: string) => {
      setMergeBusy(true)
      const q = project ? `&project=${encodeURIComponent(project)}` : ''
      getJson<{ count: number; candidates: MergePair[] }>(`/merge-candidates?threshold=0.55&limit=60${q}`)
        .then((r) => setMergePairs(r.candidates ?? []))
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setMergeBusy(false))
    },
    [],
  )

  const doMerge = useCallback(
    (keepId: number, dropId: number) => {
      setMergeBusy(true)
      getJson<{ ok: boolean }>(`/merge?keep=${keepId}&drop=${dropId}`)
        .then(() => {
          setMergeNotice(`✅ 已把 #${dropId} 并进 #${keepId}（原条已归档，可在记忆列表里恢复）`)
          window.setTimeout(() => setMergeNotice(null), 5000)
          // 被合并那条已经归档：所有涉及它的候选对都失效（不能只匹配 a→b 那个方向，
          // 否则点「保留 #b」时这一对不会消失，用户会以为没反应而反复点）
          setMergePairs((prev) => (prev === null ? prev : prev.filter((p) => p.a.id !== dropId && p.b.id !== dropId)))
          load()
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
        .finally(() => setMergeBusy(false))
    },
    [load],
  )

  const toggleCheck = useCallback((id: number, next: boolean) => {
    setChecked((prev) => {
      const n = new Set(prev)
      if (next) n.add(id)
      else n.delete(id)
      return n
    })
  }, [])

  const batchMark = useCallback(
    (want: 'active' | 'archived') => {
      const ids = [...checked]
      if (ids.length === 0) return
      getJson<{ ok: boolean; updated: number }>(`/mark-batch?ids=${ids.join(',')}&status=${want}`)
        .then(() => {
          setChecked(new Set())
          load()
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    },
    [checked, load],
  )

  const toggleStatus = useCallback(
    (row: Row) => {
      const want = row.status === 'active' ? 'archived' : 'active'
      getJson<{ ok: boolean }>(`/mark?id=${row.id}&status=${want}`)
        .then(() => {
          setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, status: want } : r)))
          setSelected((prev) => (prev && prev.id === row.id ? { ...prev, status: want } : prev))
          load()
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    },
    [load],
  )

  const doSearch = useCallback(() => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      return
    }
    getJson<{ hits: Hit[] }>(`/search?q=${encodeURIComponent(q)}&k=15`)
      .then((r) => setHits(r.hits ?? []))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [query])

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (status !== 'all' && r.status !== status) return false
      if (project && r.project !== project) return false
      return true
    })
  }, [rows, project, status])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageRows = filtered.slice(page * pageSize, page * pageSize + pageSize)

  // 换项目 / 换每页条数：回到第一页
  useEffect(() => {
    setPage(0)
  }, [project, pageSize, status])

  const projects = stats?.projectsActive ?? stats?.projects ?? []

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'overview', label: '总览' },
    { key: 'list', label: '记忆' },
    { key: 'notes', label: '笔记' },
    { key: 'search', label: '检索' },
    { key: 'dream', label: '整理' },
  ]

  const selectTab = (k: TabKey): void => {
    setTab(k)
    setSelected(null)
    if (k === 'dream' && dreamLog === null) loadDreamLog()
    if (k === 'notes' && notes === null) loadNotes()
  }

  const tabBar = h(
    'div',
    { style: { display: 'flex', gap: 4, background: T.card2, padding: 3, borderRadius: 10, border: `1px solid ${T.border}` } },
    ...tabs.map((t) =>
      h(
        'button',
        {
          key: t.key,
          onClick: () => selectTab(t.key),
          style: {
            fontSize: 12.5,
            padding: '5px 14px',
            borderRadius: 8,
            border: 'none',
            cursor: 'pointer',
            background: tab === t.key ? T.card : 'transparent',
            color: tab === t.key ? T.text : T.text2,
            fontWeight: tab === t.key ? 600 : 400,
            boxShadow: tab === t.key ? '0 1px 3px rgba(0,0,0,.12)' : 'none',
            transition: 'background .15s ease, color .15s ease',
          },
        },
        t.label,
      ),
    ),
  )

  const header = h(
    'div',
    { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 } },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      h('span', { style: { width: 9, height: 9, borderRadius: 5, background: T.accent, display: 'inline-block' } }),
      h('span', { style: { fontSize: 16, fontWeight: 680, color: T.text } }, '小毛病记忆'),
      h('span', { style: { fontSize: 11, color: T.text2 } }, '0.1.0'),
    ),
    h('span', { style: { flex: 1 } }),
    tabBar,
    h(Btn, { children: loading ? '…' : '刷新', onClick: load }),
  )

  const statsRow = h(
    'div',
    { style: { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 } },
    h(StatCard, { label: '活跃记忆', value: stats?.active ?? '—', tone: T.accent }),
    h(StatCard, { label: '记忆总数', value: stats?.total ?? '—' }),
    h(StatCard, { label: '已归档', value: stats?.archived ?? '—', hint: '强度归零只归档，不删' }),
    h(StatCard, { label: '项目', value: projects.length, hint: projects.slice(0, 3).map((p) => p.project).join(' / ') || '—' }),
  )

  let body: unknown

  if (error) {
    body = h(
      'div',
      { style: { ...card, borderColor: `${T.err}55`, color: T.err, fontSize: 13 } },
      `数据接口异常：${error}（看日志 [dsh-maobing-memory] routes）`,
    )
  } else if (tab === 'overview') {
    body = h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
      statsRow,
      mood
        ? h(
            'div',
            { style: { ...card } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 } },
              h('div', { style: { fontSize: 13, fontWeight: 600, color: T.text } }, '当前情绪'),
              h('span', { style: { ...muted } }, '0.5 = 平常心；每 30 分钟自然回中'),
              h('span', { style: { flex: 1 } }),
              h('span', { style: { ...muted } }, mood.updated_at ? relTime(mood.updated_at) : '还没更新过'),
            ),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
              h(MoodBar, { label: '喜', value: mood.joy, tone: '#f59e0b' }),
              h(MoodBar, { label: '怒', value: mood.anger, tone: '#ef4444' }),
              h(MoodBar, { label: '惊', value: mood.surprise, tone: '#8b5cf6' }),
              h(MoodBar, { label: '厌', value: mood.disgust, tone: '#10b981' }),
            ),
          )
        : null,
      logInfo
        ? h(
            'div',
            { style: { ...card } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 } },
              h('div', { style: { fontSize: 13, fontWeight: 600, color: T.text } }, '插件日志'),
              h('span', { style: { ...muted } }, `最近 ${logInfo.tail.length} 行`),
              h('span', { style: { flex: 1 } }),
              h('span', { style: { ...muted, fontSize: 11 } }, logInfo.path),
            ),
            h(
              'pre',
              {
                style: {
                  margin: 0,
                  padding: '8px 10px',
                  borderRadius: 6,
                  background: T.card2,
                  border: `1px solid ${T.border}`,
                  fontSize: 11,
                  lineHeight: 1.55,
                  color: T.text2,
                  maxHeight: 190,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                },
              },
              (logInfo.tail.length > 0 ? logInfo.tail.join('\n') : '（日志还是空的）'),
            ),
          )
        : null,
      h(
        'div',
        { style: { ...card } },
        h('div', { style: { fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 10 } }, '项目分布'),
        projects.length === 0
          ? h(Empty, { text: '还没有记忆' })
          : h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
              ...projects.map((p) =>
                h(
                  'button',
                  {
                    key: p.project,
                    onClick: () => {
                      setProject(p.project)
                      selectTab('list')
                    },
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 12px',
                      borderRadius: 999,
                      border: `1px solid ${T.border}`,
                      background: T.card2,
                      color: T.text,
                      fontSize: 12.5,
                      cursor: 'pointer',
                    },
                  },
                  h('span', null, p.project),
                  h('span', { style: { fontSize: 11, color: T.text2 } }, String(p.n)),
                ),
              ),
            ),
      ),
      h(
        'div',
        { style: { ...card, padding: 0, overflow: 'hidden' } },
        h('div', { style: { padding: '12px 14px', fontSize: 13, fontWeight: 600, color: T.text } }, '最近更新'),
        h(TableHead),
        rows.length === 0
          ? h(Empty, { text: loading ? '读取中…' : '还没有记忆，让助手写一条试试' })
          : rows
              .slice()
              .sort((a, b) => b.updated_at - a.updated_at)
              .slice(0, 12)
              .map((r) => h(RowItem, { key: r.id, row: r, active: selected?.id === r.id, onClick: () => setSelected(r) })),
      ),
    )
  } else if (tab === 'list') {
    body = h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      h(
        'div',
        { style: { ...card, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' } },
        h(
          'select',
          {
            value: project,
            onChange: (e: unknown) => setProject((e as { target: { value: string } }).target.value),
            style: {
              fontSize: 12.5,
              padding: '6px 10px',
              borderRadius: 8,
              border: `1px solid ${T.border}`,
              background: T.card2,
              color: T.text,
              minWidth: 140,
            },
          },
          h('option', { value: '' }, '全部项目'),
          ...projects.map((p) => h('option', { key: p.project, value: p.project }, `${p.project}（${p.n}）`)),
        ),
        h(
          'select',
          {
            value: status,
            onChange: (e: unknown) => setStatus((e as { target: { value: 'active' | 'archived' | 'all' } }).target.value),
            style: {
              fontSize: 12.5,
              padding: '6px 10px',
              borderRadius: 8,
              border: `1px solid ${T.border}`,
              background: T.card2,
              color: T.text,
            },
          },
          h('option', { value: 'active' }, '活跃'),
          h('option', { value: 'archived' }, '归档'),
          h('option', { value: 'all' }, '全部'),
        ),
        h('span', { style: { ...muted } }, `共 ${filtered.length} 条`),
        h('span', { style: { flex: 1 } }),
        h('select', {
          value: String(pageSize),
          onChange: (e: unknown) => setPageSize(Number((e as { target: { value: string } }).target.value) || 50),
          style: {
            fontSize: 12.5,
            padding: '6px 10px',
            borderRadius: 8,
            border: `1px solid ${T.border}`,
            background: T.card2,
            color: T.text,
          },
        }, ...[50, 100, 200].map((n) => h('option', { key: n, value: String(n) }, `${n} 条/页`))),
        h(Btn, { children: '清除筛选', onClick: () => setProject('') }),
        h(Btn, {
          children: mergePairs === null ? '合并候选' : '收起候选',
          onClick: () => (mergePairs === null ? loadMergeCandidates(project || undefined) : setMergePairs(null)),
        }),
      ),
      mergePairs !== null
        ? h(
            'div',
            { style: { ...card, display: 'flex', flexDirection: 'column', gap: 10 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
              h('div', { style: { fontSize: 13, fontWeight: 600, color: T.text } }, `合并候选（${mergePairs.length} 对）`),
              mergeNotice !== null
                ? h('span', { style: { fontSize: 12, fontWeight: 600, color: T.accent } }, mergeNotice)
                : null,
              h('span', { style: { ...muted } }, '同项目内判断句高度重叠；合并会把内容并进保留的那条，被并的归档'),
              h('span', { style: { flex: 1 } }),
              h(Btn, {
                children: mergeBusy ? '处理中…' : '重新扫描',
                onClick: () => loadMergeCandidates(project || undefined),
              }),
            ),
            mergePairs.length === 0
              ? h('div', { style: { ...muted } }, '没有候选（阈值 0.55）')
              : mergePairs.map((p, i) =>
                  h(
                    'div',
                    {
                      key: `${p.a.id}-${p.b.id}-${i}`,
                      style: {
                        border: `1px solid ${T.border}`,
                        borderRadius: 8,
                        padding: '10px 12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      },
                    },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                      h('span', { style: { fontSize: 12, fontWeight: 700, color: T.accent } }, p.score.toFixed(2)),
                      h('span', { style: { ...muted } }, p.reason),
                      h('span', { style: { ...muted } }, `· ${p.a.project}`),
                      h('span', { style: { flex: 1 } }),
                      h(Btn, { children: `保留 #${p.a.id}`, onClick: () => doMerge(p.a.id, p.b.id), kind: 'primary' }),
                      h(Btn, { children: `保留 #${p.b.id}`, onClick: () => doMerge(p.b.id, p.a.id) }),
                      h(Btn, {
                        children: '都留着',
                        onClick: () => setMergePairs((prev) => (prev ?? []).filter((x) => x !== p)),
                      }),
                    ),
                    h('div', { style: { fontSize: 12.5, color: T.text, lineHeight: 1.55 } }, `A #${p.a.id}｜${p.a.judgment}`),
                    h('div', { style: { fontSize: 12.5, color: T.text, lineHeight: 1.55 } }, `B #${p.b.id}｜${p.b.judgment}`),
                  ),
                ),
          )
        : null,
      checked.size > 0
        ? h(
            'div',
            {
              style: {
                ...card,
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                borderColor: T.accent,
                background: `${T.accent}12`,
              },
            },
            h('span', { style: { fontSize: 12.5, color: T.text, fontWeight: 600 } }, `已选 ${checked.size} 条`),
            h('span', { style: { flex: 1 } }),
            h(Btn, { children: '批量归档', onClick: () => batchMark('archived') }),
            h(Btn, { children: '批量恢复', onClick: () => batchMark('active'), kind: 'primary' }),
            h(Btn, { children: '取消选择', onClick: () => setChecked(new Set()) }),
          )
        : null,
      h(
        'div',
        { style: { ...card, padding: 0, overflow: 'hidden' } },
        h(TableHead, {
          allChecked: pageRows.length > 0 && pageRows.every((r) => checked.has(r.id)),
          onToggleAll: () => {
            const all = pageRows.every((r) => checked.has(r.id))
            setChecked((prev) => {
              const n = new Set(prev)
              for (const r of pageRows) {
                if (all) n.delete(r.id)
                else n.add(r.id)
              }
              return n
            })
          },
        }),
        filtered.length === 0
          ? h(Empty, {
              text: project ? `项目「${project}」下没有符合条件的记忆（共 ${rows.length} 条候选）` : '还没有记忆，让助手写一条试试',
              action: project ? h(Btn, { children: '看全部项目', onClick: () => setProject(''), kind: 'primary' }) : undefined,
            })
          : pageRows.map((r) =>
              h(RowItem, {
                key: r.id,
                row: r,
                active: selected?.id === r.id,
                checked: checked.has(r.id),
                onCheck: toggleCheck,
                onClick: () => setSelected(r),
              }),
            ),
        filtered.length > pageSize
          ? h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderTop: `1px solid ${T.border}`, justifyContent: 'flex-end' } },
              h('span', { style: { ...muted, marginRight: 'auto' } }, `第 ${page * pageSize + 1}-${Math.min(filtered.length, (page + 1) * pageSize)} 条 / 共 ${filtered.length} 条`),
              h(Btn, { children: '‹ 上一页', onClick: () => setPage(Math.max(0, page - 1)) }),
              h('span', { style: { ...muted, minWidth: 66, textAlign: 'center' } }, `${page + 1} / ${totalPages}`),
              h(Btn, { children: '下一页 ›', onClick: () => setPage(Math.min(totalPages - 1, page + 1)) }),
            )
          : null,
      ),
    )
  } else if (tab === 'notes') {
    body = h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      h(
        'div',
        { style: { ...card, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
        h(
          'div',
          null,
          h('div', { style: { fontSize: 13, fontWeight: 600, color: T.text } }, '笔记'),
          h('div', { style: { ...muted, marginTop: 4 } }, '长文存成 Markdown 文件，正文不进注入；写靠工具 memory_note_write，面板这里只读。'),
        ),
        h('span', { style: { flex: 1 } }),
        h('span', { style: { ...muted } }, `共 ${noteTotal} 篇`),
        h(Btn, { children: '刷新', onClick: loadNotes }),
      ),
      h(
        'div',
        { style: { ...card, padding: 0, overflow: 'hidden' } },
        notes === null
          ? h(Empty, { text: '读取中…' })
          : notes.length === 0
            ? h(Empty, { text: '还没有笔记。让助手用 memory_note_write 写一篇试试。' })
            : notes.map((n) =>
                h(
                  'div',
                  {
                    key: n.id,
                    onClick: () => openNote(n.id),
                    style: {
                      padding: '11px 14px',
                      borderBottom: `1px solid ${T.border}`,
                      cursor: 'pointer',
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4 } },
                    h('span', { style: { fontSize: 12, color: T.text2 } }, `#${n.id}`),
                    h('span', { style: { fontSize: 13.5, fontWeight: 600, color: T.text } }, n.title),
                    h('span', { style: { flex: 1 } }),
                    h('span', { style: { ...muted } }, `${n.chars} 字 · ${relTime(Number(n.updated_at ?? 0))}`),
                  ),
                  h('div', { style: { fontSize: 12.5, color: T.text2, lineHeight: 1.6 } }, n.excerpt || '（空）'),
                ),
              ),
      ),
    )
  } else if (tab === 'search') {
    body = h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      h(
        'div',
        { style: { ...card, display: 'flex', gap: 10 } },
        h('input', {
          value: query,
          placeholder: '输入一句话，看 BM25 怎么打分（回车检索）…',
          onChange: (e: unknown) => setQuery((e as { target: { value: string } }).target.value),
          onKeyDown: (e: unknown) => {
            if ((e as { key: string }).key === 'Enter') doSearch()
          },
          style: {
            flex: 1,
            padding: '9px 12px',
            borderRadius: 9,
            border: `1px solid ${T.border}`,
            background: T.card2,
            color: T.text,
            fontSize: 13,
            outline: 'none',
          },
        }),
        h(Btn, { children: '检索', onClick: doSearch, kind: 'primary' }),
      ),
      h(
        'div',
        { style: { ...card, padding: 0, overflow: 'hidden' } },
        hits === null
          ? h(Empty, { text: '输入检索词，下面会列出命中的记忆与分项得分' })
          : hits.length === 0
            ? h(Empty, { text: '没有命中' })
            : hits.map((hit) =>
                h(
                  'div',
                  { key: hit.id, style: { padding: '10px 14px', borderBottom: `1px solid ${T.border}` } },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4 } },
                    h('span', { style: { fontSize: 12, color: T.text2 } }, `#${hit.id}`),
                    h(TypeChip, { type: hit.type }),
                    h('span', { style: { fontSize: 12, color: T.text2 } }, hit.project),
                    h('span', { style: { flex: 1 } }),
                    h('span', { style: { fontSize: 13, fontWeight: 650, color: T.accent } }, Number(hit.score ?? 0).toFixed(2)),
                  ),
                  h('div', { style: { fontSize: 13, color: T.text, lineHeight: 1.55 } }, hit.judgment),
                  h(
                    'div',
                    { style: { ...muted, marginTop: 4, fontVariantNumeric: 'tabular-nums' } },
                    `总分 = (bm25 ${hit.detail?.bm25 ?? 0} + 标签 ${hit.detail?.tag ?? 0}) × 重要 ${hit.detail?.imp ?? 1} × 强度 ${hit.detail?.strength ?? 0} × 新鲜度 ${hit.detail?.recency ?? 0}`,
                  ),
                ),
              ),
      ),
    )
  } else {
    body = h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
      h(
        'div',
        { style: { ...card, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
        h(
          'div',
          null,
          h('div', { style: { fontSize: 13, fontWeight: 600, color: T.text } }, '每日整理'),
          h(
            'div',
            { style: { ...muted, marginTop: 4 } },
            dreamInfo === null
              ? '三档衰减，强度归零转归档，正文永不删除。'
              : `${dreamInfo.auto ? `每天 ${dreamInfo.dreamAt} 自动跑` : '自动整理已关闭（手动）'} · ` +
                `上次整理：${dreamInfo.lastDreamDay ?? '从未'}` +
                (dreamInfo.daysSinceDream === null ? '' : `（${dreamInfo.daysSinceDream} 天前）`) +
                ' · 三档衰减，强度归零转归档，正文永不删除。',
          ),
        ),
        h('span', { style: { flex: 1 } }),
        h(Btn, { children: dreamBusy ? '整理中…' : '立即整理一次', onClick: runDream, kind: 'primary' }),
      ),
      h(
        'div',
        { style: { ...card, padding: 0, overflow: 'hidden' } },
        h('div', { style: { padding: '12px 14px', fontSize: 13, fontWeight: 600, color: T.text } }, '整理日志'),
        dreamLog === null
          ? h(Empty, { text: '读取中…' })
          : dreamLog.length === 0
            ? h(Empty, {
                text:
                  dreamInfo?.auto === false
                    ? '还没有整理记录（自动整理已关闭，点上面的「立即整理一次」）'
                    : '还没有整理记录（22:00 自动跑，或点上面的按钮）',
              })
            : dreamLog.map((d) =>
                h(
                  'div',
                  {
                    key: d.id,
                    style: {
                      display: 'grid',
                      gridTemplateColumns: '150px 80px 1fr',
                      gap: 10,
                      padding: '8px 14px',
                      borderBottom: `1px solid ${T.border}`,
                      fontSize: 12.5,
                      alignItems: 'center',
                    },
                  },
                  h('span', { style: { color: T.text2 } }, d.run_at ? new Date(d.run_at).toLocaleString('zh-CN') : '—'),
                  h(TypeChip, { type: d.action === 'archive' ? 'task' : d.action === 'run' ? 'event' : 'knowledge' }),
                  h('span', { style: { color: T.text } }, d.note || (d.memory_id ? `#${d.memory_id}` : '')),
                ),
              ),
      ),
    )
  }

  return h(
    'div',
    {
      style: {
        position: 'relative',
        height: '100%',
        overflow: 'hidden',
        background: T.bg,
        display: 'flex',
        flexDirection: 'column',
      },
    },
    h('div', { style: { padding: '20px 24px 0', flexShrink: 0 } }, header),
    h('div', { style: { padding: '0 24px 20px', flex: 1, overflow: 'auto' } }, body),
    selected
      ? h(Detail, {
          row: selected,
          onClose: () => setSelected(null),
          onToggle: toggleStatus,
          // 保存后关抽屉 + 刷新列表（列表数据变了，抽屉里的旧快照会不一致）
          onSave: () => {
            setSelected(null)
            load()
          },
        })
      : null,
    noteRead
      ? h(
          'div',
          {
            style: {
              position: 'absolute',
              top: 0,
              right: 0,
              bottom: 0,
              width: 'min(560px, 55%)',
              background: T.card,
              borderLeft: `1px solid ${T.border}`,
              boxShadow: '-8px 0 32px rgba(0,0,0,.12)',
              padding: '18px 20px',
              overflow: 'auto',
              zIndex: 21,
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 } },
            h('span', { style: { fontSize: 15, fontWeight: 650, color: T.text } }, noteRead.title || '笔记'),
            h('span', { style: { ...muted } }, noteBusy ? '读取中…' : `共 ${noteRead.totalLines ?? 0} 行`),
            h('span', { style: { flex: 1 } }),
            noteRead.hasMore
              ? h(Btn, {
                  children: '读下一段 ›',
                  onClick: () => {
                    if (noteId !== null) openNote(noteId, (noteRead.offset ?? 1) + (noteRead.text ?? '').split('\n').length)
                  },
                })
              : null,
            h('button', {
              onClick: () => setNoteRead(null),
              style: { border: 'none', background: 'transparent', color: T.text2, cursor: 'pointer', fontSize: 18, lineHeight: 1 },
            }, '×'),
          ),
          h(
            'pre',
            {
              style: {
                margin: 0,
                fontSize: 12.5,
                lineHeight: 1.75,
                color: T.text,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              },
            },
            noteRead.text ?? '',
          ),
        )
      : null,
  )
}

/**
 * 情绪自评轮的「折叠」——不是折叠成横条，而是**直接藏掉**。
 *
 * 情绪自评要另起一轮（agent.followup），那会产生两条可见消息：
 *   ① 带 [maobing-memory-mood] 标记的指令消息
 *   ② 模型回的一行 MOOD joy=… anger=…
 * 两条对用户都没意义（他们要的是「我有没有被气到」，不是这串数字）。
 *
 * 做法：DOM 扫描 + 文本匹配 + CSS 隐藏，不碰 React 树（避免动宿主内部结构）。
 */
const REFLECT_MARKER = '[maobing-memory-reflect]'
const MOOD_HIDDEN_ATTR = 'data-maobing-mood-hidden'

/**
 * 把插件自己的「内部消息」从对话里藏掉，别让用户看到反思轮与情绪自评。
 *
 * 匹配规则**必须用 startsWith 而不是 includes**：
 * 早期版本用 `text.includes('[maobing-memory-mood]')`，结果把「讲解这套机制」的正常回复
 * 也一起藏了（只要正文里提到那个标记就会被误伤）。改成只匹配开头，再配合
 * 反向清理（对不满足条件的节点 removeAttribute 恢复），才不会再吃错东西。
 */
function installMoodHider(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'maobing-memory'
  style.dataset.maobingMoodCss = 'true'
  style.textContent = `[${MOOD_HIDDEN_ATTR}="true"]{display:none !important}`
  document.head.appendChild(style)

  let timer: number | undefined
  const sweep = (): void => {
    const rows = document.querySelectorAll<HTMLElement>('[data-chat-flow-key]')
    for (const el of Array.from(rows)) {
      const text = (el.textContent ?? '').trim()
      // 只认「整条就是反思轮」的形态，绝不按「包含」判断——
      // 否则正常回复里只要提到这些词，整条回复都会被吃掉（记忆 #707 的老坑）。
      const isPrompt = text.startsWith(REFLECT_MARKER)
      const isAnswer =
        (text.startsWith('{') && text.includes('"soul_state"') && text.length < 4000) ||
        /^SOUL\s+joy\s*[=:：]\s*[\d.]/i.test(text)
      if (isPrompt || isAnswer) {
        el.setAttribute(MOOD_HIDDEN_ATTR, 'true')
      } else if (el.hasAttribute(MOOD_HIDDEN_ATTR)) {
        // 反向清理：规则收紧后，之前被误伤的行要能自己露出来
        el.removeAttribute(MOOD_HIDDEN_ATTR)
      }
    }
  }
  const schedule = (): void => {
    if (timer !== undefined) return
    timer = window.setTimeout(() => {
      timer = undefined
      sweep()
    }, 120)
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })
  sweep()

  return () => {
    observer.disconnect()
    if (timer !== undefined) clearTimeout(timer)
    style.remove()
  }
}

function PanelIcon(): unknown {
  return h(
    'svg',
    { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-label': '记忆' },
    h('circle', { cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 1.6 }),
    h('circle', { cx: 9, cy: 10, r: 1.4, fill: 'currentColor' }),
    h('circle', { cx: 15, cy: 10, r: 1.4, fill: 'currentColor' }),
    h('path', { d: 'M8.5 15c1 1 2.2 1.5 3.5 1.5S14.5 16 15.5 15', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
  )
}

/**
 * 侧栏显示文字：默认「小毛病」是作者的人格名，别人装可以改成自己的。
 * 读法：先用 localStorage 缓存（同步、立即可用），再异步从 host 的 /ui-config 拉最新值。
 * 改配置后刷新页面生效。
 */
const LABEL_CACHE_KEY = 'maobing-memory-sidebar-label'
const DEFAULT_SIDEBAR_LABEL = '小毛病'

function readCachedLabel(): string {
  try {
    const v = localStorage.getItem(LABEL_CACHE_KEY)
    return v !== null && v.trim() !== '' ? v : DEFAULT_SIDEBAR_LABEL
  } catch {
    return DEFAULT_SIDEBAR_LABEL
  }
}

let sidebarLabel = readCachedLabel()

async function refreshSidebarLabel(): Promise<void> {
  try {
    const r = await getJson<{ label?: string }>('/ui-config')
    const label = typeof r?.label === 'string' && r.label.trim() !== '' ? r.label.trim() : DEFAULT_SIDEBAR_LABEL
    sidebarLabel = label
    try {
      localStorage.setItem(LABEL_CACHE_KEY, label)
    } catch {
      /* 隐私模式写不了就算了 */
    }
  } catch {
    /* 拿不到就用缓存/默认值 */
  }
}

export function apply(ctx: any): () => void {
  const disposers: Array<() => void> = []
  const slots = ctx?.slots
  if (slots === undefined) {
    console.warn('[dsh-maobing-memory] 没有 slots 服务，面板不挂载（不影响 host 端）')
    return () => {}
  }

  void refreshSidebarLabel()

  const mount = (): Array<() => void> => {
    const made: Array<() => void> = []
    try {
      made.push(slots.register({ name: 'sidebar.panellist', id: PLUGIN_ID, order: 40, label: () => sidebarLabel }, PanelIcon))
    } catch (e) {
      console.warn('[dsh-maobing-memory] 侧栏图标注册失败：', e)
    }
    try {
      made.push(slots.register({ name: 'main', key: PLUGIN_ID, order: 40 }, MemoryPanel))
    } catch (e) {
      console.warn('[dsh-maobing-memory] 主面板注册失败：', e)
    }
    return made
  }

  // 情绪自评轮的两条消息直接藏掉（纯 DOM，不碰 React 树）
  try {
    disposers.push(installMoodHider())
  } catch (e) {
    console.warn('[dsh-maobing-memory] 情绪消息折叠安装失败：', e)
  }

  if (typeof slots.inject === 'function') {
    disposers.push(
      slots.inject('sidebar.panellist', () => {
        const made = mount()
        return () => {
          for (const d of made.reverse()) {
            try {
              d()
            } catch {
              /* 卸载失败不阻塞 */
            }
          }
        }
      }),
    )
  } else {
    disposers.push(...mount())
  }

  return () => {
    for (const d of disposers.reverse()) {
      try {
        d()
      } catch {
        /* 卸载失败不阻塞 */
      }
    }
  }
}
