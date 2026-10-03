/** 用 esbuild 即时打包并运行 scripts/verify-*.ts，验证端批次核心规则 */
const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('esbuild')

const entry = process.argv[2]
if (!entry) {
  console.error('用法: node scripts/run-verify.cjs <verify-batch|verify-store>')
  process.exit(1)
}

const result = esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, `${entry}.ts`)],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  alias: { '@': path.resolve(__dirname, '..', 'src') },
})

const out = path.resolve(__dirname, `.${entry}.mjs`)
fs.writeFileSync(out, result.outputFiles[0].text)
import(`file://${out}`)
