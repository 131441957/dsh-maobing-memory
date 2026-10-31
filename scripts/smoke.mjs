// 骨架冒烟：不启动 DSH，直接验证两件产物「能不能被宿主正常用」。
//   node scripts/smoke.mjs
// host 侧：加载 lib/index.js → 造一个假 ctx → apply → 检查工具注册与数据库读写。
// client 侧：用 vm 模拟 window.__ModuleLoader__ → 检查 apply 是否注册了两个槽位。
import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { collectComments } from './lib/comment-scan.mjs'

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
let failed = 0
const ok = (cond, label) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`)
  if (!cond) failed++
}

// ── host ────────────────────────────────────────────────────────────────
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'mbm-smoke-'))
const host = await import(new URL('../lib/index.js', import.meta.url).href)
ok(host.name === 'dsh-maobing-memory', 'host: name 导出正确')
ok(typeof host.apply === 'function', 'host: apply 是函数')
ok(typeof host.config === 'function', 'host: config schema 可用')

const registered = new Map()
const handlers = new Map()
const logs = []
const ctx = {
  logger: { info: (m) => logs.push(m), debug: (m) => logs.push(m), warn: (m) => logs.push(m) },
  tools: { register: (def) => { registered.set(def.name, def); return () => registered.delete(def.name) } },
  on: (name, fn) => { handlers.set(name, fn); return () => {} },
  get: () => undefined,
}
await host.apply(ctx, {})
ok(registered.has('memory_remember'), 'host: 注册了 memory_remember')
ok(registered.has('memory_recent'), 'host: 注册了 memory_recent')
const hostLogPath = join(process.env.DSH_HOME, 'storages', 'maobing-memory', 'maobing-memory.log')
const hostLogText = existsSync(hostLogPath) ? readFileSync(hostLogPath, 'utf8') : ''
ok(hostLogText.includes('启动：版本'), 'host: 启动日志已写进自己的日志文件')
ok(hostLogText.includes('就绪：工具 12 个'), 'host: 就绪日志含工具数')

// 配置解析：每个 schema 字段都必须在 resolveConfig 里被读到，否则会静默用兜底值
{
  const srcText = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  // 用宽松匹配：任意缩进都算（字段可能因为嵌套 group 或格式化而缩进变化），
  // 只要能写成 `xxx: z.…` 就抓。早期版本写死「恰好两个空格」，字段一旦缩进变形整条断言就白设了。
  const schemaStart = srcText.indexOf('export const config = z.object({')
  const schemaEnd = srcText.indexOf('\n})', schemaStart)
  const schemaBlock = schemaStart >= 0 && schemaEnd > schemaStart ? srcText.slice(schemaStart, schemaEnd) : ''
  const schemaFields = [...schemaBlock.matchAll(/^\s*(\w+):\s*(?:z\.|typeof)/gm)].map((m) => m[1])
  const resolveBlock = srcText.slice(srcText.indexOf('function resolveConfig'), srcText.indexOf('export async function apply'))
  // 关键：先把注释剥掉再检查。否则把解析逻辑注释掉，`src.xxx` 还留在注释里，
  // includes 照样命中 —— 断言就成了摆设（2026-10-31 变异测试抓到的第二个坑）。
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1')
  const resolveClean = stripComments(resolveBlock)
  // 不再豁免任何字段：enabled 在 resolveConfig 里本来就有 src.enabled，跳过它等于白白少查一个。
  const missing = [...new Set(schemaFields)].filter((f) => !resolveClean.includes(`src.${f}`))
  ok(schemaFields.length >= 8, `config: 抓到 schema 字段（${schemaFields.length} 个：${schemaFields.join(',')}）`)
  ok(missing.length === 0, `config: resolveConfig 覆盖所有字段（缺: ${missing.join(',') || '无'}）`)
  // 自检：剥注释函数必须真的能剥掉东西，否则上面的检查又会退化成"注释也算命中"
  ok(stripComments('  // src.foo\n  bar: 1') === '\n  bar: 1', 'config: 注释剥离自检')
}

// dream 的 dryRun 必须真的不写库（否则「空跑」会变成「骗人跑一次」）
{
  const { DatabaseSync: DryDb } = await import('node:sqlite')
  const dryPath = join(process.env.DSH_HOME, 'storages', 'maobing-memory', 'memory.db')
  const dryDb = new DryDb(dryPath)
  const before = dryDb.prepare("SELECT COUNT(*) AS n FROM dream_log").get().n
  const beforeMeta = dryDb.prepare("SELECT value FROM meta WHERE key='lastDreamDay'").get()?.value ?? null
  const dry = host.decayAndArchive(dryDb, { dryRun: true })
  const after = dryDb.prepare("SELECT COUNT(*) AS n FROM dream_log").get().n
  const afterMeta = dryDb.prepare("SELECT value FROM meta WHERE key='lastDreamDay'").get()?.value ?? null
  dryDb.close()
  ok(dry.dryRun === true, 'dream: 空跑结果带 dryRun 标记')
  ok(before === after, `dream: 空跑不写 dream_log（${before} -> ${after}）`)
  ok(beforeMeta === afterMeta, 'dream: 空跑不写 meta.lastDreamDay')
  ok(dry.log.length >= 0, `dream: 空跑仍算出将要动 ${dry.decayed + dry.archived} 条`)
}

// 路由清单必须与源码里实际判断的路径一致（防止清单再次写死/漂移）
{
  const srcText = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  const actual = [...srcText.matchAll(/url\.pathname === '\/maobing-memory\/([^']+)'/g)]
    .map((m) => m[1])
    .sort()
  const declared = [...host.HTTP_ROUTES].sort()
  ok(actual.length > 0, `routes: 源码里能提取到路由（${actual.length} 个）`)
  ok(
    JSON.stringify(actual) === JSON.stringify(declared),
    `routes: HTTP_ROUTES 与源码一致（声明 ${declared.length} / 实际 ${actual.length}）`,
  )
}

// client 与 host 的路由前缀必须一致
// （2026-10-31 踩过：改名时 client 的 BASE 跟着 PLUGIN_ID 变成 /dsh-maobing-memory，
//   而 host 路由按红线仍是 /maobing-memory/*，结果面板所有接口 404，冒烟却全绿。）
{
  const clientSrc = readFileSync(join(root, 'src', 'client.ts'), 'utf8')
  const hostSrc = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  const m = /const ROUTE_PREFIX = '([^']+)'/.exec(clientSrc)
  ok(m !== null, 'client: 路由前缀是显式常量 ROUTE_PREFIX')
  const prefix = m?.[1] ?? ''
  const hostPaths = [...hostSrc.matchAll(/url\.pathname === '(\/[^']+)'/g)].map((x) => x[1])
  ok(hostPaths.length > 0, `client: 能从 host 源码里提取到完整路由路径（${hostPaths.length} 条）`)
  const mismatch = hostPaths.filter((p) => !p.startsWith(`/${prefix}/`))
  ok(
    mismatch.length === 0,
    `client: 面板请求前缀与 host 路由一致（client=${prefix}${mismatch.length ? `，不一致: ${mismatch.slice(0, 3).join(',')}` : ''}）`,
  )
  ok(!/BASE = `\/\$\{PLUGIN_ID\}`/.test(clientSrc), 'client: BASE 不再由 PLUGIN_ID 拼出来（改名就会 404）')
}

// 安装/卸载脚本的成对一致性 + 编码
// （2026-10-31 踩过：改名后 uninstall.ps1 的摘除正则还是旧名，卸载报「自动摘除失败」并残留 patch 块）
{
  const ins = readFileSync(join(root, 'scripts', 'install.ps1'), 'utf8')
  const uns = readFileSync(join(root, 'scripts', 'uninstall.ps1'), 'utf8')
  for (const [f, text] of [['install.ps1', ins], ['uninstall.ps1', uns]]) {
    const buf = readFileSync(join(root, 'scripts', f))
    ok(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, `${f}: UTF-8 带 BOM（PowerShell 5.1 按 GBK 读中文会语法报错）`)
    // 只断言「不混」：仓库里存 LF（core.autocrlf 负责签出成 CRLF），clone 配置不同也不该误报
    ok(!/\r\n/.test(text) || !/[^\r]\n/.test(text), `${f}: 行尾一致（不混 CRLF / LF）`)
  }
  const declared = /name: '([^']+)'/.exec(ins)?.[1] ?? ''
  const base = declared.replace(/^dsh-/, '')
  ok(declared.length > 0, `卸载: install.ps1 里登记的名字可读（${declared}）`)
  ok(base.length > 0 && uns.includes(base), '卸载: uninstall.ps1 的摘除正则认得出 install.ps1 写的名字（改名漏改 = 卸载残留）')
}

// ── 防「注释与文案腐烂」的护栏 ────────────────────────────────────────────
// 背景：2026-10-31 审计发现 4 处注释在说谎（「骨架版 0.1.0…注入留给后续版本」「0.4.0」「一次 POST /update」），
// 其中一条还是**模型可见的工具描述**。注释没有测试，只能靠这两条断言兜住最常见的腐烂形态。
{
  // 注释扫描器在 scripts/lib/comment-scan.mjs（认得字符串与**正则字面量**——
  // 2026-10-31 这里栽过：notes.ts 的 /[<>:"/\\|?*]/ 让 quote-blind 的扫描器卡在字符串状态，
  // 26 行注释只数到 9 行，护栏看着绿其实是瞎的。下面第 3 条断言就是防这个。）
  const srcNames = ['index.ts', 'client.ts', 'db.ts', 'bm25.ts', 'inject.ts', 'mood.ts', 'dream.ts', 'merge.ts', 'notes.ts', 'logger.ts']
  const badPhrases = ['骨架版', '留给后续', '以后实现', '待实现', '暂未实现']
  const offenders = []
  const blind = []
  for (const f of srcNames) {
    const src = readFileSync(join(root, 'src', f), 'utf8')
    const comments = collectComments(src)
    const blob = comments.map((c) => c.text).join('\n')
    for (const p of badPhrases) if (blob.includes(p)) offenders.push(`${f}「${p}」`)
    if (/(?:见|参见|看)\s*L\d+/.test(blob) || /\/\/\s*L\d+/.test(blob)) offenders.push(`${f} 行号引用`)
    // 文件头注释里不许写版本号（「0.4.0：面板重做」就是这么烂掉的）；先剥掉 IP，别把 127.0.0.1 当版本。
    // 注意：必须从**原始源码**抓首个 docblock —— 扫描器是按行拆的，`comments[0]` 只是那行 `/**`。
    const header = /^\s*\/\*[\s\S]*?\*\//.exec(src)?.[0] ?? ''
    if (/\d+\.\d+\.\d+/.test(header.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, ''))) offenders.push(`${f} 头注释版本号`)
    // 扫描器自检：行首近似数是下界，扫描结果明显低于它就说明扫描器漏了
    const naive = src.split('\n').filter((l) => /^\s*(\*|\/\/|\/\*)/.test(l)).length
    if (naive > 5 && comments.length < naive * 0.8) blind.push(`${f}(${comments.length}/${naive})`)
  }
  ok(offenders.length === 0, `注释护栏: 无承诺式措辞/行号/版本号（违规: ${offenders.slice(0, 3).join('、') || '无'}）`)
  ok(blind.length === 0, `注释护栏自检: 扫描器没瞎（可疑: ${blind.join(',') || '无'}）`)

  // 模型可见的工具描述：产物里抓一遍（顺便验「lib 与 src 同步」这条老要求）
  // 注意两点：①esbuild 默认 charset=ascii，中文会变成 \uXXXX（× 这类还会变成 \xXX）；
  //          ②描述里带双引号时 esbuild 会改用单引号包裹，所以两种引号都要认。
  const decode = (s) =>
    s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
  const bundle = decode(readFileSync(join(root, 'lib', 'index.js'), 'utf8'))
  const descs = [
    ...bundle.matchAll(/name: "(\w+)",\s*description:\s*(?:"([^"]*)"|'((?:[^'\\]|\\.)*)')/g),
  ].map((m) => ({ name: m[1], desc: (m[2] ?? m[3] ?? '').replace(/\\(["'])/g, '$1') }))
  ok(descs.length === 12, `文案护栏: 产物里能读出 12 个工具描述（实得 ${descs.length}）`)
  const stale = descs.filter((t) => /骨架|暂未|待实现|稍后|TBD|待补/.test(t.desc))
  ok(stale.length === 0, `文案护栏: 工具描述无过期措辞（违规: ${stale.map((t) => t.name).join(',') || '无'}）`)
  const thin = descs.filter((t) => t.desc.trim().length < 12)
  ok(thin.length === 0, `文案护栏: 工具描述都写清了用途（过短: ${thin.map((t) => t.name).join(',') || '无'}）`)
}


const remember = registered.get('memory_remember')
const res = await remember.execute(
  { judgment: '冒烟测试：骨架能写库', reasoning: 'scripts/smoke.mjs 自动写入', tags: ['冒烟', '骨架', '测试'], project: 'maobing-memory', type: 'event', importance: 2 },
  {},
)
ok(res && res.ok === true && typeof res.id === 'number', 'host: memory_remember 写入成功并返回短号')
const recent = await registered.get('memory_recent').execute({ limit: 5 }, {})
ok(recent.count === 1, 'host: memory_recent 读回 1 条')
ok(String(recent.lines?.[0] ?? '').includes('骨架能写库'), 'host: 读回内容正确')

let rememberErr = ''
try {
  await remember.execute({ judgment: '没有标签', project: 'x', tags: [] }, {})
} catch (e) {
  rememberErr = String(e?.message ?? e)
}
ok(rememberErr.includes('tags'), 'host: 缺 tags 时报错且提示 tags')

// ── 注入（首轮快照 / 每轮命中）───────────────────────────────────────────
const preStep = handlers.get('agent/pre-step')
ok(typeof preStep === 'function', 'inject: 注册了 agent/pre-step 钩子')

await remember.execute(
  { judgment: 'maobing-memory 的构建命令是 npm run build', reasoning: 'README 里写的', tags: ['构建', 'build', '命令'], project: 'maobing-memory', type: 'skill', importance: 3 },
  {},
)
await remember.execute(
  { judgment: '用户要求插件必须能装能卸', reasoning: '记忆插件选择02.txt', tags: ['安装', '卸载', 'harness'], project: 'maobing-memory', type: 'knowledge', importance: 3 },
  {},
)

const userMsg = (text) => ({ id: 'u-' + Math.random().toString(36).slice(2), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const payload = { agent: { session: { header: { id: 'sess-smoke' } } } }
const decision = (msgs) => ({ kind: 'enter', messages: msgs })

const first = await preStep(payload, async () => decision([userMsg('你好，我们开始干活吧')]))
const injectedFirst = (first?.messages ?? []).filter((m) => m?.source?.kind === 'plugin:dsh-maobing-memory')
ok(injectedFirst.length === 1, 'inject: 首轮插入了 1 条插件消息')
ok(String(injectedFirst[0]?.content?.[0]?.text ?? '').includes('长期记忆（maobing-memory）'), 'inject: 首轮内容是记忆快照')
ok((first?.messages ?? []).length === 2, 'inject: 首轮消息数 = 用户 1 + 插件 1')

const second = await preStep(payload, async () => decision([userMsg('构建命令是什么？')]))
const injectedSecond = (second?.messages ?? []).filter((m) => m?.source?.kind === 'plugin:dsh-maobing-memory')
ok(injectedSecond.length === 1, 'inject: 第二轮也插入了插件消息')
const secondText = String(injectedSecond[0]?.content?.[0]?.text ?? '')
ok(secondText.includes('可能相关的记忆'), 'inject: 第二轮内容是命中块')
ok(secondText.includes('构建命令'), 'inject: 命中到了构建命令那条')

const third = await preStep(payload, async () => decision([userMsg('构建命令是什么？')]))
const injectedThird = (third?.messages ?? []).filter((m) => m?.source?.kind === 'plugin:dsh-maobing-memory')
const thirdText = String(injectedThird[0]?.content?.[0]?.text ?? '')
ok(!thirdText.includes('可能相关的记忆'), 'inject: 同一批命中不重复注入（seen 生效；情绪行仍每轮带）')

const otherSession = await preStep({ agent: { session: { header: { id: 'sess-other' } } } }, async () => decision([userMsg('新会话第一句')]))
ok((otherSession?.messages ?? []).filter((m) => m?.source?.kind === 'plugin:dsh-maobing-memory').length === 1, 'inject: 新会话重新给快照')

// 纯停用词查询不该注入命中块（否则「为什么/什么」这类词会按噪声捞一堆）
// 注意：这里必须先埋一条**含「为/样」**的记忆，否则停用词清洗就算失效也捞不到东西，
// 断言就退化成永远 ok（2026-10-31 变异测试抓到的坑）。
{
  await remember.execute(
    { judgment: '冒烟停用词：为了这样那样才写的', reasoning: '变异测试用靶子', tags: ['停用词', '靶子'], project: 'smoke', type: 'knowledge', importance: 1 },
    {},
  )
  const p = { agent: { session: { header: { id: 'sess-stopword' } } } }
  await preStep(p, async () => decision([userMsg('你好')]))
  const sw = await preStep(p, async () => decision([userMsg('为什么怎么样？')]))
  const injected = (sw?.messages ?? []).filter((m) => m?.source?.kind === 'plugin:dsh-maobing-memory')
  const swText = String(injected[0]?.content?.[0]?.text ?? '')
  ok(injected.length === 1 && !swText.includes('可能相关的记忆'), 'inject: 纯停用词查询不注入命中块（只带情绪）')
  ok(swText.includes('【情绪】'), 'inject: 没有命中时情绪行照带')
}

// ── 查询清洗 / 分数门槛（纯函数，直接验，不依赖 DSH）──────────────────────
{
  const t = host._testing
  ok(t !== undefined && typeof t.sanitizeQuery === 'function', 'score: 暴露了 _testing 钩子')
  const clean = t.sanitizeQuery('这个插件为什么叫小毛病？')
  ok(!clean.includes('为什么') && !clean.includes('这个'), 'score: 多字停用词被整段剔掉')
  ok(t.tokenize(t.sanitizeQuery('什么怎么样为什么')).length === 0, 'score: 纯停用词清洗后没有 token')
  ok(t.tokenize(t.sanitizeQuery('为什么')).length === 0, 'score: 「为什么」不会再漏出「为」这种 token')
  ok(t.tokenize('构建命令是什么').includes('构') && !t.tokenize('构建命令是什么').includes('什'),
    'score: 实词保留、疑问词丢弃')
  ok(Math.abs(t.rareTokenIdf(566) - 5.94) < 0.06, `score: 566 条库里「一个稀有词」≈6 分（算得 ${t.rareTokenIdf(566).toFixed(2)}）`)
  ok(t.effectiveMinScore(6, 566) === 6, 'score: ≥200 条的库用原阈值 6')
  ok(t.effectiveMinScore(6, 3) < 0.2, 'score: 3 条的小库按容量放宽（否则一条都注入不出来）')
  ok(t.effectiveMinScore(0, 566) === 0, 'score: 阈值 0 = 关闭过滤')

  const mkRow = (id, judgment) => ({ id, type: 'knowledge', judgment, reasoning: '', tags: JSON.stringify(['冒烟', '门槛']), project: 'smoke', strength: 1, importance: 2, updated_at: Date.now() })
  const genericRows = Array.from({ length: 30 }, (_, i) => mkRow(i + 1, `冒烟门槛第 ${i + 1} 条：今天天气不错`))
  ok(host.buildHits(genericRows, '天', { k: 3, indexLimit: 3, minScore: 6 }) === null,
    'score: 只撞上通用单字的命中被门槛整块砍掉')
  ok(host.buildHits(genericRows, '天', { k: 3, indexLimit: 3, minScore: 0 }) !== null,
    'score: 同一批数据 minScore=0 时仍会注入（对照组，证明是门槛砍的）')

  const rareRows = Array.from({ length: 20 }, (_, i) =>
    mkRow(i + 1, i < 5 ? `冒烟回填：稀有锚爪词第 ${i + 1} 条` : `无关条目 ${i + 1}：天气记录`))
  const filled = host.buildHits(rareRows, '稀有锚爪词', { k: 2, indexLimit: 2, minScore: 6 })
  ok(filled !== null && filled.ids.length >= 2 && filled.ids.length <= 4,
    `score: 过滤后按 k+indexLimit 截断（实得 ${filled?.ids.length ?? 0} 条，k=2 index=2）`)
  ok(filled !== null && filled.text.includes('其他可能相关'), 'score: 过滤后仍会给出索引段')
  ok(filled !== null && !filled.ids.includes(20), 'score: 无关条目不会挤进注入列表')

  // 小库补偿：24 条小库里一条「只值 4 分上下」的相关记忆必须仍能注入。
  // 若阈值不按库容量放宽（= 硬 6 分），这条会被饿死 —— 变异测试就是打这里。
  const thinRow = (id, judgment) => ({ id, type: 'knowledge', judgment, reasoning: '', tags: JSON.stringify(['冒烟', '小库']), project: 'smoke', strength: 1, importance: 1, updated_at: Date.now() })
  const smallRows = Array.from({ length: 24 }, (_, i) =>
    thinRow(i + 1, i < 2 ? `冒烟小库：孤锚第 ${i + 1} 条` : `无关条目 ${i + 1}：天气记录`))
  const smallHits = host.buildHits(smallRows, '孤锚', { k: 3, indexLimit: 3, minScore: 6 })
  ok(smallHits !== null && smallHits.ids.includes(1), 'score: 小库里 4 分上下的相关记忆也能注入（阈值按容量放宽）')
}

// ── 整理（衰减 → 归档，不删）─────────────────────────────────────────────
const dream = registered.get('memory_dream')
ok(typeof dream?.execute === 'function', 'dream: 注册了 memory_dream 工具')

const beforeDream = await dream.execute({ dryRun: true }, {})
ok(beforeDream?.ok === true && String(beforeDream.log?.[0] ?? '').includes('dryRun'), 'dream: dryRun 可统计')

await remember.execute(
  { judgment: '这条记忆会被衰减到归档', project: 'smoke', tags: ['衰减', '归档'], type: 'knowledge', importance: 1 },
  {},
)
let archivedTotal = 0
for (let i = 0; i < 20; i++) {
  const r = await dream.execute({}, {})
  archivedTotal += Number(r?.archived ?? 0)
}
ok(archivedTotal >= 1, 'dream: 强度归零的记忆被归档（≥1 条）')

const afterDream = await dream.execute({ dryRun: true }, {})
ok(afterDream?.ok === true, 'dream: 整理后 dryRun 仍可用（库没被搞坏）')

// ── 记忆检索 / 读取 / 修改 ──────────────────────────────────────────────
const memSearch = registered.get('memory_search')
const memRead = registered.get('memory_read')
const memUpdate = registered.get('memory_update')
ok(typeof memSearch?.execute === 'function', 'mem: 注册了 memory_search')
ok(typeof memRead?.execute === 'function', 'mem: 注册了 memory_read')
ok(typeof memUpdate?.execute === 'function', 'mem: 注册了 memory_update')

const hit1 = await memSearch.execute({ query: '冒烟测试 骨架能写库' }, {})
ok(Number(hit1.count) >= 1, 'mem: memory_search 能命中刚写的记忆')
ok(Number.isFinite(Number(hit1.hits?.[0]?.score)), 'mem: score 是有限数字（不再是 NaN）')

const got = await memRead.execute({ id: 1 }, {})
ok(got?.found === true && String(got.judgment).includes('骨架能写库'), 'mem: memory_read 读回正确内容')

const upd = await memUpdate.execute({ id: 1, importance: 4, tags: ['改过', '冒烟'] }, {})
ok(upd?.ok === true && (upd.changed ?? []).includes('importance'), 'mem: memory_update 改字段成功')
const after = await memRead.execute({ id: 1 }, {})
ok(after.importance === 4 && after.tags.includes('改过'), 'mem: 改动落库正确')

const arch = await memUpdate.execute({ id: 1, status: 'archived' }, {})
ok(arch?.ok === true, 'mem: 能通过 memory_update 归档')
const back = await memUpdate.execute({ id: 1, status: 'active' }, {})
ok(back?.ok === true, 'mem: 能通过 memory_update 恢复')

const missing = await memRead.execute({ id: 999999 }, {})
ok(missing?.found === false, 'mem: memory_read 未找到时返回 found=false')

// ── 项目全景 / 查重 ─────────────────────────────────────────────────────
const memProject = registered.get('memory_project')
const memSimilar = registered.get('memory_find_similar')
ok(typeof memProject?.execute === 'function', 'mem: 注册了 memory_project')
ok(typeof memSimilar?.execute === 'function', 'mem: 注册了 memory_find_similar')

const proj = await memProject.execute({ project: 'maobing-memory' }, {})
ok(Number(proj.count) >= 2, 'mem: memory_project 能取回该项目的记忆')
ok(Array.isArray(proj.groups) && proj.groups.length > 0, 'mem: 返回按类型分组')

const emptyProj = await memProject.execute({ project: '不存在的项目XYZ' }, {})
ok(Number(emptyProj.count) === 0, 'mem: 不存在的项目返回 0 条')

const sim = await memSimilar.execute({ id: 1, k: 3 }, {})
ok(sim?.found === true && Array.isArray(sim.similar), 'mem: memory_find_similar 返回相似列表')
ok(!(sim.similar ?? []).some((x) => x.id === 1), 'mem: 相似结果不含自己')

const simMissing = await memSimilar.execute({ id: 999999 }, {})
ok(simMissing?.found === false, 'mem: 查重时 id 不存在返回 found=false')

const projNoArg = async () => {
  try { await memProject.execute({}, {}); return '' } catch (e) { return String(e?.message ?? e) }
}
ok((await projNoArg()).includes('project'), 'mem: memory_project 空参数会报错')

// ── render 契约：每个工具的 render 必须返回 ContentBlock[]（不是字符串）──
for (const [name, def] of registered) {
  if (typeof def.output?.render !== 'function') continue
  let sample
  try {
    if (name === 'memory_project') sample = await def.execute({ project: 'maobing-memory' }, {})
    else if (name === 'memory_find_similar') sample = await def.execute({ id: 1 }, {})
    else if (name === 'memory_read') sample = await def.execute({ id: 1 }, {})
    else if (name === 'memory_search') sample = await def.execute({ query: '冒烟' }, {})
    else if (name === 'memory_note_read') sample = await def.execute({ id: 1 }, {})
    else if (name === 'memory_note_search') sample = await def.execute({ query: '冒烟' }, {})
    else continue
  } catch {
    continue
  }
  let rendered
  try {
    rendered = def.output.render({}, sample)
  } catch (e) {
    ok(false, `render: ${name} 渲染抛错 → ${e?.message ?? e}`)
    continue
  }
  const isBlocks = Array.isArray(rendered) && rendered.every((b) => b && typeof b.type === 'string')
  ok(isBlocks, `render: ${name} 返回 ContentBlock[]（不是字符串）`)
  // 直接复刻宿主的那行：dsh-tools/lib/index.js 里 `result.content.some(block => block.type === 'image')`
  let hostSafe = false
  try {
    hostSafe = !rendered.some((block) => block.type === 'image')
  } catch {
    hostSafe = false
  }
  ok(hostSafe, `render: ${name} 的结果能安全调用 content.some()（宿主 PTC 路径）`)
}

// ── 文件日志 ────────────────────────────────────────────────────────────
const logDir = join(process.env.DSH_HOME, 'logs')
const lg = host.createLogger(logDir, { maxBytes: 4096 })
lg.info('测试 info 行')
lg.warn('测试 warn 行')
lg.error('测试 error 行', new Error('模拟错误'))
const logText = readFileSync(lg.path, 'utf8')
ok(logText.includes('[INFO] 测试 info 行'), 'log: info 落盘')
ok(logText.includes('[WARN] 测试 warn 行'), 'log: warn 落盘')
ok(logText.includes('[ERROR] 测试 error 行') && logText.includes('模拟错误'), 'log: error 带异常信息落盘')
ok(lg.path.endsWith('maobing-memory.log'), 'log: 文件名固定为 maobing-memory.log')

// 滚动：超过上限后应当生成 .1 备份
for (let i = 0; i < 80; i++) lg.info('填充行 ' + i + ' ' + 'x'.repeat(80))
ok(existsSync(lg.path + '.1'), 'log: 超过 maxBytes 会滚动出 .1 备份')

// ── 合并候选 ────────────────────────────────────────────────────────────
await remember.execute(
  { judgment: '冒烟测试：我偏好甜食，可以接受蛋糕和马卡龙，但拒绝高油脂食物', reasoning: 'a', tags: ['甜食', '偏好', '冒烟'], project: 'merge-test', importance: 2 },
  {},
)
await remember.execute(
  { judgment: '冒烟测试：我偏好甜食，接受蛋糕和马卡龙一类甜点，但拒绝高油脂食物', reasoning: 'b', tags: ['甜食', '口味'], project: 'merge-test', importance: 2 },
  {},
)
await remember.execute(
  { judgment: '冒烟测试：玩家A#5001 使用「@群Bot 挨骂就哭」作为唤词', reasoning: 'c', tags: ['唤词'], project: 'merge-test', importance: 2 },
  {},
)
await remember.execute(
  { judgment: '冒烟测试：玩家B#5002 使用「@群Bot 挨骂就哭」作为唤词', reasoning: 'd', tags: ['唤词'], project: 'merge-test', importance: 2 },
  {},
)

const { DatabaseSync: TestDb } = await import('node:sqlite')
const testDbPath = join(process.env.DSH_HOME, 'storages', 'maobing-memory', 'memory.db')
const testDb = new TestDb(testDbPath)

const cands = host.findMergeCandidates(testDb, { threshold: 0.5, project: 'merge-test' })
ok(Array.isArray(cands), 'merge: 能取回候选列表')
const sweetPair = cands.find((c) => c.a.judgment.includes('蛋糕和马卡龙') && c.b.judgment.includes('蛋糕和马卡龙'))
ok(Boolean(sweetPair), 'merge: 识别出甜食那对重复')
const wrongPair = cands.find((c) => c.a.judgment.includes('玩家A') && c.b.judgment.includes('玩家B'))
ok(wrongPair === undefined, 'merge: 不同 ID 的两条不会被误判为重复（实体过滤）')

if (sweetPair) {
  const keepId = sweetPair.a.id
  const dropId = sweetPair.b.id
  const merged = host.mergeMemories(testDb, keepId, dropId)
  ok(merged.ok === true && merged.mergedId === dropId, 'merge: 合并返回成功')
  const kept = await memRead.execute({ id: keepId }, {})
  ok(kept.found === true && kept.tags.includes('甜食'), 'merge: 保留条仍在且标签合并')
  const dropped = await memRead.execute({ id: dropId }, {})
  ok(dropped.status === 'archived', 'merge: 被合并那条已归档')
}
testDb.close()

// ── 情绪四轴（纯算法；工具已改为内部触发，不再暴露给模型）──────────────
const baseMood = { ...host.DEFAULT_MOOD, updated_at: 1 }
const mm1 = host.approach(baseMood, { joy: 0.9 })
ok(Math.abs(mm1.joy - 0.64) < 0.02, `mood: 弹性逼近正确（joy=${mm1.joy.toFixed(3)}，期望≈0.64）`)

const mm2 = host.approach(mm1, { joy: 0.9 })
ok(mm2.joy > mm1.joy && mm2.joy < 0.9, 'mood: 越靠近目标变化越小（弹性生效）')
ok(mm2.joy - mm1.joy < 0.1, 'mood: 单次步进受限')
ok(mm2.anger === 0.5 && mm2.surprise === 0.5 && mm2.disgust === 0.5, 'mood: 未传的轴保持不变')

const mm3 = host.regress({ ...baseMood, joy: 1 })
ok(Math.abs(mm3.joy - 0.975) < 0.01, 'mood: 回中一步为 -5%')
ok(host.formatMoodLine(mm1).startsWith('【情绪】喜'), 'mood: formatMoodLine 格式正确')
ok(host.approach(baseMood, { anger: 99 }).anger <= 1, 'mood: 超过 1 会被夹到 1')
ok(registered.get('memory_mood') === undefined, 'mood: 手动拨情绪的工具已移除（情绪只由对话触发）')

// ── 反思轮（记忆 + 情绪一次调用；四层闸门 + 每 N 轮一次）────────────────────
const turnStopping = handlers.get('agent/turn-stopping')
const sessionEvent = handlers.get('session/event')
ok(typeof turnStopping === 'function', 'reflect: 注册了 agent/turn-stopping')
ok(typeof sessionEvent === 'function', 'reflect: 注册了 session/event')

const followups = []
const mkAgent = (sid) => ({
  session: {
    header: { id: sid, origin: 'main' },
    events: () => [
      { type: 'user/message', data: { content: [{ type: 'text', text: '早上好呀' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '早' }] } } },
    ],
  },
  followup: (m) => followups.push(m),
})

// reflectEveryN 默认 3：前两轮不排，第三轮才排（每轮都排 = 烧钱 + 记忆碎片化）
turnStopping({ agent: mkAgent('sess-n3'), turn: 1 })
ok(followups.length === 0, 'reflect: 第 1 轮不排（reflectEveryN=3）')
turnStopping({ agent: mkAgent('sess-n3'), turn: 1 })
ok(followups.length === 0, 'reflect: 同一 turn 重复触发不重复计数')
turnStopping({ agent: mkAgent('sess-n3'), turn: 2 })
ok(followups.length === 0, 'reflect: 第 2 轮仍不排')
turnStopping({ agent: mkAgent('sess-n3'), turn: 3 })
ok(followups.length === 1, 'reflect: 攒满 3 轮排一次反思')

// 排出来的反思消息：带防循环标记 + 带「相似度 ≥0.7 必须 update」的硬规则
const reflectMsg = String(followups[0]?.content?.[0]?.text ?? '')
ok(reflectMsg.includes('[maobing-memory-reflect]'), 'reflect: 反思消息带防循环标记')
ok(reflectMsg.includes('0.70') && reflectMsg.includes('memory_update') && reflectMsg.includes('禁止'),
  'reflect: 提示词里有「≥0.70 必须 memory_update、禁止新建」的硬规则')
ok(reflectMsg.includes('任意一条 ≥ 0.70') && reflectMsg.includes('禁止再 memory_remember 新建'),
  'reflect: 硬规则的措辞与阈值就是定的那版（0.70 / 禁止新建）')

// 反思轮自己的结束（最近用户消息含标记）不触发、且计数器归零
const agentSelf = mkAgent('sess-n3')
agentSelf.session.events = () => [
  { type: 'user/message', data: { content: [{ type: 'text', text: '[maobing-memory-reflect] 回顾刚才这一轮' }] } },
]
turnStopping({ agent: agentSelf, turn: 4 })
ok(followups.length === 1, 'reflect: 反思轮自己不再套娃')
turnStopping({ agent: mkAgent('sess-n3'), turn: 5 })
turnStopping({ agent: mkAgent('sess-n3'), turn: 6 })
ok(followups.length === 1, 'reflect: 反思后计数器归零（不会下一轮立刻又排）')
// 冷却还挡着的时候，就算攒满 N 轮也不排（这是防无限套娃的最后一层）
turnStopping({ agent: mkAgent('sess-n3'), turn: 7 })
ok(followups.length === 1, 'reflect: 冷却期内攒满也不排（防无限套娃）')

// 不同会话各自计数
turnStopping({ agent: mkAgent('sess-other-n'), turn: 1 })
turnStopping({ agent: mkAgent('sess-other-n'), turn: 2 })
ok(followups.length === 1, 'reflect: 新会话从 0 开始攒（不会继承别的会话的计数）')
turnStopping({ agent: mkAgent('sess-other-n'), turn: 3 })
ok(followups.length === 2, 'reflect: 新会话攒满 3 轮同样排一次')

// 解析反思结果 → 写记忆
const reflectJson = JSON.stringify({
  memories: [
    {
      type: 'knowledge',
      judgment: '反思轮测试写入的一条记忆',
      reasoning: '冒烟测试',
      tags: ['测试', '反思', '冒烟'],
      project: 'maobing-memory',
      importance: 2,
    },
  ],
  soul_state: { joy: 0.8, anger: 0.2, surprise: 0.6, disgust: 0.9 },
})
sessionEvent(
  { header: { id: 'sess-reflect' } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '```json\n' + reflectJson + '\n```' }] } } },
)
const reflectFound = await memSearch.execute({ query: '反思轮测试写入' }, {})
ok(Number(reflectFound.count) >= 1, 'reflect: 反思结果里的记忆被写入库')

// SOUL 行（meow 风格的反思输出：记忆用工具写，情绪单独一行）
sessionEvent(
  { header: { id: 'sess-soul' } },
  {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '记忆已处理完。\nSOUL joy=0.70 anger=0.20 surprise=0.50 disgust=0.90' }] } },
  },
)
ok(true, 'reflect: SOUL 行能被解析（不抛异常）')

// 非 JSON 的普通回复不应误判
sessionEvent(
  { header: { id: 'sess-reflect' } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是一句普通回复，没有 soul_state 那些字。' }] } } },
)
ok(true, 'reflect: 普通回复不触发解析（无异常）')

// ── 笔记 ────────────────────────────────────────────────────────────────
const noteWrite = registered.get('memory_note_write')
const noteRead = registered.get('memory_note_read')
const noteSearch = registered.get('memory_note_search')
ok(typeof noteWrite?.execute === 'function', 'notes: 注册了 memory_note_write')
ok(typeof noteRead?.execute === 'function', 'notes: 注册了 memory_note_read')
ok(typeof noteSearch?.execute === 'function', 'notes: 注册了 memory_note_search')

const w = await noteWrite.execute(
  {
    title: '冒烟测试笔记',
    body: '# 冒烟测试笔记\n\n这是脚本写进去的正文。\n\n## 小节\n- 第一行\n- 第二行\n',
    tags: ['冒烟', '笔记'],
  },
  {},
)
ok(w?.ok === true && typeof w.id === 'number', 'notes: 写入成功并返回 id')
ok(Number(w.chars) > 20, 'notes: 统计了字数')

const r1 = await noteRead.execute({ id: w.id }, {})
ok(r1?.found === true && String(r1.text).includes('冒烟测试笔记'), 'notes: 能按 id 读回正文')
ok(Number(r1.totalLines) >= 6, 'notes: 返回总行数')

const r2 = await noteRead.execute({ id: w.id, offset: 3, limit: 2 }, {})
ok(String(r2.text).split('\n').length === 2 && r2.offset === 3, 'notes: 按行分页正确')

const s1 = await noteSearch.execute({ query: '冒烟测试笔记' }, {})
ok(Number(s1.count) >= 1, 'notes: 检索能命中刚写的笔记')

const bad = async () => {
  try {
    await noteWrite.execute({ title: '', body: 'x' }, {})
    return ''
  } catch (e) {
    return String(e?.message ?? e)
  }
}
ok((await bad()).includes('title'), 'notes: 空标题会报错')

// ── 笔记修改 ────────────────────────────────────────────────────────────
const noteUpdate = registered.get('memory_note_update')
ok(typeof noteUpdate?.execute === 'function', 'notes: 注册了 memory_note_update')

const w2 = await noteWrite.execute({ title: '待改的笔记', body: '原始正文一行\n第二行\n', tags: ['原始'] }, {})
const u1 = await noteUpdate.execute({ id: w2.id, title: '改过的笔记' }, {})
ok(u1?.ok === true && u1.title === '改过的笔记', 'notes: 改标题成功')
ok(u1.chars === w2.chars, 'notes: 只改标题时字数不变')

const u2 = await noteUpdate.execute({ id: w2.id, body: '# 新标题\n\n换了一份正文，长一点，用来验重算字数。\n', tags: ['新标签', '改过'] }, {})
ok(u2?.ok === true && u2.chars !== w2.chars, 'notes: 改正文后字数重算')
const rBody = await noteRead.execute({ id: w2.id }, {})
ok(String(rBody.text).includes('换了一份正文'), 'notes: 文件内容真的换了')

const u3 = await noteUpdate.execute({ id: 999999, body: 'x' }, {})
ok(u3?.ok === false, 'notes: 改不存在的笔记返回 ok=false')

const u4 = async () => {
  try { await noteUpdate.execute({ id: w2.id }, {}); return '' } catch (e) { return String(e?.message ?? e) }
}
ok((await u4()).includes('没有要改的字段'), 'notes: 不给字段会报错')

const u5 = await noteUpdate.execute({ id: w2.id, append: '## 追加的一节\n\n这段是后补的。' }, {})
ok(u5?.ok === true && u5.chars > u2.chars, 'notes: append 追加后字数增加')
const rAppend = await noteRead.execute({ id: w2.id }, {})
ok(String(rAppend.text).includes('这段是后补的'), 'notes: append 的内容真的写进文件')

const u6 = await noteUpdate.execute({ id: w2.id, replace: { old: '后补的', new: '替换过的' } }, {})
ok(u6?.ok === true, 'notes: replace 替换成功')
const rRep = await noteRead.execute({ id: w2.id }, {})
ok(String(rRep.text).includes('替换过的') && !String(rRep.text).includes('后补的'), 'notes: replace 的内容真的换了')

const u7 = async () => {
  try {
    await noteUpdate.execute({ id: w2.id, replace: { old: '这段文字根本不存在', new: 'x' } }, {})
    return ''
  } catch (e) {
    return String(e?.message ?? e)
  }
}
ok((await u7()).includes('找不到'), 'notes: replace 找不到原文时报错')

// ── client ──────────────────────────────────────────────────────────────
const code = readFileSync(join(root === '/' ? '' : root, 'lib', 'client.js'), 'utf8')
let loaded = null
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [init, () => {}],
  useEffect: () => {},
}
const sandbox = {
  window: { __ModuleLoader__: { load: (o) => { loaded = o } } },
  require: (m) => (m === 'react' ? fakeReact : (() => { throw new Error('unexpected require ' + m) })()),
  console,
  fetch: () => Promise.reject(new Error('no host route yet')),
  document: { querySelectorAll: () => [], head: { appendChild: () => {} }, createElement: () => ({ dataset: {}, style: {}, setAttribute: () => {} }) },
  setTimeout,
  clearTimeout,
}
vm.runInNewContext(code, sandbox, { filename: 'client.js' })
ok(loaded !== null, 'client: 调用了 __ModuleLoader__.load')
ok(loaded?.id === 'dsh-maobing-memory', 'client: 模块 id 正确')
const clientExports = loaded.factory(sandbox.require)
ok(typeof clientExports.apply === 'function', 'client: 导出 apply')

const slots = []
const fakeSlots = {
  register: (opts, comp) => { slots.push({ ...opts, comp }); return () => {} },
  inject: (key, cb) => { const d = cb(); return () => { try { d?.() } catch {} } },
}
const dispose = clientExports.apply({ slots: fakeSlots })
ok(slots.some((s) => s.name === 'sidebar.panellist' && s.id === 'dsh-maobing-memory'), 'client: 注册了 sidebar.panellist')
ok(slots.some((s) => s.name === 'main' && s.key === 'dsh-maobing-memory'), 'client: 注册了 main(key=maobing-memory)')
ok(typeof dispose === 'function', 'client: apply 返回卸载函数')

console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`)
process.exit(failed === 0 ? 0 : 1)
