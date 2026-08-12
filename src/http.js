import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

// ─────────────────────────────────────────────────────────────────────────────
// Lớp HTTP mỏng quanh `claude-local`. Bốn route cố định, không mount thư mục
// handler nào — đó là toàn bộ khác biệt với bản tiền nhiệm, và là lý do package
// này KHÔNG chứa code của bất kỳ project nào.
//
// Nó nhận đúng API của claude-local: { system, prompt, schema?, images?,
// webTools?, maxTurns?, effort?, model? }. Nó KHÔNG nhận `tools` hình dạng
// Anthropic — phép dịch đó thuộc về project gọi nó. Nhận vào đây là bắt đầu
// biết về nhà cung cấp cụ thể, và package hết mang sang chỗ khác được.
//
// ⚠️ BỀ MẶT: server này chạy **prompt bất kỳ** bằng subscription Claude của chủ
// máy. Nó rộng hơn hẳn một endpoint cố định, nên hai cổng gác dưới đây không có
// chế độ tắt: CORS allowlist chặn trang khác ĐỌC kết quả, token chặn chúng GỌI.
// Thiếu vế thứ hai thì một request lọt qua vẫn tiêu quota dù kẻ gọi không đọc
// được gì.
// ─────────────────────────────────────────────────────────────────────────────

// Trần body. Tám ảnh 1092px base64 ≈ 1,5 MB, cộng prompt và biên — 12 MB là
// rộng rãi cho ca thật và vẫn chặn được một POST tự chế nhồi cho hết RAM.
const MAX_BODY = 12 * 1024 * 1024

function normalizeOrigin(value) {
  try {
    const url = new URL(String(value || '').trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.origin === 'null') return null
    return url.origin
  } catch {
    return null
  }
}

export function parseOrigins(value, fallback = []) {
  const raw = value === undefined || value === null ? fallback : value
  const items = raw instanceof Set ? [...raw] : Array.isArray(raw) ? raw : String(raw).split(',')
  const origins = new Set()
  for (const item of items) {
    const origin = normalizeOrigin(item)
    if (origin) origins.add(origin)
  }
  // Không có origin hợp lệ thì DỪNG, đừng mở cho tất cả. Một runner mở cho mọi
  // origin là một API Claude công khai chạy bằng subscription của người mở nó.
  if (!origins.size) throw new Error('Runner cần ít nhất một origin HTTP(S) tường minh.')
  return origins
}

export function createToken() {
  return randomBytes(18).toString('base64url')
}

