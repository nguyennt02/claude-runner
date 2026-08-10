import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// Bộ khoá. Đây là file quan trọng nhất của package.
//
// `query()` không phải một lượt gọi API — nó spawn **Claude Code thật** trên máy
// người dùng, và mặc định của Claude Code là một agent lập trình: Bash, Write,
// Edit, đọc file, chạy MCP server, nạp CLAUDE.md và settings cá nhân. Package này
// dùng nó như một text/JSON generator, nên mọi thứ đó phải tắt — không phải để
// "cho gọn" mà vì một prompt đến từ web form là **input không tin được**, và
// khoảng cách giữa "tóm tắt giúp tôi" với "chạy giúp tôi `rm -rf`" chỉ đúng bằng
// bộ khoá này.
//
// BA LỚP, CỐ Ý TRÙNG NHAU:
//   1. `tools` — ALLOWLIST. Đây là lớp chính: nó khai *tập tool nền* của phiên,
//      `[]` nghĩa là không có built-in tool nào tồn tại để mà gọi.
//   2. `disallowedTools` — denylist tường minh cho những cái tên nguy hiểm nhất.
//   3. `canUseTool` — deny-by-default, chạy trong process này.
//
// Vì sao cần cả ba, khi lớp 1 nghe đã đủ: lớp 2 và 3 chặn được thứ lớp 1 không
// biết tới. Bản đầu của file này CHỈ có lớp 2+3, và nó **đã hụt** — một lượt
// dogfood cho thấy model vẫn nhìn thấy một tool tên `Monitor` (chạy shell) không
// có trong danh sách. Đó chính là điều phải chờ đợi ở một denylist: nó liệt kê
// những cái tên biết vào lúc viết, còn Claude Code thì thêm tool theo bản phát
// hành. Allowlist không có kiểu hụt đó — nhưng nó là option của SDK, nên nếu một
// bản SDK sau đổi nghĩa `tools` thì lớp 3 vẫn còn đứng.
// Bỏ bất kỳ lớp nào đi là bỏ đúng lớp che cho một kiểu hụt khác nhau.
// ─────────────────────────────────────────────────────────────────────────────

// Tool duy nhất được phép, và chỉ khi caller xin. Không có "vừa đủ đọc file" ở
// đây: đọc được file là đọc được `.env` của chính project đang chạy.
export const WEB_TOOLS = ['WebSearch', 'WebFetch']

// Denylist (lớp 2). KHÔNG phải nguồn sự thật — `tools` ở trên mới là. Danh sách
// này chỉ nêu đích danh những cái tên mà việc chúng lọt qua là tệ nhất, để nếu
// lớp 1 hỏng thì lớp 2 còn chặn đúng chỗ đau. `WEB_TOOLS` bị lọc khỏi đây khi
// caller xin chúng — một tool nằm cả hai bên thì CLI xử theo bên chặn.
const BLOCKED = [
  'Bash', 'BashOutput', 'KillShell', 'Monitor',
  'Read', 'Write', 'Edit', 'NotebookEdit',
  'Glob', 'Grep',
  'Task', 'Agent',
  'WebSearch', 'WebFetch',
  'TodoWrite', 'Skill', 'SlashCommand',
]

// Một thư mục rỗng, KHÔNG phải thư mục project. Claude Code lấy cwd làm gốc cho
// mọi thao tác file và làm chỗ dò CLAUDE.md/.claude; trỏ vào repo là mời nó đọc
// source. Tạo một lần cho cả process — không có gì được ghi vào đây, nó chỉ cần
// tồn tại và không chứa gì.
let scratch
function scratchDir() {
  if (!scratch) scratch = mkdtempSync(join(tmpdir(), 'claude-local-'))
  return scratch
}

/**
 * Dựng `options` cho `query()`. Mọi lượt gọi trong package đi qua đây — không có
 * đường nào khác dựng options, để không ai vô tình bỏ sót một khoá.
 */
