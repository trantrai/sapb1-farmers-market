// scripts/dev.js — chạy môi trường dev, dùng được cả Windows lẫn Linux.
//  1. prisma generate + prisma db push --skip-generate (tự chữa lệch schema/client)
//  2. chạy `next dev -p 3000`, log vừa hiện console vừa ghi vào dev.log
//     (thay cho `| tee dev.log` vốn không có trên Windows/cmd/PowerShell).
const { spawnSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const logPath = path.join(root, 'dev.log')

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    console.error(`\n[Dev] Lệnh thất bại: ${cmd} ${args.join(' ')} (mã ${r.status})`)
    console.error('[Dev] Gợi ý trên Windows: nếu báo EPERM ở query_engine-windows.dll.node,')
    console.error('[Dev] hãy tắt hết tiến trình node cũ:  taskkill /F /IM node.exe')
    process.exit(r.status ?? 1)
  }
}

run('npx', ['prisma', 'generate'])
run('npx', ['prisma', 'db', 'push', '--skip-generate'])

const log = fs.createWriteStream(logPath, { flags: 'a' })
log.write(`\n===== Dev khởi động lúc ${new Date().toISOString()} =====\n`)
console.log(`[Dev] Đang chạy next dev, log ghi vào ${logPath}`)

const dev = spawn(process.execPath, [
  path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'),
  'dev', '-p', '3000',
], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
})
dev.stdout.on('data', (d) => { process.stdout.write(d); log.write(d) })
dev.stderr.on('data', (d) => { process.stderr.write(d); log.write(d) })
dev.on('exit', (code) => { log.end(); process.exit(code ?? 0) })
