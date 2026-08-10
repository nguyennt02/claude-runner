// ─────────────────────────────────────────────────────────────────────────────
// Kiểm cho claude-runner. Không mạng, không cần đăng nhập, không gọi model.
//
// Hai nhóm:
//   A — bộ khoá an toàn + client (chuyển từ Section J của project cũ). Seam là
//       `createClient({ query })`: package nhận `query` tiêm vào nên dựng được
//       cả những nhánh mà một lượt gọi thật không tạo ra được.
//   B — lớp HTTP. Seam là `createRunner({ lib })`. Thứ đáng test không phải
//       "chuyển tiếp đúng không" mà **ai gọi được vào** — sai ở đây nghĩa là
//       subscription cá nhân của một người thành API mở.
//
// `npm run smoke` mới là thứ kiểm ĐƯỜNG DÂY có điện (spawn `claude` thật).
// File này kiểm HÌNH DẠNG. Hai thứ hỏng theo hai kiểu khác nhau nên không gộp.
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http'
import * as CL from '../src/index.js'
import { createRunner, parseOrigins, createPairingUrl } from '../src/http.js'

const results = []
const check = (name, ok) => results.push([name, Boolean(ok)])

// ── A1. Bộ khoá an toàn — nhóm quan trọng nhất ─────────────────────────────
//
// `query()` spawn Claude Code THẬT, và prompt tới từ một web form là input
// không tin được. Một lượt dogfood đã cho thấy denylist là không đủ: model vẫn
// nhìn thấy tool `Monitor` (chạy shell) vì nó không có trong danh sách. Nên lớp
// chính bây giờ là ALLOWLIST (`tools`), và dưới đây canh cả ba lớp.
const optOff = CL.safeOptions({})
const optWeb = CL.safeOptions({ webTools: true })

check('khoá: tools rỗng khi không xin gì (allowlist, không phải denylist)',
  Array.isArray(optOff.tools) && optOff.tools.length === 0)
check('khoá: settingSources rỗng → không nạp CLAUDE.md/settings/plugin của máy',
  Array.isArray(optOff.settingSources) && optOff.settingSources.length === 0)
check('khoá: không nạp MCP server nào',
  optOff.mcpServers && Object.keys(optOff.mcpServers).length === 0)
// `Monitor` nằm trong danh sách vì đúng nó là cái đã lọt lần đầu — giữ tên nó ở
// đây để lần sau ai rút gọn danh sách thì test đỏ chứ không im lặng.
check('khoá: denylist nêu đích danh Bash/Write/Edit/Read/Monitor',
  ['Bash', 'Write', 'Edit', 'Read', 'Monitor', 'Task'].every((t) => optOff.disallowedTools.includes(t)))
check('khoá: KHÔNG dùng bypassPermissions',
  optOff.permissionMode !== 'bypassPermissions' && optOff.allowDangerouslySkipPermissions === undefined)
// `allowedTools` của SDK nghĩa là "auto-duyệt, khỏi hỏi canUseTool". Một cái tên
// trần trong đó vô hiệu hoá lớp 3 cho đúng tool duy nhất thật sự chạy.
check('khoá: allowedTools LUÔN rỗng, kể cả khi xin web tool',
  optOff.allowedTools.length === 0 && optWeb.allowedTools.length === 0)
check('khoá: cwd là thư mục tmp riêng, không phải thư mục đang đứng',
  typeof optOff.cwd === 'string' && optOff.cwd.includes('claude-local-') && optOff.cwd !== process.cwd())
check('khoá: xin web tool thì tools đúng WebSearch+WebFetch, không hơn',
  optWeb.tools.length === 2 && optWeb.tools.includes('WebSearch') && optWeb.tools.includes('WebFetch'))
// permissionMode phải để canUseTool được hỏi. 'dontAsk' + allowedTools rỗng =
// chặn luôn WebSearch trước khi lớp 3 kịp duyệt → mất search mà không có lỗi nào.
check('khoá: permissionMode để canUseTool được hỏi (không phải dontAsk)',
  optWeb.permissionMode === 'default')

// Lớp 3, kiểm bằng cách gọi thật cái callback.
check('khoá: canUseTool CHẶN Bash', (await optOff.canUseTool('Bash', {})).behavior === 'deny')
check('khoá: canUseTool CHẶN cả tool chưa tồn tại lúc viết test này',
  (await optWeb.canUseTool('SomeFutureTool2030', {})).behavior === 'deny')
