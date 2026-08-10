import { existsSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, delimiter } from 'node:path'
import { homedir, platform } from 'node:os'
import { promisify } from 'node:util'

const run = promisify(execFile)
// Resolve từ vị trí FILE NÀY, không phải cwd của process — package có thể nằm
// trong node_modules lồng nhau (npm đặt nó ở đó khi peer dep của SDK lệch với
// repo cha, đúng trường hợp đang xảy ra ở đây).
const req = createRequire(import.meta.url)

// ─────────────────────────────────────────────────────────────────────────────
// "Máy này gọi Claude được không?" — tách khỏi client.js vì nó được hỏi ở hai
// nhịp rất khác nhau: một cái phải SYNC và rẻ (cổng gác của mỗi request), một
// cái được phép chậm (người dùng gõ `claude-local status` và chờ).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tìm binary `claude`.
 *
 * Ưu tiên binary CÓ SẴN của người dùng: đó là bản họ đã `claude auth login` vào,
 * đã `claude update` lên, và là bản họ sẽ debug khi có chuyện. Nhưng nếu không
 * có thì rơi về bản kèm SDK — `npm install` đã tải nó về rồi
 * (`optionalDependencies`, ~270 MB), và nó là một Claude Code đầy đủ.
 *
 * Vì sao phải trả ra ĐƯỜNG DẪN của bản kèm chứ không chỉ "có/không": `status()`
 * cần chạy `claude auth status --json` để biết đã login chưa. Không có đường dẫn
 * thì nó rơi về phép dò Keychain — thứ vẫn báo "đã login" sau khi
 * `claude auth logout`. Tức máy nào chỉ `npm install` mà không cài Claude Code
 * riêng sẽ nhận đúng câu trả lời kém tin cậy nhất.
 *
 * Credential là của MÁY, không của binary (Keychain / ~/.claude), nên hai bản
 * dùng chung một lần đăng nhập — đăng nhập bằng bản nào cũng được.
 */
export function resolveCli() {
  const explicit = process.env.CLAUDE_LOCAL_CLI
  if (explicit) return existsSync(explicit) ? explicit : null

  const exe = platform() === 'win32' ? 'claude.exe' : 'claude'
  const dirs = [
    join(homedir(), '.local', 'bin'),
    ...String(process.env.PATH || '').split(delimiter).filter(Boolean),
  ]
  for (const d of dirs) {
    const p = join(d, exe)
    if (existsSync(p)) return p
  }
  return bundledCli()
}

// Binary theo nền tảng mà Agent SDK khai trong optionalDependencies. Thử cả biến
// thể musl vì Alpine/container không có glibc.
function bundledCli() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const os = platform() === 'darwin' ? 'darwin' : platform() === 'win32' ? 'win32' : 'linux'
  const exe = os === 'win32' ? 'claude.exe' : 'claude'
  for (const suffix of os === 'linux' ? ['', '-musl'] : ['']) {
    try {
      const pkg = req.resolve(`@anthropic-ai/claude-agent-sdk-${os}-${arch}${suffix}/package.json`)
      const p = join(pkg, '..', exe)
      if (existsSync(p)) return p
    } catch {
      /* nền tảng này không được cài — thử biến thể tiếp theo */
    }
  }
  return null
}

export function hasBundledCli() {
  try {
    req.resolve('@anthropic-ai/claude-agent-sdk')
    return true
  } catch {
    return false
  }
}

// SYNC và memoize, vì cổng gác của một web handler thường hỏi "provider sẵn sàng
// chưa" trên MỌI request và hỏi bằng một biểu thức truthiness — không có chỗ để
// await, và cũng không nên spawn process ở đó.
//
// Cố ý chỉ kiểm "có đường chạy tới Claude Code không", KHÔNG kiểm đã login chưa.
// Kiểm login rẻ thì không chính xác (token có thể hết hạn giữa chừng), mà kiểm
// chính xác thì phải gọi thật. Chưa login là lỗi có thật của một lượt gọi có
// thật, và nó nên hiện ra như vậy — chứ không phải thành 503 "chưa cấu hình
// provider", câu nói sai chỗ khi mọi thứ đã cấu hình đúng và chỉ thiếu `claude auth login`.
let readyCache
export function isReady() {
  if (readyCache === undefined) readyCache = Boolean(resolveCli()) || hasBundledCli()
  return readyCache
}

