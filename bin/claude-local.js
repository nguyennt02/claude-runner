#!/usr/bin/env node
// `claude-local status` — máy này gọi Claude được chưa, và nếu chưa thì thiếu gì.
// `claude-local login` / `logout` — chuyển tiếp sang `claude auth …` của binary
//   mà package thật sự dùng.
//
// Vì sao cần hai lệnh chuyển tiếp thay vì bảo người ta gõ `claude auth login`:
// `npm install` đã kéo về một Claude Code đầy đủ trong node_modules, nên một máy
// có thể chạy được package này mà KHÔNG có `claude` trong PATH. Bắt họ tự tìm
// `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` là bắt họ
// đoán đúng cả nền tảng lẫn kiến trúc.
import { spawn } from 'node:child_process'
import { status, resolveCli } from '../src/index.js'

const cmd = process.argv[2] || 'status'

if (cmd === 'login' || cmd === 'logout') {
  const cli = resolveCli()
  if (!cli) {
    console.error('claude-local: không tìm thấy binary `claude` (kể cả bản kèm SDK). Chạy `npm install` trước.')
    process.exit(1)
  }
  // stdio kế thừa: `claude auth login` là luồng tương tác — nó mở trình duyệt và
  // đợi dán mã. Pipe stdio ở đây là treo vĩnh viễn.
  const child = spawn(cli, ['auth', cmd], { stdio: 'inherit' })
  child.on('exit', (code) => process.exit(code ?? 1))
} else if (cmd === 'status') {
  const s = await status()
  const line = (k, v) => console.log(`  ${k.padEnd(9)} ${v ?? '—'}`)

  console.log(s.ready ? '\n  ✅ sẵn sàng\n' : '\n  ❌ chưa sẵn sàng\n')
  line('cli', s.cliPath || '(không tìm thấy)')
  line('version', s.version)
  line('auth', s.auth + (s.plan ? ` · ${s.plan}` : ''))
  // Tài khoản in ra vì đây là câu hỏi thật của tính năng này: quota của AI đang
  // bị tiêu vào đâu? Máy có thể có nhiều tài khoản, và `auth: subscription`
  // không nói được điều đó.
  line('account', s.account)
  line('model', s.model || '(mặc định)')

  // Chỉ cảnh báo khi lượt gọi THẬT SỰ tính tiền: chưa login và đang chạy bằng
  // ANTHROPIC_API_KEY. Key nằm trong env mà đã login thì CLI vẫn dùng
  // subscription — cảnh báo ở đó là doạ suông, mà doạ suông thì lần sau không ai đọc.
  if (s.auth === 'api-key') {
    console.log('\n  ⚠️  Chưa đăng nhập — đang chạy bằng ANTHROPIC_API_KEY, nên mỗi lượt bấm')
    console.log('     TÍNH TIỀN THẬT. Chạy `claude-local login` để dùng subscription.')
  }
  if (s.reason) console.log(`\n  → ${s.reason}`)
  console.log('')

  process.exit(s.ready ? 0 : 1)
} else {
  console.error(`claude-local: lệnh không biết "${cmd}". Có: status · login · logout`)
  process.exit(2)
}
