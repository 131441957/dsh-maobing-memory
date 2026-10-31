// 打包：npm pack 出 tgz，放到 dist/。产物是完整可安装包（含预构建 lib/）。
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
mkdirSync(join(root, 'dist'), { recursive: true })

const out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--silent'], {
  cwd: root,
  encoding: 'utf8',
  shell: process.platform === 'win32',
}).trim()
const tgz = out.split(/\r?\n/).filter(Boolean).pop()
if (!tgz) throw new Error('npm pack 没有输出文件名')
const dest = join(root, 'dist', tgz)
copyFileSync(join(root, tgz), dest)
console.log(JSON.stringify({ tgz: dest, bytes: statSync(dest).size, dist: readdirSync(join(root, 'dist')) }, null, 1))