/** Kiểm sâu, có spawn. Dùng cho `claude-local status`. */
export async function status() {
  const cliPath = resolveCli()
  const out = {
    ready: false,
    cliPath,
    version: null,
    auth: 'none',
    account: null,
    plan: null,
    model: process.env.CLAUDE_LOCAL_MODEL || null,
    reason: null,
  }

  if (!cliPath && !hasBundledCli()) {
    out.reason =
      'Không tìm thấy `claude` trong PATH và cũng không có @anthropic-ai/claude-agent-sdk. Cài Claude Code rồi chạy `claude auth login`.'
    return out
  }

  if (cliPath) {
    try {
      const { stdout } = await run(cliPath, ['--version'], { timeout: 15_000 })
      out.version = stdout.trim()
    } catch (e) {
      out.reason = `Chạy \`${cliPath} --version\` lỗi: ${e.message}`
      return out
    }
  }

  Object.assign(out, await detectAuth(cliPath))

  if (out.auth === 'none') {
    out.reason = 'Tìm thấy CLI nhưng chưa đăng nhập. Chạy `claude auth login`.'
    return out
  }

  out.ready = true
  return out
}

// Không đọc NỘI DUNG credential ở bất kỳ nhánh nào — chỉ hỏi "đăng nhập chưa,
// bằng tài khoản nào". Một hàm status in ra token là một hàm status ghi token
// vào log.
async function detectAuth(cliPath) {
  // CLAUDE_CODE_OAUTH_TOKEN đi TRƯỚC mọi phép hỏi khác, và đó là chỗ sửa một bug
  // thật: nhánh này từng nằm dưới cùng, sau lệnh gọi `claude auth status --json`.
  // Trên một máy KHÔNG có credential (container, CI) thì CLI trả `loggedIn: false`
  // → hàm return 'none' ngay ở nhánh đó và không bao giờ chạy tới đây. Kết quả:
  // token đặt đúng, lượt gọi chạy được, mà `status()` vẫn báo chưa sẵn sàng.
  //
  // Nó cũng thắng cả khi CLI ĐANG login: token là cấu hình người ta đặt ra một
  // cách tường minh, và nó chính là thứ tiến trình con sẽ dùng — trả lời bằng tài
  // khoản trong Keychain là nói tên một danh tính không tham gia lượt gọi nào.
  // Cái mất là `account`/`plan`: token không mang theo email, và bịa ra một cái
  // email từ nguồn khác còn tệ hơn để trống.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return { auth: 'oauth-token' }

  // Còn lại thì hỏi CHÍNH CLI, không đoán từ env. Hai lần trước chỗ này đoán và
  // cả hai lần đều sai theo hướng nguy hiểm:
  //  · "Keychain có mục Claude Code-credentials" → mục đó vẫn còn sau
  //    `claude auth logout` và không nói gì về token hết hạn, nên `ready: true`
  //    có thể là lời nói dối ngay trước một lượt gọi hỏng;
  //  · "env có ANTHROPIC_API_KEY nên đang chạy bằng API key" → đo thật thì CLI
  //    đã login vẫn dùng claude.ai và chỉ ghi nhận key ở `apiKeySource`; một
  //    lượt gọi với key hoàn toàn giả vẫn chạy. Báo "api-key" ở đó là nói với
  //    người dùng rằng họ đang tiêu tiền trong khi họ không tiêu.
  if (cliPath) {
    try {
      const { stdout } = await run(cliPath, ['auth', 'status', '--json'], { timeout: 20_000 })
      const j = JSON.parse(stdout)
      if (!j.loggedIn) {
        // Không login mà có key thì lượt gọi vẫn chạy được — bằng API key, tức
        // là TỐN TIỀN. Đó là thông tin phải nói ra, không phải một lỗi.
        return process.env.ANTHROPIC_API_KEY ? { auth: 'api-key' } : { auth: 'none' }
      }
      return {
        auth: j.authMethod === 'claude.ai' ? 'subscription' : j.authMethod || 'unknown',
        account: j.email || null,
        plan: j.subscriptionType || null,
      }
    } catch {
      // Bản CLI cũ chưa có `auth status --json` → rơi xuống phép dò dưới đây.
    }
  }

  if (existsSync(join(homedir(), '.claude', '.credentials.json'))) return { auth: 'subscription' }
  // macOS cất credential trong Keychain chứ không ra file. `find-generic-password`
  // không kèm `-w` thì chỉ trả metadata, không trả mật khẩu.
  if (platform() === 'darwin' && hasKeychainEntry()) return { auth: 'subscription' }
  if (process.env.ANTHROPIC_API_KEY) return { auth: 'api-key' }
  return { auth: 'none' }
}

function hasKeychainEntry() {
  try {
    execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
      stdio: 'ignore',
      timeout: 5_000,
    })
    return true
  } catch {
    return false
  }
}
