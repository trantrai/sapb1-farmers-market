// scripts/start.js — khởi động production, chạy được cả Windows lẫn Linux.
//  1. prisma generate + prisma db push (tự chữa lệch schema/client)
//  2. chạy server standalone bằng node, NODE_ENV=production,
//     đồng thời ghi log ra server.log (thay cho `tee` vốn không có trên Windows).
const { spawnSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const logPath = path.join(root, 'server.log')

// FIX 2026-10-16: Prisma Client (chạy trong .next/standalone) resolve đường dẫn
// `file:` tương đối theo thư mục schema bị trace vào standalone
// (.next/standalone/node_modules/.prisma/client/) chứ KHÔNG theo thư mục prisma/
// như CLI/dev → mở nhầm DB, login lỗi "Yêu cầu không hợp lệ".
// Chốt về absolute path ngay tại đây để generate/push/server dùng chung 1 DB.
// Tương thích Windows (đổi \ thành /); tôn trọng DATABASE_URL tuyệt đối có sẵn;
// đọc .env của repo khi biến môi trường chưa được đặt (start.js không tự load .env).
{
  let raw = process.env.DATABASE_URL
  if (!raw) {
    try {
      const envText = fs.readFileSync(path.join(root, '.env'), 'utf8')
      const m = envText.match(/^DATABASE_URL\s*=\s*["']?([^"'\r\n]+)["']?\s*$/m)
      if (m) raw = m[1].trim()
    } catch { /* không có .env → dùng mặc định bên dưới */ }
  }
  raw = raw || 'file:../db/custom.db'
  const rel = raw.replace(/^file:/i, '')
  // Đường dẫn tương đối trong .env được tính từ thư mục prisma/ (quy ước repo)
  const abs = path.isAbsolute(rel) ? rel : path.resolve(root, 'prisma', rel)
  process.env.DATABASE_URL = 'file:' + abs.replace(/\\/g, '/')
}

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