check('khoá: canUseTool CHO WebSearch qua khi caller đã xin',
  (await optWeb.canUseTool('WebSearch', {})).behavior === 'allow')
check('khoá: canUseTool CHẶN WebSearch khi caller KHÔNG xin',
  (await optOff.canUseTool('WebSearch', {})).behavior === 'deny')

// ── A2. client — `query` tiêm vào, assert trên đúng thứ đã gửi đi ──────────
const fakeQ = (script) => {
  const calls = []
  const q = ({ prompt, options }) => {
    calls.push({ prompt, options })
    return (async function* () {
      for (const m of script) yield m
    })()
  }
  return { q, calls }
}
const RESULT = (extra) => ({ type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 1, ...extra })

let f = fakeQ([RESULT({ structured_output: { ok: 1 }, result: '{"ok":2}' })])
let cl = CL.createClient({ query: f.q, cli: null })
check('json: đọc structured_output (CLI đã ép schema), không parse lại text',
  (await cl.completeJson({ prompt: 'x', schema: { type: 'object' } })).data.ok === 1)
check('json: schema đi vào outputFormat json_schema',
  f.calls[0].options.outputFormat?.type === 'json_schema')

// `searches` phải ĐẾM lượt tool thật, không suy từ "có đưa tool" — badge trên UI
// đọc đúng con số này, và một badge "đã verify bằng web" cho lượt không search
// lần nào thì tệ hơn không có badge.
f = fakeQ([
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch' }, { type: 'tool_use', name: 'WebFetch' }, { type: 'tool_use', name: 'Bash' }] } },
  RESULT({ structured_output: {} }),
])
cl = CL.createClient({ query: f.q, cli: null })
check('json: searches đếm WebSearch+WebFetch, không đếm tool khác',
  (await cl.completeJson({ prompt: 'x', schema: {} })).searches === 2)

// Ảnh đứng TRƯỚC text — hỏi xong mới cho nhìn thì model đã trả lời rồi.
f = fakeQ([RESULT({ structured_output: {} })])
cl = CL.createClient({ query: f.q, cli: null })
await cl.completeJson({ prompt: 'hỏi gì đó', images: [{ media_type: 'image/png', data: 'AAA' }], schema: {} })
let sent = null
for await (const m of f.calls[0].prompt) sent = m
check('ảnh: ảnh đứng trước text trong content',
  sent?.message?.content?.[0]?.type === 'image' && sent.message.content[1]?.type === 'text')
// Canh cho đường thường không bị đổi nghĩa: không ảnh → prompt vẫn là CHUỖI.
f = fakeQ([RESULT({ structured_output: {} })])
cl = CL.createClient({ query: f.q, cli: null })
await cl.completeJson({ prompt: 'chỉ có chữ', schema: {} })
check('ảnh: không ảnh → prompt vẫn là chuỗi', typeof f.calls[0].prompt === 'string')

// ── B. Lớp HTTP ────────────────────────────────────────────────────────────
const ORIGIN = 'https://app.example'
const TOKEN = 'test-token'
let seen = null
const stubLib = {
  status: async () => ({ ready: true, account: 'ai@do.com', plan: 'max', auth: 'subscription', model: null, reason: null }),
  completeJson: async (args) => {
    seen = args
    return { data: { ok: true }, searches: 3, cost: 0.02 }
  },
  streamText: async (args) => {
    seen = args
    args.onDelta('xin ')
    args.onDelta('chào')
    return 'xin chào'
  },
}

const server = createRunner({ origins: ORIGIN, token: TOKEN, lib: stubLib, logger: { error() {} } })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

const hit = (path, { origin = ORIGIN, token, method = 'POST', body } = {}) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: {
          ...(origin ? { Origin: origin } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { 'x-runner-token': token } : {}),
        },
      },
      (res) => {
        let text = ''
        res.on('data', (d) => (text += d))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })

// Origin lạ bị chặn TRƯỚC mọi thứ, kể cả /ping.
let r = await hit('/ping', { origin: 'https://evil.example', method: 'GET' })
check('http: origin lạ → 403, không lộ cả sự tồn tại', r.status === 403)
r = await hit('/status', { origin: 'https://evil.example', token: TOKEN })
check('http: origin lạ + token đúng vẫn 403 (CORS đứng trước token)', r.status === 403)

r = await hit('/ping', { method: 'GET' })
check('http: /ping mở cho origin hợp lệ, không cần token', r.status === 200 && JSON.parse(r.text).ok === true)
// /ping cố ý không nói gì về tài khoản — email và gói cước nằm sau token.
check('http: /ping KHÔNG lộ email hay gói cước', !/ai@do\.com|max/.test(r.text))