export function safeOptions({ webTools = false, model, effort, maxTurns = 8, cli, signal, extra } = {}) {
  // `granted`, không phải `allowedTools`: đây là thứ caller XIN, và nó đi vào
  // option `tools` (lớp 1) + `canUseTool` (lớp 3). Option tên `allowedTools` của
  // SDK có nghĩa khác hẳn — "auto-duyệt, khỏi hỏi" — và luôn để rỗng ở đây.
  const granted = webTools ? [...WEB_TOOLS] : []
  const disallowedTools = BLOCKED.filter((t) => !granted.includes(t))

  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    maxTurns,

    // Không nạp settings.json / CLAUDE.md / plugin / skill của người dùng. Bỏ
    // dòng này là mỗi lượt gọi kéo theo cấu hình cá nhân của máy đang chạy: kết
    // quả đổi theo máy, và MCP server trong settings sẽ được bật thật.
    settingSources: [],
    mcpServers: {},
    skills: [],

    // Lớp 1 — tập tool nền của phiên. `[]` = không có built-in tool nào tồn tại.
    tools: granted,
    // Lớp 2 — denylist tường minh.
    disallowedTools,
    // `allowedTools` cố ý ĐỂ RỖNG, kể cả khi caller xin web tool. Một cái tên
    // trần trong đây được auto-duyệt TRƯỚC khi `canUseTool` được hỏi — SDK cảnh
    // báo đúng chuyện đó (CLAUDE_SDK_CAN_USE_TOOL_SHADOWED) — nghĩa là lớp 3 bị
    // vô hiệu cho đúng những tool duy nhất thật sự chạy. Để rỗng thì mọi lượt
    // gọi tool, không trừ cái nào, đều phải đi qua một cổng duy nhất bên dưới.
    allowedTools: [],

    // 'default', KHÔNG phải 'dontAsk': ở đây `canUseTool` LÀ người trả lời câu
    // hỏi quyền, nên phải để nó được hỏi. 'dontAsk' nghĩa là "từ chối thứ chưa
    // pre-approve" và `allowedTools` thì đang rỗng — đặt nó vào là chặn luôn cả
    // WebSearch trước khi lớp 3 kịp duyệt, tức consumer mất search mà không có
    // lỗi nào nói vì sao.
    //
    // Không có "hỏi người dùng" nào xảy ra dù mode là 'default': `canUseTool`
    // trả verdict ngay, không bao giờ trả về ask. Và KHÔNG dùng
    // 'bypassPermissions' — nó còn đòi `allowDangerouslySkipPermissions: true`,
    // cái tên đã nói đúng nó làm gì.
    permissionMode: 'default',
    // Lớp 3 — cổng duy nhất mọi lượt gọi tool phải qua.
    canUseTool: denyExcept(granted),

    cwd: scratchDir(),
    ...(cli ? { pathToClaudeCodeExecutable: cli } : {}),
    ...(signal ? { abortController: toController(signal) } : {}),
    ...extra,
  }
}

// ⚠️ `env` KHÔNG được đặt ở đây, và đó là một quyết định đã thử rồi mới bỏ.
//
// Tiến trình con kế thừa `process.env`, nên một `ANTHROPIC_API_KEY` sót lại —
// chuyện gần như chắc chắn ở project vốn có nhánh gọi API, nơi `.env` giữ key
// cho nhánh đó và dev-server nạp nguyên file — trông rất giống một lỗ tiêu tiền
// âm thầm. Bản trước vì thế lột key khỏi env của tiến trình con.
//
// Đo thật thì tiền đề đó SAI: Claude Code 2.1.223 đã login vẫn dùng credential
// claude.ai và chỉ ghi nhận `apiKeySource` trong `claude auth status` — một lượt
// gọi với key HOÀN TOÀN GIẢ trong env vẫn chạy bình thường. Lột key không cứu ai
// cả, mà lại làm hỏng đúng người dùng API key và KHÔNG login: `status()` báo sẵn
// sàng còn lượt gọi thì mất credential.
//
// Nguồn sự thật cho "lượt này tính tiền vào đâu" là chính CLI (`auth status`),
// và status.js hỏi nó. Đừng đoán từ env ở đây.

// Lớp 3. Nhận vào tên tool và trả verdict; không có nhánh nào trả `allow` cho
// một cái tên không nằm trong whitelist, kể cả tool chưa tồn tại lúc viết dòng này.
export function denyExcept(allowedTools) {
  const ok = new Set(allowedTools)
  return async (toolName, input) => {
    if (ok.has(toolName)) return { behavior: 'allow', updatedInput: input }
    return { behavior: 'deny', message: `claude-local: tool "${toolName}" bị chặn (chỉ cho phép: ${[...ok].join(', ') || 'không tool nào'})` }
  }
}

// `query()` nhận AbortController, còn phía web truyền AbortSignal (đó là thứ
// `fetch` và `api/chat.js` đang có sẵn). Bắc cầu ở đây thay vì bắt mọi caller
// tự dựng controller.
function toController(signal) {
  const ac = new AbortController()
  if (signal.aborted) ac.abort()
  else signal.addEventListener('abort', () => ac.abort(), { once: true })
  return ac
}
