#!/usr/bin/env node
import { createRunner, createPairingUrl, createToken, parseOrigins } from '../src/http.js'
import * as lib from '../src/index.js'

// Adapter CLI. Không đọc `.env` của ai: runner này không thuộc project nào, và
// mọi thứ nó cần đều truyền qua biến môi trường lúc chạy.
const PORT = Number(process.env.RUNNER_PORT || process.env.BRIDGE_PORT) || 8787
const TOKEN = process.env.RUNNER_TOKEN || process.env.BRIDGE_TOKEN || createToken()

// Origin nhận được theo THAM SỐ trước, env sau. Lý do là chuyện gõ phím: người
// dùng cuối phải tự nhập origin của app họ, và `npx <pkg> https://app.example`
// gõ đúng dễ hơn hẳn một tiền tố `RUNNER_ORIGINS=… ` đứng trước lệnh — mà gõ sai
// origin thì mọi request bị chặn ở CORS, hiện ra là "không gọi được bộ chạy"
// chứ không phải "origin sai".
let ORIGINS
try {
  ORIGINS = parseOrigins(process.argv.slice(2).join(',') || process.env.RUNNER_ORIGINS || process.env.BRIDGE_ORIGINS, [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ])
} catch (e) {
  console.error(`\n  ${e.message}\n  Ví dụ: npx github:<owner>/claude-runner https://app.example.com\n`)
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
  // `EADDRINUSE` gần như luôn là MỘT BỘ CHẠY CŨ còn sống, và ca đó độc ở chỗ nó
  // hỏng theo hai nửa rời nhau: lệnh mới chết ở đây, còn cái đang giữ cổng thì
  // vẫn trả lời — chỉ là cho một origin khác. Người dùng thấy app báo "không gọi
  // được bộ chạy" và thấy lệnh vừa gõ đã tắt, mà không có gì nối hai chuyện đó.
  //
  // Nguyên văn `error.message` của Node không nói được nửa nào trong đó, nên nó
  // là một dòng đúng mà vô dụng. Việc phải làm mới là thứ cần in ra.
  if (error?.code === 'EADDRINUSE') {
    console.error(`
  Cổng ${PORT} đang có người giữ — nhiều khả năng là một bộ chạy cũ vẫn còn sống.

      lsof -nP -iTCP:${PORT} -sTCP:LISTEN    # xem ai đang giữ
      kill <PID>                             # tắt nó rồi chạy lại lệnh này

  ⚠️  Bộ chạy cũ đó có thể đang phục vụ một ORIGIN KHÁC. Khi ấy app vẫn báo
      "không gọi được bộ chạy" dù cổng có trả lời — vì nó bị từ chối ở CORS,
      và trình duyệt không đọc được lý do. Kiểm nhanh:

      curl -s -o /dev/null -w '%{http_code}\\n' -H 'Origin: <origin của app>' \\
        http://127.0.0.1:${PORT}/ping        # 200 = đúng · 403 = sai origin

  Hoặc chạy cổng khác: RUNNER_PORT=${PORT + 1}
`)
  } else {
    console.error(`\n  Runner không khởi động được: ${error.message}\n`)
  }
  process.exitCode = 1
})

// Bind 127.0.0.1, KHÔNG phải 0.0.0.0: mở ra LAN là biến subscription cá nhân
// thành API mở cho cả quán cà phê.
server.listen(PORT, '127.0.0.1', () => {
  const pair = createPairingUrl({ origins: ORIGINS, port: PORT, token: TOKEN })
  const label = account.ready ? account.account || account.auth : 'chưa đăng nhập'
  // In token RIÊNG, không chỉ nhúng trong link. App có ô dán tay cho ca không
  // bấm được link (terminal ở máy khác qua SSH, link mở nhầm trình duyệt), mà
  // token lại chỉ nằm lẫn sau `t=` trong URL — không ai đoán ra phải tự bóc nó
  // ra, nên trên thực tế ô đó không có cách nào điền cho đúng.
  console.log(`
  Claude runner: 127.0.0.1:${PORT} — ${label}

  Cách 1 — mở link này, app tự nối:

      ${pair}

  Cách 2 — dán tay vào nút "Claude local" của app:

      Địa chỉ : http://127.0.0.1:${PORT}
      Token   : ${TOKEN}

  Giữ cửa sổ terminal này mở trong lúc làm việc.
  origins   ${[...ORIGINS].join(', ')}
`)
  console.log('RUNNER READY')
})
