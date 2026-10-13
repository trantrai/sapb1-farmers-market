// scripts/start.js — khởi động production, chạy được cả Windows lẫn Linux.
//  1. prisma generate + prisma db push (tự chữa lệch schema/client)
//  2. chạy server standalone bằng node, NODE_ENV=production,
//     đồng thời ghi log ra server.log (thay cho `tee` vốn không có trên Windows).
const { spawnSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const logPath = path.join(root, 'server.log')

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    console.error(`\n[Start] Lệnh thất bại: ${cmd} ${args.join(' ')} (mã ${r.status})`)
    console.error('[Start] Gợi ý trên Windows: nếu báo EPERM ở query_engine-windows.dll.node,')
    console.error('[Start] hãy tắt hết tiến trình node cũ:  taskkill /F /IM node.exe')
    process.exit(r.status ?? 1)
  }
}

run('npx', ['prisma', 'generate'])
run('npx', ['prisma', 'db', 'push', '--skip-generate'])

const log = fs.createWriteStream(logPath, { flags: 'a' })
log.write(`\n===== Khởi động lúc ${new Date().toISOString()} =====\n`)
console.log(`[Start] Đang chạy server, log ghi vào ${logPath}`)

const srv = spawn('node', ['.next/standalone/server.js'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
srv.stdout.on('data', (d) => { process.stdout.write(d); log.write(d) })
srv.stderr.on('data', (d) => { process.stderr.write(d); log.write(d) })
srv.on('exit', (code) => { log.end(); process.exit(code ?? 0) })
