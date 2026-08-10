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

// 6 ─ Qua HTTP, với lib THẬT. Đây là tổ hợp duy nhất `npm test` không chạm tới:
// ở đó `createRunner` nhận một lib giả, còn bốn phép thử trên gọi thẳng lib.
// Nghĩa là lớp HTTP và engine chưa bao giờ gặp nhau trong một phép kiểm — và đó
// đúng là chỗ tốn nhiều thời gian nhất khi phải chẩn đoán một lượt chat hỏng.
const { createRunner } = await import('../src/http.js')
const lib = await import('../src/index.js')
const http = await import('node:http')

const ORIGIN = 'http://localhost:5173'
const TOKEN = 'smoke-token'
const server = createRunner({ origins: ORIGIN, token: TOKEN, lib, logger: { error() {} } })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

const post = (path, payload) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Origin: ORIGIN, 'x-runner-token': TOKEN } },
      (res) => {
        let text = ''
        res.on('data', (d) => (text += d))
        res.on('end', () => resolve({ status: res.statusCode, text }))
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })

const httpJson = await post('/run', {
  system: 'Bạn là API trả JSON.',
  prompt: 'Thủ đô Việt Nam? {"city":"..."}',
  schema: { type: 'object', additionalProperties: false, required: ['city'], properties: { city: { type: 'string' } } },
})
let hj = null
try { hj = JSON.parse(httpJson.text) } catch { /* để nguyên null, phép thử dưới sẽ đỏ */ }
allOk = t('HTTP /run: lib thật trả JSON đúng schema', httpJson.status === 200 && Boolean(hj?.data?.city), `${httpJson.status} · ${hj?.data?.city ?? httpJson.text.slice(0, 80)}`) && allOk

// `/stream` phải trả TEXT THÔ, không phải JSON — client đọc nó bằng getReader().
// Một lượt trả JSON ở đây sẽ hiện lên khung chat dưới dạng `{"ok":true,...}`.
const httpStream = await post('/stream', { system: 'Trả lời cực ngắn.', prompt: 'Chào bằng tiếng Việt' })
allOk = t('HTTP /stream: lib thật trả text thô, không phải JSON',
  httpStream.status === 200 && httpStream.text.trim().length > 0 && !httpStream.text.trimStart().startsWith('{'),
  JSON.stringify(httpStream.text.slice(0, 60))) && allOk

server.close()

const cost = json.cost + probe.cost + web.cost
console.log(`\n  ${Date.now() - t0}ms · chi phí API tương đương ~$${cost.toFixed(4)} (subscription: không bị trừ)\n`)
process.exit(allOk ? 0 : 1)
