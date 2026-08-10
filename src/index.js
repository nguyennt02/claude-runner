// ─────────────────────────────────────────────────────────────────────────────
// claude-local — gọi Claude qua Claude Code CLI đã `claude auth login` trên máy.
// Không cần ANTHROPIC_API_KEY; chi phí API biên = $0 (tính vào subscription).
//
// Package này KHÔNG biết gì về project đang dùng nó. Không đọc biến môi trường
// của ai ngoài `CLAUDE_LOCAL_*`, không import ngược ra ngoài thư mục này, không
// mang hình dạng dữ liệu của bất kỳ endpoint nào. Muốn nối vào một project thì
// viết một adapter mỏng ở phía project đó.
//
// ⚠️ GIỚI HẠN, đọc trước khi thiết kế quanh nó:
// · CHỈ CHẠY LOCAL. Nó spawn binary `claude` và đọc credential của **máy đang
//   chạy**. Serverless (Vercel/Lambda) không có Keychain của ai cả — deploy lên
//   đó thì hoặc không có credential, hoặc phải nhét CLAUDE_CODE_OAUTH_TOKEN của
//   MỘT người rồi cả đội tiêu chung quota người đó.
// · Không có `maxTokens`. Agent SDK không nhận trần output token; CLI tự quyết.
//   Caller truyền vào cũng bị bỏ qua — cố ý, thà không nhận còn hơn nhận rồi lờ đi.
// · `cost` trả về là **ước tính giá API tương đương**, không phải tiền thật bị
//   trừ. Chạy bằng subscription thì con số đó là "lượt này đáng giá bao nhiêu
//   nếu mua bằng API", hữu ích để so sánh, vô nghĩa để đối soát hoá đơn.
// · `web_search` ở đây KHÔNG có `user_location`. Tra theo quốc gia là thứ chỉ
//   đường API mới làm được.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from './client.js'

export { createClient } from './client.js'
export { isReady, resolveCli, status } from './status.js'
export { safeOptions, denyExcept, WEB_TOOLS } from './safety.js'

// Đã từng có `startLogin` / `submitLoginCode` / `logout` ở đây, điều khiển
// `claude auth …` từ code. Đã BỎ: đăng nhập/đăng xuất là hành động về danh tính
// của MÁY, và nó đã có sẵn một giao diện đúng chỗ là terminal (`claude auth
// login`, hoặc `claude-local login` của package này). Gói nó vào một API để nơi
// khác gọi qua HTTP chỉ tạo ra một đường cho request từ xa xoá credential của
// máy — mà thứ người ta thật sự muốn bật/tắt là *kết nối của một app cụ thể*,
// không phải đăng nhập của cả máy.

// Client mặc định, dựng lazy. Ba hàm dưới là đường dùng thường; ai cần tiêm
// `query` (test) hay ghim một model/binary khác thì gọi `createClient` trực tiếp.
let _default
const def = () => (_default ??= createClient())

/** @returns {Promise<{text,json,cost,turns,searches,usage,subtype}>} */
export const complete = (args) => def().complete(args)

/** @returns {Promise<{data,cost,turns,searches,usage}>} */
export const completeJson = (args) => def().completeJson(args)

/** Gọi onDelta theo từng mẩu text; resolve với toàn bộ text. @returns {Promise<string>} */
export const streamText = (args) => def().streamText(args)

/** Model mặc định khi caller không chỉ định. */
export const defaultModel = () => process.env.CLAUDE_LOCAL_MODEL || 'claude-sonnet-5'
