# claude-runner

Chạy Claude bằng **Claude Code CLI đã đăng nhập trên máy này**, mở ra qua một cổng loopback có
CORS allowlist + token. Chi phí API biên = $0 (tính vào subscription của máy).

Package này **không biết gì về app gọi nó**: nó nhận prompt + schema, trả kết quả. Mọi thứ mang
hình dạng của một sản phẩm cụ thể — tên endpoint, envelope riêng, `tools` hình dạng của một nhà
cung cấp — đều thuộc về phía app, không thuộc về đây.

---

## Dùng

```bash
npx github:nguyennt02/claude-runner https://app.example.com
```

Origin của app là **bắt buộc** — bộ chạy chỉ trả lời trang nào bạn nêu đích danh. Bỏ trống thì
nó chỉ nhận `localhost:5173` (đường dev), và mọi request từ domain thật sẽ bị chặn ở CORS.

Nó in ra một link ghép đôi. Mở link đó trên app để app biết đường gọi về máy bạn.

Cần có trước: **Node 18+** và một tài khoản Claude trả phí đã đăng nhập:

```bash
claude auth login
```

> ⚠️ Lệnh là `claude auth login`. **`claude login` không tồn tại** — nó rơi vào phiên chat và coi
> "login" là câu hỏi gửi cho model, không báo lỗi gì, nên rất dễ tưởng đã chạy xong.

Chưa cài Claude Code cũng được — `npm install` kéo theo binary của Agent SDK (~300 MB). Đã cài rồi
thì nó dùng bản có sẵn trong `PATH`.

Kiểm máy đã sẵn sàng chưa: chạy lệnh trên rồi xem dòng đầu — nó in ra email và gói cước, hoặc lý
do chưa sẵn sàng.

## Biến môi trường

| Biến | Mặc định | |
|---|---|---|
| tham số thứ nhất, hoặc `RUNNER_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Danh sách phẩy. **Không nhận `*`** |
| `RUNNER_PORT` | `8787` | |
| `RUNNER_TOKEN` | tự sinh mỗi lần chạy | In ra lúc khởi động |
| `CLAUDE_LOCAL_MODEL` | `claude-sonnet-5` | Model mặc định |
| `CLAUDE_LOCAL_CLI` | tự dò | Ghim đường dẫn binary `claude` |

## Route

| | Token | |
|---|---|---|
| `GET /ping` | không | `{ ok, runner, needsToken }` — client phải dò được runner trước khi biết có nên hỏi token hay không. Cố ý **không** nói gì về tài khoản |
| `POST /status` | có | `{ ready, account, plan, auth }` — lộ email + gói cước nên nằm sau token |
| `POST /run` | có | `{ system, prompt, schema, images?, webTools?, maxTurns?, effort?, model? }` → `{ data, searches, cost }` |
| `POST /stream` | có | Như trên, không `schema` → trả `text/plain` từng chunk |

`cost` là **ước tính giá API tương đương**, không phải tiền bị trừ.

---

## 🔒 An toàn — phần quan trọng nhất

`query()` không phải một lượt gọi API: nó spawn **Claude Code thật** trên máy, và mặc định của
Claude Code là một agent lập trình (Bash, Write, Edit, MCP, nạp cấu hình cá nhân). Prompt tới từ
web là **input không tin được**. Ba lớp trong `src/safety.js`:

| | Cơ chế | Chặn được gì |
|---|---|---|
| 1 | `tools: []` — **allowlist**, tập tool nền của phiên | mọi built-in tool, kể cả tool chưa tồn tại |
| 2 | `disallowedTools: [Bash, Read, Write, Edit, Monitor, …]` | những tên nguy hiểm nhất, nếu lớp 1 hỏng |
| 3 | `canUseTool` deny-by-default | mọi lượt gọi tool, không trừ cái nào |

Cộng `settingSources: []` · `mcpServers: {}` · `skills: []` · `cwd` = tmp rỗng · **không**
`bypassPermissions`.

**Vì sao cần cả ba:** bản đầu chỉ có lớp 2+3 và đã hụt — model vẫn thấy tool `Monitor` (chạy shell)
vì nó không có trong danh sách. Đó đúng là điều phải chờ đợi ở một denylist: nó liệt kê những tên
biết vào lúc viết, còn Claude Code thì thêm tool theo bản phát hành.

Hai chi tiết dễ làm hỏng khi sửa:
- **`allowedTools` LUÔN rỗng**, kể cả khi xin web tool. Nghĩa của nó là *"auto-duyệt, khỏi hỏi
  `canUseTool`"* — đặt `WebSearch` vào đó là vô hiệu hoá lớp 3 cho đúng tool duy nhất thật sự chạy.
- **`permissionMode: 'default'`, KHÔNG phải `'dontAsk'`.** `canUseTool` *là* người trả lời câu hỏi
  quyền nên phải để nó được hỏi; `'dontAsk'` + `allowedTools` rỗng = chặn luôn WebSearch trước khi
  lớp 3 kịp duyệt, tức mất search mà **không có lỗi nào nói vì sao**.

### Hai cổng gác của HTTP, cả hai đều cần

- **CORS allowlist** chặn trang khác **ĐỌC** kết quả. Origin lạ bị chặn trước cả `/ping`: một trang
  bất kỳ đang mở cũng dò được `127.0.0.1`, và nó không nên biết cả việc "có cái gì ở đây".
- **Token** chặn chúng **GỌI**. Thiếu vế này thì một request lọt qua vẫn tiêu quota dù kẻ gọi không
  đọc được gì. **Không có chế độ không token.**
- Bind **`127.0.0.1`**, không phải `0.0.0.0`: mở ra LAN là biến subscription cá nhân thành API mở
  cho cả quán cà phê.

⚠️ Runner chạy **prompt bất kỳ**, không giới hạn trong một tập câu hỏi định trước. Bề mặt đó rộng
hơn hẳn một endpoint cố định — đừng nới hai cổng gác trên.

---

## Giới hạn đã biết

- **Chỉ chạy local.** Nó đọc credential của **máy đang chạy**. Serverless (Vercel/Lambda) không có
  Keychain của ai cả.
- **Không có `maxTokens`.** Agent SDK không nhận trần output token; CLI tự quyết. Caller truyền vào
  cũng bị bỏ qua — cố ý, thà không nhận còn hơn nhận rồi lờ đi.
- **`web_search` ở đây không có `user_location`.** Tra theo quốc gia là thứ chỉ đường API mới làm
  được. Tính năng nào cần hỏi cùng một câu từ nhiều thị trường phải gác trước, không thì N "thị
  trường" đó chưa bao giờ khác nhau — bịa đội lốt kiểm chứng chéo, còn kèm search count thật nên
  khó phát hiện hơn một lượt chạy không có tool.
- **Trình duyệt:** Safari **chặn hẳn** trang `https://` gọi về `http://127.0.0.1` (Mixed Content,
  không có quyền nào để xin). Chrome/Edge 142+ hiện prompt "Local Network Access" — từ chối hoặc lờ
  đi thì request hỏng **im lặng**. Firefox chạy.

## Kiểm

```bash
npm test     # hình dạng: bộ khoá, envelope, cổng gác HTTP. Không mạng, không quota
npm run smoke   # đường dây có điện: spawn `claude` thật. Cần mạng + đăng nhập + quota
```

Hai thứ hỏng theo hai kiểu khác nhau nên không gộp.
