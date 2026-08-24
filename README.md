# SERVER_PANEL

Bảng điều khiển web để bật/tắt/theo dõi mọi server của dự án TinyTalk từ trình duyệt.
Chạy trên `http://127.0.0.1:9199`.

- Cột trái: card cho từng service — Start / Stop / Restart / Logs / Pop out / lệnh tuỳ ý
- Cột phải: nhiều khung log cùng lúc, **bám theo** khi cuộn trang
- Dưới cùng: VRAM, requests/min, req theo service, số wav đã xử lí

Thêm server mới = sửa [`services.yaml`](services.yaml) rồi bấm **Reload config**. Không phải sửa code.

---

## Cài đặt

Cần `python3-venv` + `pip` (máy Ubuntu mặc định có thể thiếu):

```bash
sudo apt install -y python3.10-venv python3-pip   # chạy một lần
bash bootstrap.sh
```

## Chạy

```bash
bash run.sh
```

Mở http://127.0.0.1:9199

Panel **không** kill service khi tắt — service chạy detached có chủ đích. Tắt panel
rồi mở lại, nó tự nhận diện (`reconcile`) các service đang chạy và hiện đúng trạng thái.

## Kiểm tra nhanh (không cần bootstrap)

```bash
python3 selftest.py     # hoặc: bash run.sh --check
```

Test thật, không mock: spawn process detached, adopt lại bằng pid file, stop bằng
pkill, tail log qua rotate/truncate, parse access log, đọc `nvidia-smi`.

---

## Khai báo service

Mỗi mục trong `services:` mô tả một thứ chạy được.

| Khoá | Ý nghĩa |
|---|---|
| `id` | định danh, dùng trong URL API |
| `name` / `group` | tên hiển thị, nhóm card |
| `kind` | `process` (một tiến trình) hoặc `composite` (gộp nhiều service) |
| `port` | chỉ để hiển thị |
| `log` / `pid_file` | đường dẫn file log và pid |
| `start.mode` | `process` (panel giữ PID) hoặc `script` (chạy file .sh như job) |
| `start.argv` | lệnh dạng mảng — **ưu tiên dùng cái này**, không lo quoting |
| `start.shell` | lệnh bash, chỉ dùng khi cần `source` |
| `start.env` | biến môi trường thêm vào |
| `start.requires_file` / `requires_bin` | thiếu → card hiện `NO_ENV` thay vì fail |
| `stop.mode` | `pkill` (theo `pattern`), `script`, hoặc `none` |
| `restart.on_crash` | tự bật lại khi chết — **mặc định tắt**, xem mục dưới |
| `health.url` + `health.rules` | quyết định badge ONLINE/DEGRADED/STARTING |
| `health.detail` | dòng thông tin nhỏ dưới tên, dùng `{json.a.b}` |
| `depends_on` | chưa ONLINE thì disable nút Start |
| `conflicts_with` | đang chạy thì chặn Start (hybrid vs vLLM đụng port) |
| `members` | với `kind: composite` — badge lấy trạng thái xấu nhất |
| `actions` | nút phụ: `url`, `script`, hoặc `shell` |

Biến thay thế được: `{root}`, `{log_dir}`, `{home}`.

### Health rule

Là biểu thức trên `json` — chính là body JSON của endpoint health:

```yaml
health:
  url: http://127.0.0.1:8000/health
  rules:
    online: json.status == 'healthy' and json.warm == true
    starting: json.status == 'starting'
    degraded: json.status == 'degraded'
```

Rule **không** chạy qua `eval()` tự do: nó được parse bằng `ast` và chỉ cho phép so
sánh, and/or/not, truy cập thuộc tính, `len()`. Rule sai cú pháp làm **fail ngay lúc
load config**, không phải lúc probe. Key thiếu trả `None` thay vì ném lỗi, nên
`json.cuda_memory.allocated_gb` an toàn kể cả khi service chạy CPU.

Trạng thái: `ONLINE` · `DEGRADED` · `STARTING` · `OFFLINE` · `NO_ENV`.

---

## Vì sao service sống sót khi restart panel

`subprocess.Popen(..., start_new_session=True)` — process nằm trong session/pgid mới,
không có controlling terminal của panel. Ctrl-C hay restart panel không chạm tới nó.

