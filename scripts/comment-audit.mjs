// 注释体检：把 src 里每个文件的注释密度分类统计，并把「可疑注释」逐行列出来。
//   node scripts/comment-audit.mjs
// 退出码：0 = 干净；1 = 发现可疑行（承诺式措辞 / 行号 / 头注释版本号）。
//
// 为什么要这个脚本：注释是唯一没有测试的产物，只会腐烂不会自愈。冒烟里那两条断言只能拦
// 最常见的几种形态；真正要判断「这条注释现在还是不是真的」，得有人（或模型）读一遍。
// 这个脚本负责把「该读哪几行」缩到最少。
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const srcDir = join(root, 'src')
const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts')).sort()

const BAD_PHRASES = ['骨架版', '留给后续', '以后实现', '待实现', '暂未实现']
const WHY = /为什么|因为|否则|会抛|踩过|代价|不能换|别改|注意/
const NAV = /─/

function collectComments(src) {
  const out = []
  let i = 0
  let q = null
  while (i < src.length) {
    const c = src[i]
    const c2 = src[i + 1]
    if (q) {
      if (c === '\\') { i += 2; continue }
      if (c === q) q = null
      i += 1
      continue
    }
    if (c === '/' && c2 === '/') {
      let j = src.indexOf('\n', i)
      if (j < 0) j = src.length
      out.push({ text: src.slice(i, j), line: src.slice(0, i).split('\n').length })
      i = j
      continue
    }
    if (c === '/' && c2 === '*') {
      let j = src.indexOf('*/', i + 2)
      if (j < 0) j = src.length
      const text = src.slice(i, j + 2)
      const line = src.slice(0, i).split('\n').length
      for (const l of text.split('\n')) out.push({ text: l, line })
      i = j + 2
      continue
    }
    if (c === '"' || c === "'" || c === '`') { q = c; i += 1; continue }
    i += 1
  }
  return out
}

let suspects = 0
const rows = []
for (const f of files) {
  const src = readFileSync(join(srcDir, f), 'utf8')
  const totalLines = src.split('\n').length
  const comments = collectComments(src)
  const commentLines = comments.length
  const nav = comments.filter((c) => NAV.test(c.text)).length
  const why = comments.filter((c) => WHY.test(c.text)).length
  rows.push({ file: f, totalLines, commentLines, pct: Math.round((commentLines * 100) / totalLines), nav, why })

  // 可疑行
  const firstBlock = comments.find((c) => c.text.trimStart().startsWith('/*'))
  for (const c of comments) {
    const t = c.text.trim()
    const hit = BAD_PHRASES.find((p) => t.includes(p))
    if (hit) { console.log(`  ⚠ ${f}:${c.line} 出现「${hit}」`); suspects += 1 }
    if (/(?:见|参见|看)\s*L\d+/.test(t) || /\/\/\s*L\d+/.test(t)) { console.log(`  ⚠ ${f}:${c.line} 注释里写死行号（会漂）`); suspects += 1 }
  }
  if (firstBlock) {
    const noIp = firstBlock.text.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '')
    if (/\d+\.\d+\.\d+/.test(noIp)) { console.log(`  ⚠ ${f}: 文件头注释里有版本号（会过期）`); suspects += 1 }
  }
}

console.log('\n文件              总行   注释行  占比   导航  理由/踩坑')
for (const r of rows) {
  console.log(
    `${r.file.padEnd(15)} ${String(r.totalLines).padStart(5)}  ${String(r.commentLines).padStart(5)}  ${String(r.pct + '%').padStart(4)}  ${String(r.nav).padStart(4)}  ${String(r.why).padStart(7)}`,
  )
}
const sum = rows.reduce((a, r) => ({ t: a.t + r.totalLines, c: a.c + r.commentLines, w: a.w + r.why }), { t: 0, c: 0, w: 0 })
console.log(`\n合计：${sum.t} 行 / 注释 ${sum.c} 行（${Math.round((sum.c * 100) / sum.t)}%），其中「理由/踩坑」类 ${sum.w} 行`)
console.log('判断标准：能解释「代码看不出来的东西」才算好注释；复述代码、写行号、写版本、写承诺，一律删。')
console.log(suspects === 0 ? '\n结论：没有发现可疑注释。' : `\n结论：${suspects} 处可疑，逐条看过再决定改还是删。`)
process.exit(suspects === 0 ? 0 : 1)
