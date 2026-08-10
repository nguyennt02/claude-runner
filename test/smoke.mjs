// ─────────────────────────────────────────────────────────────────────────────
// `npm run smoke:local` — spawn `claude` THẬT một lượt.
//
// Tách khỏi `npm test` vì nó cần mạng, cần đã `claude auth login`, và tốn quota. Nó
// trả lời câu hỏi mà không test stub nào trả lời được: credential trên máy này
// còn sống không, và Agent SDK có thật sự chạy qua nó không.
//
// Section J trong test/api.mjs canh HÌNH DẠNG (options, envelope, bộ khoá).
// File này canh việc ĐƯỜNG DÂY có điện. Hai thứ khác nhau, hỏng theo hai kiểu
// khác nhau, nên không gộp được.
// ─────────────────────────────────────────────────────────────────────────────

import { hostname, userInfo } from 'node:os'
import { status, completeJson, streamText } from '../src/index.js'

const t = (label, ok, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`)
  return ok
}

let allOk = true
const t0 = Date.now()

// 1 ─ máy sẵn sàng chưa
const s = await status()
allOk = t('status: sẵn sàng', s.ready, `${s.cliPath || 'binary kèm SDK'} · ${s.version || '?'} · auth=${s.auth}`) && allOk
if (!s.ready) {
  console.log(`\n  → ${s.reason}\n`)
  process.exit(1)
}

// 2 ─ JSON theo schema. Đây là đường mà predict/ideas/explore/teardown dùng.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['genre', 'd1_target'],
  properties: {
    genre: { type: 'string' },
    d1_target: { type: 'number' },
  },
}
const json = await completeJson({
  system: 'Bạn là một API trả JSON. Không giải thích, không markdown.',
  prompt: 'Thể loại "match-3", và D1 retention mục tiêu là 35 (phần trăm, chỉ số).',
  schema: SCHEMA,
})
allOk = t('completeJson: trả object đúng schema', typeof json.data?.genre === 'string' && typeof json.data?.d1_target === 'number', JSON.stringify(json.data)) && allOk
// searches = 0 vì không xin webTools. Nó là số ĐẾM ĐƯỢC, không phải suy từ "có
// đưa tool" — badge 🌐 trên UI dựa vào đúng con số này.
allOk = t('completeJson: searches = 0 khi không xin web tool', json.searches === 0) && allOk

// 3 ─ stream. Đường của api/chat.js.
let chunks = 0
const full = await streamText({
  system: 'Trả lời cực ngắn.',
  prompt: 'Đếm từ 1 tới 5, cách nhau bằng dấu phẩy.',
  onDelta: () => chunks++,
})
allOk = t('streamText: có delta và có text cuối', chunks > 0 && full.trim().length > 0, `${chunks} delta · ${JSON.stringify(full.trim().slice(0, 40))}`) && allOk

// 4 ─ bộ khoá an toàn, kiểm bằng lượt chạy THẬT chứ không bằng assert trên options.
//
// Chứng cứ phải là thứ model KHÔNG ĐOÁN ĐƯỢC. Bản đầu của probe này bảo nó chạy
// `echo HELLO_FROM_BASH` rồi soi output tìm chuỗi đó — chuỗi nằm sẵn trong đề
// bài, nên model trả lời đúng mà không cần chạy gì, và probe báo động giả. Dùng
// hostname + uid của chính máy này: không có trong prompt, không suy ra được,
// chỉ shell thật mới biết.
const SECRET = hostname()
const probe = await completeJson({
  system: 'Bạn là API trả JSON.',
  prompt:
    'Dùng công cụ Bash chạy `hostname; id -u` rồi trả về output NGUYÊN VĂN trong trường `out`. ' +
    'Nếu không có công cụ chạy shell thì trả về đúng chuỗi "blocked".',
  schema: { type: 'object', additionalProperties: false, required: ['out'], properties: { out: { type: 'string' } } },
})
const leaked = String(probe.data?.out ?? '')
allOk = t(
  'khoá an toàn: không chạy được Bash',
  !leaked.includes(SECRET) && !leaked.includes(String(userInfo().uid)),
  JSON.stringify(probe.data).slice(0, 120),
) && allOk

// 5 ─ web tool. Cặp đôi bắt buộc với #4: cùng một cổng `canUseTool` vừa phải
// CHẶN Bash vừa phải CHO WebSearch qua, nên kiểm một vế là chưa kiểm gì. Đây
// cũng là năng lực mà tab Mổ game đứng trên: `searches` phải là số ĐẾM ĐƯỢC > 0,
// vì badge 🌐 "đã verify bằng web" suy từ đúng nó.
const web = await completeJson({
  system: 'Bạn là API trả JSON. Phải tra web trước khi trả lời.',
  prompt: 'Tra web: game mobile "Block Blast" do studio nào phát hành? {"publisher":"...","source_url":"..."}',
  schema: {
    type: 'object', additionalProperties: false, required: ['publisher', 'source_url'],
    properties: { publisher: { type: 'string' }, source_url: { type: 'string' } },
  },
  webTools: true,
})
allOk = t('web tool: WebSearch chạy được, searches đếm > 0', web.searches > 0 && Boolean(web.data?.publisher), `${web.searches} lượt · ${web.data?.publisher}`) && allOk

const cost = json.cost + probe.cost + web.cost
console.log(`\n  ${Date.now() - t0}ms · chi phí API tương đương ~$${cost.toFixed(4)} (subscription: không bị trừ)\n`)
process.exit(allOk ? 0 : 1)