r = await hit('/status')
check('http: /status thiếu token → 401', r.status === 401)
r = await hit('/status', { token: 'sai' })
check('http: /status token sai → 401', r.status === 401)
r = await hit('/status', { token: TOKEN })
check('http: /status có token → trả ready + account', r.status === 200 && JSON.parse(r.text).account === 'ai@do.com')

r = await hit('/run', { token: TOKEN, body: { system: 's', prompt: 'p' } })
check('http: /run thiếu schema → 400', r.status === 400)

r = await hit('/run', {
  token: TOKEN,
  body: {
    system: 's',
    prompt: 'p',
    schema: { type: 'object' },
    webTools: true,
    maxTurns: 12,
    images: [{ media_type: 'image/png', data: 'AAA' }],
    // Những khoá dưới đây PHẢI bị bỏ: chúng là option của Agent SDK, nhận vào
    // là người gọi tự đặt được và bộ khoá trong safety.js hết tác dụng.
    tools: [{ type: 'web_search_20260209', name: 'web_search' }],
    permissionMode: 'bypassPermissions',
    disallowedTools: [],
    cwd: '/',
  },
})
const runBody = JSON.parse(r.text)
check('http: /run trả envelope { data, searches, cost }',
  r.status === 200 && runBody.data.ok === true && runBody.searches === 3)
check('http: /run chuyển tiếp webTools/maxTurns/images', seen.webTools === true && seen.maxTurns === 12 && seen.images.length === 1)
// Ranh giới package: runner nhận `webTools`, KHÔNG nhận `tools` hình dạng
// Anthropic. Nhận vào đây là bắt đầu biết về một nhà cung cấp cụ thể.
check('http: /run BỎ tools hình dạng Anthropic (giữ ranh giới package)', seen.tools === undefined)
check('http: /run BỎ mọi option của Agent SDK do người gọi tự đặt',
  seen.permissionMode === undefined && seen.disallowedTools === undefined && seen.cwd === undefined)

r = await hit('/stream', { token: TOKEN, body: { system: 's', prompt: 'p', schema: { type: 'object' } } })
check('http: /stream trả text thô, không phải JSON', r.status === 200 && r.text === 'xin chào')
// Ép schema trên một luồng text thô là vô nghĩa — runner phải cắt nó đi, không
// truyền cho có. Gửi kèm schema ở request trên chính là để canh chỗ này.
check('http: /stream BỎ schema trước khi gọi engine', seen.schema === undefined)

r = await hit('/khong-ton-tai', { token: TOKEN })
check('http: route lạ → 404', r.status === 404)

server.close()

// ── B2. parseOrigins — không có `*`, không có mặc định mở ───────────────────
let threw = false
try {
  parseOrigins('*')
} catch {
  threw = true
}
check('origins: `*` bị từ chối (không có runner mở cho mọi origin)', threw)
threw = false
try {
  parseOrigins('')
} catch {
  threw = true
}
check('origins: rỗng thì DỪNG, không im lặng mở cho tất cả', threw)
check('origins: link ghép đôi ưu tiên https',
  createPairingUrl({ origins: 'http://localhost:5173,https://app.example', port: 1, token: 'a' }).startsWith('https://app.example/'))

// ── B3. Ranh giới: package không được biết project nào ─────────────────────
{
  const fsp = await import('node:fs/promises')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  let src = ''
  for (const f2 of ['index.js', 'client.js', 'safety.js', 'status.js', 'http.js']) {
    src += strip(await fsp.readFile(new URL(`../src/${f2}`, import.meta.url), 'utf8'))
  }
  check('ranh giới: không import ngược ra ngoài thư mục package',
    !/from\s+['"]\.\.\/\.\.\//.test(src))
  check('ranh giới: không đọc biến môi trường của project nào (chỉ CLAUDE_LOCAL_*/RUNNER_*)',
    !/GD_RUNTIME|TEARDOWN_|GD_ACCESS|ANTHROPIC_MODEL/.test(src))
  check('ranh giới: không mang hình dạng dữ liệu của endpoint nào',
    !/sub_genre|scope_line|generateJsonWithTools/.test(src))
}

// ── Kết quả ────────────────────────────────────────────────────────────────
let pass = 0
for (const [name, ok] of results) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}`)
  if (ok) pass++
}
console.log(`\n  ${pass}/${results.length}\n`)
process.exit(pass === results.length ? 0 : 1)
