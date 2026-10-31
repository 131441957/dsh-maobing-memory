/**
 * Build: TS source -> deployable package.
 *
 * Two artifacts, same shape as any DSH plugin:
 *  - lib/index.js  — host entry (exports["."] / main), bundled ESM for Node.
 *  - lib/client.js — browser module in ModuleLoader.load format.
 *
 * @deepseek-ai/* packages are external: the host resolves them at runtime.
 * react stays external on the client: the shell provides the singleton.
 */
import { build, context } from 'esbuild'
import { fileURLToPath } from 'node:url'

const watch = process.argv.includes('--watch')
const nodePaths = [fileURLToPath(new URL('./node_modules', import.meta.url))]

const hostOptions = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  external: ['@deepseek-ai/*', 'node:sqlite'],
  format: 'esm',
  target: 'node22',
  nodePaths,
  outfile: 'lib/index.js',
  sourcemap: true,
  logLevel: 'info',
}

const clientOptions = {
  entryPoints: ['src/client.ts'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  nodePaths,
  outfile: 'lib/client.js',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/*'],
  banner: {
    js: [
      'window.__ModuleLoader__.load({',
      '  id: "dsh-maobing-memory",',
      '  factory: (require) => {',
      '    var module = { exports: {} };',
      '    var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: ['    return module.exports;', '  }', '});'].join('\n'),
  },
  sourcemap: true,
  logLevel: 'info',
}

if (watch) {
  await (await context(hostOptions)).watch()
  await (await context(clientOptions)).watch()
  console.log('[build] watching src/ for changes...')
} else {
  await Promise.all([build(hostOptions), build(clientOptions)])
}
