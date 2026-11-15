#!/usr/bin/env node
/**
 * 逐文件跑全部测试。
 *
 * 为什么不直接用 `node --test test/`：在受限沙箱里该命令会因 spawn EPERM 直接失败，
 * 而逐文件 spawn 用 stdio: 'inherit' 不会经过管道，能稳定跑完。
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, 'test')
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()

if (files.length === 0) {
  console.error('no test files found under test/')
  process.exit(1)
}

const failed = []
for (const file of files) {
  process.stdout.write(`\n▶ ${file}\n`)
  const result = spawnSync(process.execPath, [join(testDir, file)], { stdio: 'inherit' })
  if (result.status !== 0) failed.push(file)
}

if (failed.length > 0) {
  console.error(`\n✖ ${failed.length}/${files.length} 个测试文件失败：${failed.join(', ')}`)
  process.exit(1)
}

console.log(`\n✔ ${files.length} 个测试文件全部通过`)