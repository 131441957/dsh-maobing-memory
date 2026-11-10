/**
 * dsh-maobing-memory — 情绪四轴（mood）。
 *
 * 四对互斥轴（设计参考 angel_memory 的 SoulState，代码自写）：
 *   喜↔悲 joy ／ 怒↔恐 anger ／ 意料中↔出乎意料 surprise ／ 厌恶↔认可 disgust
 * 各 0~1，0.5 = 平常心。落库（soul_state 表），重启不回中线。
 *
 * 算法：
 *   ① 弹性逼近：cur += (T - cur) × STEP × elasticity
 *      elasticity = 1 / (1 + 3·dist)，dist = |cur - 0.5|（越远离中线越难继续偏）
 *   ② 自然回中：cur += (0.5 - cur) × REGRESS
 *   ③ 夹到 [0, 1]
 */
import type { DatabaseSync } from 'node:sqlite'

export interface Mood {
  joy: number
  anger: number
  surprise: number
  disgust: number
  updated_at: number
}

export const AXES = ['joy', 'anger', 'surprise', 'disgust'] as const
export type Axis = (typeof AXES)[number]

/** 轴的中文短名（注入用，越短越好）。 */
export const AXIS_LABEL: Record<Axis, string> = {
  joy: '喜',
  anger: '怒',
  surprise: '惊',
  disgust: '厌',
}

export const MOOD_DEFAULTS = {
  /** 逼近系数：模型给的目标值每次生效多少 */
  step: 0.35,
  /** 回中系数：每轮向 0.5 靠近多少 */
  regress: 0.05,
  /** 弹性强度：dist=0 时 elasticity=1，dist=0.5 时 = 1/(1+3×0.5)=0.4 */
  elasticity: 3,
  /** 明显偏离平常心的阈值（注入时会追加一句提示） */
  deviant: 0.25,
}

export const DEFAULT_MOOD: Mood = { joy: 0.5, anger: 0.5, surprise: 0.5, disgust: 0.5, updated_at: 0 }

/**
 * 每根轴两端的说法。
 *
 * 为什么需要它：四轴是**双极**的，数字本身没有语义——`怒 0.28` 不是"不怎么生气"，
 * 而是"偏忐忑"（0 = 忐忑，1 = 火大）。不给词，人看到 0.54/0.28/0.38/0.57 只会一脸问号。
 * 措辞一律用「偏 X」而不是形容词本身，避免和目标情绪混淆。
 */
export const AXIS_ENDS: Record<Axis, { low: string; high: string }> = {
  joy: { low: '丧', high: '开心' },
  anger: { low: '忐忑', high: '火大' },
  surprise: { low: '意料之中', high: '出乎意料' },
  disgust: { low: '嫌弃', high: '认可' },
}

export interface AxisReading {
  /** 原值 0~1 */
  value: number
  /** value − 0.5，正 = 偏高端，负 = 偏低端；保留两位。 */
  delta: number
  /** 人话：平常心 / 略偏忐忑 / 明显偏火大 */
  word: string
  /** 档位，面板据此决定颜色深浅；|Δ| < 0.08 平常心、< 0.22 略偏、其余明显。 */
  band: 'neutral' | 'slight' | 'clear'
}

/** 把一根轴的数值翻成人话。 */
export function readAxis(axis: Axis, value: number): AxisReading {
  const v = clamp01(value)
  const delta = Math.round((v - 0.5) * 100) / 100
  const abs = Math.abs(delta)
  if (abs < 0.08) return { value: v, delta, word: '平常心', band: 'neutral' }
  const end = delta > 0 ? AXIS_ENDS[axis].high : AXIS_ENDS[axis].low
  const band: AxisReading['band'] = abs >= 0.22 ? 'clear' : 'slight'
  // 统一成「略偏 X / 明显偏 X」，读起来才不会像「略意料之中」这种半截话
  return { value: v, delta, word: `${band === 'clear' ? '明显偏' : '略偏'}${end}`, band }
}

/** 四轴读数的整体一句话，例如「当前：明显偏忐忑（另有 1 轴略微偏移）」。 */
export function moodSummary(mood: Mood): string {
  const readings = AXES.map((a) => ({ axis: a, ...readAxis(a, mood[a]) }))
  const byAbs = (x: AxisReading, y: AxisReading): number => Math.abs(y.delta) - Math.abs(x.delta)
  const clear = readings.filter((r) => r.band === 'clear').sort(byAbs)
  const slight = readings.filter((r) => r.band === 'slight').sort(byAbs)
  if (clear.length === 0 && slight.length === 0) return '整体接近平常心'
  const main = (clear.length > 0 ? clear : slight).slice(0, 2).map((r) => r.word)
  const more = clear.length > 0 && slight.length > 0 ? `（另有 ${slight.length} 轴略微偏移）` : ''
  return `当前：${main.join('、')}${more}`
}

