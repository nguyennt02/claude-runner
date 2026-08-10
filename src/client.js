import { safeOptions, WEB_TOOLS } from './safety.js'
import { resolveCli } from './status.js'

// ─────────────────────────────────────────────────────────────────────────────
// Bọc `query()` của Agent SDK thành 3 primitive: complete · completeJson ·
// streamText.
//
// API ở đây cố ý GENERIC — không có `tools` hình dạng Anthropic, không có
// envelope `{data, searches}` của một project cụ thể, không có tên biến môi
// trường của ai. Project nào muốn dùng thì tự viết một adapter mỏng ở PHÍA NÓ.
// Đó là ranh giới giữ cho package này mang đi chỗ khác được — kể cả trong chú
// thích cũng không nêu tên một consumer nào, vì một cái tên hôm nay là một giả
// định về môi trường vào ngày package được copy sang project thứ hai.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `query` được TIÊM vào thay vì import cứng, vì mọi thứ trong file này chỉ có
 * một cách kiểm chứng khác là spawn `claude` thật: chậm, cần mạng, tốn quota, và
 * không dựng được các nhánh hỏng (structured_output thiếu, subtype lỗi). Test
 * gọi `createClient({ query: fake })` và assert trên **đúng options đã gửi đi** —
 * đó là cách duy nhất canh được bộ khoá trong safety.js.
 */
export function createClient({ query, cli, model: defaultModel } = {}) {
  const cliPath = cli === undefined ? resolveCli() : cli

  async function load() {
    if (query) return query
    // Dynamic import: package vẫn nạp được (và `isReady()` vẫn trả lời được)
    // trên môi trường không có SDK — lỗi rơi vào lượt gọi, không vào lúc import.
    const mod = await import('@anthropic-ai/claude-agent-sdk')
    return mod.query
  }

  function opts({ webTools, model, effort, maxTurns, signal, extra }) {
    return safeOptions({
      webTools,
      model: model || defaultModel || process.env.CLAUDE_LOCAL_MODEL || undefined,
      effort,
      maxTurns,
      cli: cliPath || undefined,
      signal,
      extra,
    })
  }

  /**
   * Chạy một lượt và gom kết quả.
   * @returns {{ text, json, cost, turns, searches, usage, subtype }}
   */
  async function run({ prompt, images, system, schema, webTools, model, effort, maxTurns, signal, onDelta }) {
    const q = await load()
    const stream = q({
      prompt: buildPrompt(prompt, images),
      options: opts({
        webTools,
        model,
        effort,
        maxTurns,
        signal,
        extra: {
          ...(system ? { systemPrompt: system } : {}),
          ...(schema ? { outputFormat: { type: 'json_schema', schema } } : {}),
          ...(onDelta ? { includePartialMessages: true } : {}),
        },
      }),
    })

    let text = ''
    let json
    let cost = 0
    let turns = 0
    let searches = 0
    let subtype = null
    let usage = null
    let failure = null

    for await (const msg of stream) {
      // `searches` phải đếm lượt tool THẬT SỰ chạy, không suy từ "có đưa tool".
      // Đây là thứ badge 🌐 trên UI dựa vào, và một badge nói "đã verify bằng
      // web" cho lượt chạy không search lần nào thì tệ hơn không có badge.
      if (msg.type === 'assistant') {
        for (const b of msg.message?.content ?? []) {
          if (b?.type === 'tool_use' && WEB_TOOLS.includes(b.name)) searches++
          // Không có onDelta thì text gom ở đây; có onDelta thì gom ở stream_event
          // bên dưới để tránh đếm hai lần.
          if (!onDelta && b?.type === 'text' && typeof b.text === 'string') text += b.text
        }
      }

      if (onDelta && msg.type === 'stream_event') {
        const ev = msg.event
        // CHỈ `text_delta`. Cùng một event stream còn mang `thinking_delta` và
        // `signature_delta`; nối chúng vào là in phần suy nghĩ của model ra
        // thẳng khung chat của người dùng.
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          const d = ev.delta.text || ''
          if (d) {
            text += d
            onDelta(d)
          }
        }
      }

      if (msg.type === 'result') {
        subtype = msg.subtype
        cost = msg.total_cost_usd ?? 0
        turns = msg.num_turns ?? 0
        usage = msg.usage ?? null
        if (msg.subtype === 'success') {
          if (msg.structured_output !== undefined) json = msg.structured_output
          if (!text && typeof msg.result === 'string') text = msg.result
        } else {
          failure = msg
        }
      }
    }

    if (failure) throw resultError(failure)
    return { text, json, cost, turns, searches, usage, subtype }
  }

  return {
    async complete(args) {
      return run(args)
    },

    async completeJson({ schema, ...args }) {
      if (!schema) throw new Error('claude-local: completeJson cần `schema`')
      const out = await run({ ...args, schema })
      // `structured_output` là đường chính (CLI đã ép schema). Fallback parse text
      // tồn tại cho bản CLI cũ hơn `outputFormat` — không phải để "sửa" một model
      // trả sai, chỉ để không chết trên máy chưa update.
      const data = out.json !== undefined ? out.json : parseJson(out.text)
      return { data, cost: out.cost, turns: out.turns, searches: out.searches, usage: out.usage }
    },

    async streamText({ onDelta, ...args }) {
      const out = await run({ ...args, onDelta: onDelta || (() => {}) })
      return out.text
    },
  }
}

// `prompt` nhận string hoặc AsyncIterable. Chỉ dùng dạng thứ hai khi CÓ ảnh —
// dạng string là đường đi thường, và giữ nó nguyên vẹn cho trường hợp không ảnh
// nghĩa là 99% lượt gọi không phải đi qua generator.
//
// Ảnh đặt TRƯỚC text: hỏi xong mới cho nhìn thì model đã trả lời rồi.
function buildPrompt(prompt, images) {
  const list = Array.isArray(images) ? images.filter((im) => im?.media_type && im?.data) : []
  if (!list.length) return String(prompt ?? '')

  const content = [
    ...list.map((im) => ({
      type: 'image',
      source: { type: 'base64', media_type: im.media_type, data: im.data },
    })),
    ...(prompt ? [{ type: 'text', text: String(prompt) }] : []),
  ]

  return (async function* () {
    yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content } }
  })()
}

function parseJson(text) {
  const s = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return JSON.parse(s)
}

// Lỗi mang `status` để `errorPayload()` phía project cha phân loại được y như
// lỗi từ SDK Anthropic — nếu không thì mọi hỏng hóc của nhánh local đều rơi về
// "error_generic: kiểm tra API key", câu tệ nhất có thể nói với người đang chạy
// nhánh không dùng API key.
function resultError(msg) {
  const err = new Error(`claude-local: ${msg.subtype}${msg.result ? ` — ${String(msg.result).slice(0, 300)}` : ''}`)
  if (msg.subtype === 'error_max_turns') err.status = 400
  else if (msg.api_error_status) err.status = msg.api_error_status
  else err.status = 500
  err.subtype = msg.subtype
  return err
}
