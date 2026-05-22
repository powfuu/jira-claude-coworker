import { cpSync, mkdirSync, renameSync, rmSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dist = resolve(__dirname, '../dist')

// Move dist/src/popup/index.html → dist/popup/index.html
mkdirSync(`${dist}/popup`, { recursive: true })
cpSync(`${dist}/src/popup/index.html`, `${dist}/popup/index.html`)
rmSync(`${dist}/src`, { recursive: true, force: true })

// Rename index.css → popup.css for clarity
try {
  renameSync(`${dist}/index.css`, `${dist}/popup.css`)
} catch {
  // already named popup.css from a previous run
}

// Fix asset paths in popup/index.html
import { readFileSync, writeFileSync } from 'fs'
let html = readFileSync(`${dist}/popup/index.html`, 'utf8')
// Paths use /popup.js and /index.css (absolute from dist root — correct for extension)
html = html.replace('/index.css', '/popup.css')
writeFileSync(`${dist}/popup/index.html`, html)

console.log('Post-build done: popup/index.html ready')
