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
