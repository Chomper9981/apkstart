# ApkStart MCP server (cho AI agent)

ApkStart có sẵn một **MCP server** để AI agent (Claude Code, Claude Desktop, Cursor… bất kỳ
client MCP nào) tự cài, chạy, nhìn và thao tác ứng dụng Android trong runtime tích hợp của
ApkStart — **không cần điện thoại, không cần Android SDK / Android Studio**.

Server dùng chung runtime với cửa sổ ApkStart (adb server riêng ở cổng 5044):
nếu ApkStart đang mở một ứng dụng, agent thấy đúng thiết bị đó; nếu chưa chạy, agent gọi
`runtime_start` để khởi động.

## Cấu hình

### Bản cài đặt (ApkStart-x.y.z-Setup.exe)

Cài mặc định nằm ở `%LOCALAPPDATA%\Programs\ApkStart`. Chạy server bằng chính `ApkStart.exe`
ở chế độ Node (không cần cài Node.js):

**Claude Code** (`.mcp.json` trong project, hoặc `claude mcp add-json`):

```json
{
  "mcpServers": {
    "apkstart": {
      "command": "C:\\Users\\<bạn>\\AppData\\Local\\Programs\\ApkStart\\ApkStart.exe",
      "args": ["C:\\Users\\<bạn>\\AppData\\Local\\Programs\\ApkStart\\resources\\app\\src\\mcp\\server.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

**Claude Desktop**: thêm cùng khối `apkstart` ở trên vào `claude_desktop_config.json`.

> Có thể dùng gọn `ApkStart.exe --mcp` (không cần `env`), nhưng Electron in thêm một dòng
> trống ra stdout lúc khởi động; đa số client bỏ qua được, cách `ELECTRON_RUN_AS_NODE` ở trên
> thì sạch hoàn toàn.

### Từ mã nguồn

```json
{
  "mcpServers": {
    "apkstart": { "command": "node", "args": ["D:\\Projects\\apkstart\\src\\mcp\\server.js"] }
  }
}
```

hoặc `npm run mcp`. Runtime được lấy theo cài đặt của ApkStart (mở ApkStart một lần để nó
chuẩn bị runtime).

### Biến môi trường

| Biến | Tác dụng |
|---|---|
| `APKSTART_MCP_ALLOW_SHELL=1` | Thêm tool `shell` (chạy lệnh `adb shell` tùy ý). Mặc định tắt. |
| `APKSTART_MCP_KEEP_RUNTIME=1` | Khi server thoát, **không** tắt runtime mà chính server đã khởi động. |

Runtime do cửa sổ ApkStart khởi động thì server không bao giờ tắt khi thoát.

## Tools

| Tool | Làm gì |
|---|---|
| `runtime_status` | Runtime có chạy không; serial, Android, kích thước/mật độ màn hình, app đang ở foreground |
| `runtime_start` / `runtime_stop` | Khởi động (lần đầu 20–90 s, sau đó vài giây nhờ snapshot) / tắt runtime (giữ app & dữ liệu) |
| `install_apk` | Cài/cập nhật APK từ đường dẫn trên PC, trả về tên gói; `launch: true` để mở luôn |
| `list_apps`, `uninstall_app`, `clear_app_data` | Quản lý gói; `clear_app_data` = về trạng thái như mới cài (dùng giữa các lần test) |
| `launch_app` / `stop_app` / `current_app` | Mở (kiểm tra tiến trình sống, báo crash kèm logcat) / dừng / xem app foreground |
| `ui_tree` | Danh sách phần tử trên màn hình: chữ, mô tả, resource-id, cờ (clickable, checked…) và **tâm để bấm** `@(x,y)` |
| `find_elements` | Tìm phần tử theo `text` / `resource_id` / `description` |
| `tap` | Bấm theo toạ độ hoặc theo `text` / `resource_id` / `description`; `long_press: true` để nhấn giữ |
| `swipe`, `scroll` | Vuốt theo toạ độ / cuộn theo hướng |
| `type_text` | Gõ chữ ASCII vào ô đang focus (`submit: true` để Enter) |
| `press_key` | back, home, enter, delete, tab, app_switch, dpad_*, volume_*… hoặc keycode số |
| `wait_for` | Chờ phần tử xuất hiện (hoặc biến mất với `gone: true`) |
| `screenshot` | Ảnh PNG màn hình |
| `logcat` | Log Android; lọc theo `package` (theo PID), `level`, `grep`; `crashes: true` đọc buffer crash; `clear: true` xoá log |

Vòng làm việc gợi ý cho agent: `runtime_status` → `runtime_start` → `install_apk` →
`ui_tree` → `tap(text=…)` / `type_text` → `wait_for` → `screenshot` / `logcat`.

## Giới hạn

- `type_text` chỉ gõ được ASCII (giới hạn của `adb shell input text`).
- Runtime là máy ảo Android x86_64: app chỉ có thư viện ARM chạy qua lớp dịch ARM của image
  tương thích (ApkStart tự chuyển khi gặp lỗi ABI).
- Runtime cần cửa sổ (không có chế độ headless thật): khi agent tự khởi động, cửa sổ trình giả
  lập sẽ hiện trên màn hình.
- Nếu cửa sổ ApkStart đang mở, cơ chế tự tắt khi rảnh (mặc định 15 phút không có app nào chạy)
  vẫn áp dụng cho runtime; agent gọi lại `runtime_start` nếu cần.