Panel dùng chung thư mục `/tmp/tinytalk-hybrid/*.{log,pid}` với
`tinytalk-intent-service/deploy/scripts/start_hybrid.sh`. Nghĩa là:

- Bạn chạy tay bằng script → mở panel → panel vẫn thấy và điều khiển được
- Panel chạy → bạn chạy `stop_hybrid.sh` ở terminal → panel cập nhật trạng thái

`reconcile()` nhận diện theo thứ tự: pid file (có xác thực `/proc/<pid>/cmdline` để
chống PID reuse) → `pgrep -f <pattern>` → nếu health ONLINE mà không có PID thì đánh
dấu `EXT`. **Health probe luôn là nguồn sự thật cho badge**; PID chỉ để biết gửi
signal cho ai.

---

## Bảo mật

Panel chạy shell tuỳ ý theo `services.yaml`. Các rào chắn:

1. **Bind `127.0.0.1` only.** `run.sh` hardcode. Mở port này ra mạng tương đương phát
   remote shell không mật khẩu. Cần truy cập từ xa thì dùng SSH tunnel:
   `ssh -L 9199:127.0.0.1:9199 <host>` — đừng đổi bind.
2. **Không có auth, có chủ đích.** Trên loopback, ai chạm được đã có sẵn quyền shell
   tương đương. Thêm mật khẩu chỉ là hình thức.
3. **Chặn Origin lạ.** Loopback không tự bảo vệ khỏi một trang web độc POST tới
   `127.0.0.1:9199` (DNS rebinding). Middleware từ chối `Origin`/`Referer` khác
   `127.0.0.1:9199`; mọi endpoint đổi trạng thái đều là POST/PUT/DELETE.
4. **`services.yaml` là trusted input, HTTP body thì không.** Endpoint thực thi chỉ
   nhận **id** — không có đường nào để chuỗi từ request body chạm tới `Popen` /
   `bash -c` / `pkill`. Lệnh luôn tra từ config theo id.
5. **"+ Lệnh" / "Sửa" / "Xóa" chỉ GHI file**, không bao giờ execute thứ vừa nhận.
   Muốn chạy vẫn phải gọi `/actions/{id}` theo id. Ghi atomic + backup trong
   `.config-backups/`; config mới hỏng thì tự rollback. Khoá hẳn bằng:
   ```bash
   PANEL_READONLY_CONFIG=1 bash run.sh
   ```
6. **Pattern `pkill` bị kiểm 2 lần** (lúc load config và lúc gọi): tối thiểu 8 ký tự,
   không được là tên interpreter trần (`python`, `node`…), không được khớp cmdline của
   chính panel. Đây là lý do `stop_hybrid.sh` không giết `:9199` — panel mirror cùng
   cơ chế đó sang Python.
7. **Script phải nằm dưới `defaults.root`** hoặc thư mục panel; `..` bị từ chối.
8. **Che secret**: `/api/config` mask env khớp `TOKEN|KEY|SECRET|PASSWORD|AUTH`;
   dòng log stream ra trình duyệt cũng bị lọc cùng regex, phòng khi authtoken lỡ
   được echo vào `ngrok.log`.