export function createPairingUrl({ origins, port, token }) {
  const allowed = parseOrigins(origins)
  const app = [...allowed].find((o) => o.startsWith('https://')) || [...allowed][0]
  return `${app}/#bridge=${port}&t=${encodeURIComponent(token)}`
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body quá lớn'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(Object.assign(new Error('JSON không hợp lệ'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

// Chỉ những khoá dưới đây được chuyển tiếp xuống claude-local. Whitelist chứ
// không phải blacklist: một khoá lạ lọt qua là một option của Agent SDK mà
// người gọi tự đặt được, và bộ khoá trong safety.js vừa mất tác dụng.
function pickRunArgs(body) {
  const b = body || {}
  const out = {
    system: typeof b.system === 'string' ? b.system : '',
    prompt: typeof b.prompt === 'string' ? b.prompt : '',
  }
  if (b.schema && typeof b.schema === 'object') out.schema = b.schema
  if (Array.isArray(b.images)) {
    out.images = b.images
      .filter((im) => im && typeof im.media_type === 'string' && typeof im.data === 'string')
      .map((im) => ({ media_type: im.media_type, data: im.data }))
  }
  if (b.webTools === true) out.webTools = true
  if (Number.isFinite(b.maxTurns)) out.maxTurns = Math.min(60, Math.max(1, Math.floor(b.maxTurns)))
  if (typeof b.effort === 'string') out.effort = b.effort
  if (typeof b.model === 'string') out.model = b.model
  return out
}

/**
 * @param {object} o
 * @param {Set<string>|string[]|string} o.origins  allowlist, KHÔNG có `*`
 * @param {string} o.token                          bắt buộc, không có chế độ tắt
 * @param {object} o.lib                            module claude-local (tiêm được để test)
 */
export function createRunner({ origins, token, lib, logger = console }) {
  if (!token) throw new Error('Runner cần một token.')
  const allowedOrigins = parseOrigins(origins)

  function cors(req, res) {
    const origin = normalizeOrigin(req.headers.origin)
    if (!origin || !allowedOrigins.has(origin)) return false
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-runner-token')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Max-Age', '600')
    // Chrome <142 (Private Network Access bản cũ) đòi header này; bản Local
    // Network Access mới thay bằng prompt xin quyền. Vô hại, và không phải máy
    // nào cũng đã lên bản mới.
    if (req.headers['access-control-request-private-network']) {
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
    }
    return true
  }

  // Một origin bị từ chối là thứ TRÌNH DUYỆT KHÔNG BAO GIỜ ĐỌC ĐƯỢC: cái 403
  // dưới cố ý không kèm header CORS, nên phía app chỉ nhận đúng cái `TypeError`
  // của ca "không có gì lắng nghe". Terminal này là chỗ DUY NHẤT sự thật đó nói
  // ra được — và cũng chính là chỗ người dùng đang nhìn khi đi tìm nguyên nhân.
  //
  // Không nói ra thì hai nửa của cùng một sự việc nằm ở hai chỗ, mỗi chỗ thiếu
  // đúng mảnh của chỗ kia: app biết "gọi không được" mà không biết vì sao, còn
  // chỗ biết vì sao thì im lặng.
  //
  // ⚠️ Mỗi origin chỉ nói MỘT lần. Bất kỳ trang nào đang mở cũng dò được
  // 127.0.0.1, và một vòng retry sẽ biến cảnh báo này thành rác che mất mọi thứ
  // khác — tức là làm hỏng đúng thứ nó sinh ra để sửa.
  const warned = new Set()
  function warnRejected(raw) {
    // Không có header `Origin` thì đó không phải một trang web (curl, máy quét
    // cổng). Câu dưới nói về "app của bạn" nên nó sai địa chỉ ở ca đó.
    if (!raw) return
    const origin = normalizeOrigin(raw) || String(raw)
    if (warned.has(origin)) return
    warned.add(origin)
    logger.warn?.(`
  ⚠️  Từ chối một trang ở origin  ${origin}
      Bộ chạy này chỉ phục vụ:    ${[...allowedOrigins].join(', ')}

      Nếu đó là app của bạn: tắt bộ chạy (Ctrl-C) rồi chạy lại với chính origin đó.
      Phía app chỉ báo được "không gọi được bộ chạy" — nó KHÔNG đọc được dòng này.
`)
  }

  const json = (res, status, obj) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(obj))
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')

    // Origin lạ bị chặn TRƯỚC mọi thứ, kể cả /ping: một trang bất kỳ đang mở
    // cũng dò được 127.0.0.1, và nó không nên biết cả việc "có cái gì ở đây".
    if (!cors(req, res)) {
      warnRejected(req.headers.origin)
      res.statusCode = 403
      res.end('forbidden origin')
      return
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }

    // /ping là ngoại lệ DUY NHẤT không cần token — client phải dò được runner
    // trước khi biết có nên hỏi người dùng token hay không. Nó cố ý không nói gì
    // về tài khoản: email và gói cước nằm ở /status, sau token.
    if (url.pathname === '/ping') {
      return json(res, 200, { ok: true, runner: 'claude-local', needsToken: true })
    }

    if (req.headers['x-runner-token'] !== token) {
      return json(res, 401, { code: 'runner_token', message: 'Thiếu hoặc sai token của runner.' })
    }

    try {
      if (url.pathname === '/status') {
        const s = await lib.status()
        return json(res, 200, {
          ok: true,
          ready: s.ready,
          account: s.account,
          plan: s.plan,
          auth: s.auth,
          model: s.model,
          reason: s.reason,
        })
      }

      if (url.pathname === '/run') {
        const args = pickRunArgs(await readBody(req))
        if (!args.schema) return json(res, 400, { code: 'bad_request', message: 'schema required' })
        const out = await lib.completeJson(args)
        return json(res, 200, { ok: true, data: out.data, searches: out.searches, cost: out.cost })
      }

      if (url.pathname === '/stream') {
        const args = pickRunArgs(await readBody(req))
        delete args.schema // stream trả text thô, ép schema ở đây là vô nghĩa
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('X-Accel-Buffering', 'no')
        await lib.streamText({ ...args, onDelta: (c) => res.write(c) })
        res.end()
        return
      }

      res.statusCode = 404
      res.end('not found')
    } catch (error) {
      logger.error?.(`[runner] ${url.pathname} -> ${error?.stack || error}`)
      const status = error?.status || 500
      if (!res.headersSent) return json(res, status, { code: 'error', message: String(error?.message || error) })
      // Đã stream ra một phần rồi thì không đổi được status nữa — nói ra trong
      // luồng, đừng cắt im lặng.
      res.write(`\n\n[[ERROR]] ${String(error?.message || error)}`)
      res.end()
    }
  })
}
