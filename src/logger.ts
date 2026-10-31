/**
 * maobing-memory — 简单文件日志。
 *
 * 为什么不直接用 ctx.logger：
 *   DSH 的运行时日志只落 error/warn，info 级别看不到；而且所有插件的日志混在一个文件里，
 *   排查本插件的问题时要在杂音里挑。所以自己写一份，落在数据目录旁边，随数据一起备份。
 *
 * 特性：
 *   - 同步追加（appendFileSync），不丢行，不阻塞事件循环太久
 *   - 行格式：`2026-10-28 12:00:00.123 [INFO] 消息`
 *   - 按大小滚动：超过 maxBytes 就把当前文件改名成 .1（只留一份旧的）
 *   - 写失败静默（日志不能反过来把插件搞挂）
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string, err?: unknown): void
  /** 日志文件绝对路径（面板/排查时给人看）。 */
  readonly path: string
}

export interface LoggerOptions {
  /** 单个文件上限，超过就滚动（默认 2 MB）。 */
  maxBytes?: number
  /** 最小级别，低于它的不写（默认 info）。 */
  minLevel?: LogLevel
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function stamp(): string {
  const d = new Date()
  const p = (n: number, len = 2) => String(n).padStart(len, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function stringifyErr(err: unknown): string {
  if (err === undefined) return ''
  if (err instanceof Error) return ` | ${err.message}${err.stack ? `\n${err.stack}` : ''}`
  if (typeof err === 'string') return ` | ${err}`
  try {
    return ` | ${JSON.stringify(err)}`
  } catch {
    return ` | ${String(err)}`
  }
}

export function createLogger(dir: string, opts: LoggerOptions = {}): Logger {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024
  const minLevel = opts.minLevel ?? 'info'
  const file = join(dir, 'maobing-memory.log')
  const backup = `${file}.1`

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch {
    /* 目录建不出来也继续，写的时候再失败 */
  }

  const rotateIfNeeded = (): void => {
    try {
      if (!existsSync(file)) return
      if (statSync(file).size < maxBytes) return
      try {
        renameSync(backup, `${backup}.tmp`)
      } catch {
        /* 没有旧备份就算了 */
      }
      renameSync(file, backup)
    } catch {
      /* 滚动失败不影响主流程 */
    }
  }

  const write = (level: LogLevel, message: string, err?: unknown): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
    try {
      rotateIfNeeded()
      appendFileSync(file, `${stamp()} [${level.toUpperCase()}] ${message}${stringifyErr(err)}\n`, 'utf8')
    } catch {
      /* 日志写失败静默 */
    }
  }

  return {
    path: file,
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m, e) => write('error', m, e),
  }
}
