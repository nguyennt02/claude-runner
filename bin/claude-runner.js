#!/usr/bin/env node
import { createRunner, createPairingUrl, createToken, parseOrigins } from '../src/http.js'
import * as lib from '../src/index.js'

// Adapter CLI. Không đọc `.env` của ai: runner này không thuộc project nào, và
// mọi thứ nó cần đều truyền qua biến môi trường lúc chạy.
const PORT = Number(process.env.RUNNER_PORT || process.env.BRIDGE_PORT) || 8787
const TOKEN = process.env.RUNNER_TOKEN || process.env.BRIDGE_TOKEN || createToken()

let ORIGINS
try {
  ORIGINS = parseOrigins(process.env.RUNNER_ORIGINS || process.env.BRIDGE_ORIGINS, [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ])
} catch (e) {
  console.error(`\n  ${e.message}\n  Ví dụ: RUNNER_ORIGINS=https://app.example.com npx claude-runner\n`)
  process.exit(1)
}

const account = await lib.status()
if (!account.ready) {
  // Không tự chạy `claude auth login`: đó là hành động về danh tính của MÁY, và
  // nó đã có sẵn một giao diện đúng chỗ là terminal. Server vẫn mở để người dùng
  // thấy lý do thay vì gặp một cổng im lặng.
  console.warn(`\n  ⚠️  Máy này chưa sẵn sàng: ${account.reason || 'chưa đăng nhập Claude'}`)
  console.warn('     Chạy `claude auth login` rồi khởi động lại.\n')
}

const server = createRunner({ origins: ORIGINS, token: TOKEN, lib })

server.once('error', (error) => {
  console.error(`\n  Runner không khởi động được: ${error.message}\n`)
  process.exitCode = 1
})

// Bind 127.0.0.1, KHÔNG phải 0.0.0.0: mở ra LAN là biến subscription cá nhân
// thành API mở cho cả quán cà phê.
server.listen(PORT, '127.0.0.1', () => {
  const pair = createPairingUrl({ origins: ORIGINS, port: PORT, token: TOKEN })
  const label = account.ready ? account.account || account.auth : 'chưa đăng nhập'
  console.log(`
  Claude runner: 127.0.0.1:${PORT} — ${label}

  Mở link này để app dùng Claude trên máy bạn:

      ${pair}

  Giữ cửa sổ terminal này mở trong lúc làm việc.
  origins   ${[...ORIGINS].join(', ')}
`)
  console.log('RUNNER READY')
})