/** 面板/接口用的完整读数（原值 + 每轴人话 + 一句总结）。 */
export function moodReport(mood: Mood): Mood & { readings: Record<Axis, AxisReading>; summary: string } {
  const readings = {} as Record<Axis, AxisReading>
  for (const a of AXES) readings[a] = readAxis(a, mood[a])
  return { ...mood, readings, summary: moodSummary(mood) }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5
  return Math.min(1, Math.max(0, v))
}

/** 读当前情绪（没有行就返回默认，不写库）。 */
export function readMood(db: DatabaseSync): Mood {
  const row = db.prepare('SELECT joy, anger, surprise, disgust, updated_at FROM soul_state WHERE id = 1').get() as
    | { joy: number; anger: number; surprise: number; disgust: number; updated_at: number }
    | undefined
  if (!row) return { ...DEFAULT_MOOD }
  return {
    joy: clamp01(row.joy),
    anger: clamp01(row.anger),
    surprise: clamp01(row.surprise),
    disgust: clamp01(row.disgust),
    updated_at: Number(row.updated_at ?? 0),
  }
}

/** 落库（固定 id=1，upsert）。 */
export function writeMood(db: DatabaseSync, mood: Mood): void {
  db.prepare(
    `INSERT INTO soul_state (id, joy, anger, surprise, disgust, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       joy = excluded.joy, anger = excluded.anger,
       surprise = excluded.surprise, disgust = excluded.disgust,
       updated_at = excluded.updated_at`,
  ).run(clamp01(mood.joy), clamp01(mood.anger), clamp01(mood.surprise), clamp01(mood.disgust), mood.updated_at)
}

/** 弹性逼近：把 cur 往 target 推一步（target 只给要变的轴）。 */
export function approach(cur: Mood, target: Partial<Record<Axis, number>>, step = MOOD_DEFAULTS.step): Mood {
  const next: Mood = { ...cur }
  for (const axis of AXES) {
    const t = target[axis]
    if (t === undefined || !Number.isFinite(t)) continue
    const from = clamp01(cur[axis])
    const dist = Math.abs(from - 0.5)
    const elasticity = 1 / (1 + MOOD_DEFAULTS.elasticity * dist)
    next[axis] = clamp01(from + (clamp01(t) - from) * step * elasticity)
  }
  return next
}

/** 自然回中：向 0.5 靠一点（每轮调用一次）。 */
export function regress(cur: Mood, factor = MOOD_DEFAULTS.regress): Mood {
  const next: Mood = { ...cur }
  for (const axis of AXES) {
    const v = clamp01(cur[axis])
    if (Math.abs(v - 0.5) < 0.001) {
      next[axis] = 0.5
      continue
    }
    next[axis] = clamp01(v + (0.5 - v) * factor)
  }
  return next
}

/** 一行精简版（注入用）：【情绪】喜0.62 怒0.48 惊0.55 厌0.41 */
export function formatMoodLine(mood: Mood): string {
  const parts = AXES.map((a) => `${AXIS_LABEL[a]}${clamp01(mood[a]).toFixed(2)}`)
  const deviant = AXES.some((a) => Math.abs(clamp01(mood[a]) - 0.5) >= MOOD_DEFAULTS.deviant)
  return `【情绪】${parts.join(' ')}${deviant ? '（明显偏离平常心）' : ''}`
}

/** 是否全部都在平常心（用于判断"值不值得注入"）。 */
export function isNeutral(mood: Mood): boolean {
  return AXES.every((a) => Math.abs(clamp01(mood[a]) - 0.5) < 0.02)
}

/** 距离上次更新过了多少毫秒。 */
export function moodAgeMs(mood: Mood, now = Date.now()): number {
  return mood.updated_at > 0 ? Math.max(0, now - mood.updated_at) : Number.POSITIVE_INFINITY
}

/** 四轴归一化到 0~1 并补 updated_at（工具入参用）。 */
export function normalizeMoodInput(input: Partial<Record<Axis, number>>, base: Mood, now = Date.now()): Mood {
  const next: Mood = { ...base, updated_at: now }
  for (const axis of AXES) {
    const v = input[axis]
    if (v !== undefined && Number.isFinite(v)) next[axis] = clamp01(Number(v))
  }
  return next
}

/**
 * 按「距上次更新多久」动态回中，不写库。
 * 每 30 分钟回中一次（REGRESS=5%），最多 12 次（一天下来基本回平常心）。
 */
export function decayedMood(db: DatabaseSync, now = Date.now()): Mood {
  const raw = readMood(db)
  if (raw.updated_at <= 0) return raw
  const steps = Math.min(12, Math.floor(Math.max(0, now - raw.updated_at) / (30 * 60_000)))
  let m = raw
  for (let i = 0; i < steps; i++) m = regress(m)
  return m
}