---

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PANEL_PORT` | `9199` | cổng panel |
| `PANEL_CONFIG` | `services.yaml` | file config; có `services.local.yaml` thì ưu tiên nó |
| `PANEL_READONLY_CONFIG` | — | `=1` để khoá mọi endpoint sửa config |
| `PANEL_LOG_LEVEL` | `INFO` | mức log của panel |
| `PANEL_DB` | `data/series.db` | nơi lưu time-series dài hạn |
| `PANEL_DISK_WARN_GB` | `10` | dưới ngần này GB trống thì báo sự cố |

`services.local.yaml` nằm trong `.gitignore` — dùng để thử nghiệm mà không đụng file chính.

---

## Sự cố, số liệu dài hạn, tự bật lại

**Hồ sơ sự cố.** Service rơi từ ONLINE xuống OFFLINE/DEGRADED thì panel chốt mốc thời
gian và **chụp 50 dòng cuối** của log service đó ngay lúc ấy, kêu một tiếng, đẩy thông
báo hệ thống (bấm *Bật thông báo* một lần để cấp quyền) và ghim một thanh đỏ ở đầu
trang — bấm vào xem lại log lúc gãy. Ghi vào `{log_dir}/incidents.jsonl` nên sống sót
qua restart panel. Bỏ qua mọi thứ đi qua UNKNOWN/STARTING: panel vừa mở hoặc TinySpeech
đang tải 3 GB model không phải là sự cố.

**Số liệu dài hạn.** RAM giữ 10 phút ở nhịp 2s cho biểu đồ thời gian thực; mỗi 30s panel
gộp xuống SQLite (`data/series.db`, giữ 72 giờ, ô 30s). Nút *1 giờ / 6 giờ / 24 giờ* ở
chân trang biểu đồ đọc từ đĩa — dòng trạng thái nói rõ đang xem nguồn nào, vì hai nguồn
mịn khác nhau. Gộp bằng đúng hàm mà series đó dùng (probe latency lấy `max` để không
làm phẳng mất spike).

**Đĩa trống** được đo mỗi 30s cho phân vùng chứa `{root}` và `{log_dir}` (cùng phân vùng
thì chỉ đo một lần), hiện ở ô KPI và báo sự cố khi xuống dưới `PANEL_DISK_WARN_GB`.

**Tự bật lại.** Mặc định TẮT. Bật cho từng service trong `services.yaml`:

```yaml
restart:
  on_crash: true
  delay_s: 10        # chờ trước lần thử đầu
  backoff: 2         # 10s → 20s → 40s
  max_delay_s: 300
  max_tries: 3       # quá 3 lần trong window_s thì dừng hẳn và ghi sự cố
  window_s: 1800
```

Chỉ nhận trạng thái **OFFLINE** — STARTING là đang tải model, NO_ENV là thiếu file, bật
lại đều vô nghĩa. Bạn tự bấm Dừng thì panel không đụng vào. Hết trần thì **dừng hẳn**:
một service chết đi chết lại là việc của con người, không phải của vòng lặp.

---

## Điểm cần biết

- **Hybrid và vLLM đụng port** (8001/8002/8088) nên không chạy song song. `conflicts_with`
  khiến panel chặn Start thay vì để bạn tự nhớ.
- **Số request lấy từ access log của uvicorn**, mà dòng đó **không có timestamp** — event
  được đóng dấu lúc panel đọc được. Sai số dưới ~1s, đủ cho dashboard, **đừng dùng để đo
  latency**. Lúc khởi động parser nhảy tới cuối file nên chart bắt đầu trống rồi đầy dần.
  Service nào không bật access log thì đơn giản là không có thanh trong "req by service";
  thêm `log_metrics.regex` để override.
- **Probe `/health` của chính panel bị loại** khỏi requests/min (đếm riêng), nếu không
  con số sẽ bị thổi phồng.
- **`pkill -f` có thể giết nhầm** — ví dụ `pkill -f 'cpu_inference.server'` cũng khớp một
  editor đang mở file đó. Panel ưu tiên giết theo process group của pid đã biết, pkill chỉ
  là fallback, nhưng không loại bỏ được hoàn toàn. Rủi ro này kế thừa từ script gốc.
- **`pkill 'ngrok start'` giết mọi agent ngrok**, kể cả tunnel không liên quan
  (ví dụ `npm run tunnel` của qr-generator).
- **Log không tự rotate.** `cpu_inf.log` với llama.cpp verbose sẽ phình. Card có nút
  **Xoá log** (truncate) khi cần.

## Cấu trúc

```
bootstrap.sh  run.sh  requirements.txt  services.yaml  selftest.py
panel/
  main.py        FastAPI: REST + 2 WebSocket + static, middleware Origin
  config.py      YAML → dataclass, validate, safe rule evaluator, ghi atomic
  supervisor.py  spawn detached, stop, reconcile PID, job one-shot
  health.py      poller + phân loại trạng thái + roll-up composite
  logs.py        backfill + tail -F (rotate/truncate/chưa-tồn-tại)
  metrics.py     nvidia-smi + parser access log
  series.py      time-series trong RAM (10 phút, nhịp 2s)
  archive.py     gộp 30s rồi lưu SQLite, giữ 72 giờ
  incidents.py   chụp log lúc service gãy + cảnh báo
  static/        index.html popout.html panel.css app.js charts.js
```
