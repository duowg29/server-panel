/* Tab Biểu đồ.

   Chỉ fetch và vẽ khi tab ĐANG MỞ và cửa sổ trình duyệt đang hiện — ba lớp
   bảo vệ CPU: tab đóng, trình duyệt ẩn, nút Tạm dừng.

   Ngược lại, sampler ở backend LUÔN chạy. Nếu tắt cả sampler theo tab thì mở
   tab ra sẽ thấy 10 phút trống, hỏng hẳn mục đích "xem lại lúc nãy vì sao chậm".
*/

const ChartsTab = {
  timer: null,
  meta: null,
  built: false,
  paused: false,
  window_s: 300,
  abort: null,

  async start() {
    if (this.timer) return;
    if (!this.meta) {
      try { this.meta = await (await fetch('/api/series/meta')).json(); }
      catch { return; }
    }
    if (!this.built) { this.build(); this.built = true; }
    this.tick();
    this.timer = setInterval(() => this.tick(), 2000);
  },

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.abort) { this.abort.abort(); this.abort = null; }
  },

  // ── dựng khung DOM một lần ─────────────────────────────────────────
  build() {
    const svcs = (this.meta.services || []).map(s => s.id);
    const root = document.getElementById('charts-body');

    const tile = (id, title, sub) =>
      `<div class="kpi" id="kpi-${id}">
         <h4>${title}</h4>
         <div class="kpi__v">—</div>
         <div class="kpi__s">${sub || ''}</div>
         <div class="kpi__spark"></div>
       </div>`;

    const chart = (id, title, note) =>
      `<div class="chart" id="ch-${id}">
         <h3>${title}${note ? `<span class="note">${note}</span>` : ''}</h3>
         <div class="chart__body"></div>
       </div>`;

    root.innerHTML = `
      <div class="kpirow">
        ${tile('gpu', 'GPU', 'mức tải')}
        ${tile('vram', 'VRAM', 'đã dùng')}
        ${tile('cpu', 'CPU máy', `${this.meta.nproc || '?'} nhân`)}
        ${tile('ram', 'RAM máy', 'đã dùng')}
        ${tile('req', 'Request', 'mỗi phút')}
        ${tile('lat', 'Intent API', 'độ trễ probe')}
      </div>

      <section class="sec"><h2>GPU</h2>
        <div class="chartgrid">
          ${chart('gpu_time', 'GPU theo thời gian', 'mức tải · bộ nhớ · nhiệt độ · điện')}
          ${chart('vram_split', 'VRAM đang chia cho ai', 'ngay lúc này')}
          ${chart('vram_time', 'VRAM theo tiến trình', '')}
          ${chart('gpu_clock', 'Xung nhịp GPU', 'MHz')}
        </div>
      </section>

      <section class="sec"><h2>Độ trễ</h2>
        <div class="chartgrid">
          ${chart('lat_dep', 'Phụ thuộc của Intent API', 'đường đứt = không kết nối được')}
          ${chart('lat_probe', 'Độ trễ probe từng service', '')}
          ${chart('ngrok_p', 'ngrok phân vị', 'p50 · p90 · p95 · p99')}
          ${chart('ngrok_req', 'Từng request qua ngrok', 'màu theo mã trạng thái')}
        </div>
      </section>

      <section class="sec"><h2>Tài nguyên theo tiến trình</h2>
        <div class="chartgrid">
          ${chart('proc_cpu', 'CPU từng service', '% của một nhân, có thể vượt 100')}
          ${chart('proc_ram', 'RAM từng service', 'RSS cộng lại ≠ RAM máy: thư viện dùng chung bị tính trùng')}
          ${chart('proc_io', 'Đọc/ghi đĩa', '')}
          ${chart('proc_thread', 'Số luồng', '')}
          ${chart('proc_ctx', 'Bị cướp CPU', 'lần/giây — cao = đang tranh CPU với tiến trình khác')}
          ${chart('proc_fd', 'File đang mở', 'tăng đều mà không giảm = rò fd')}
        </div>
        <div class="chart wide" id="ch-proctable"><h3>Bảng tiến trình</h3>
          <div class="chart__body"></div></div>
      </section>

      <section class="sec"><h2>Tải nghiệp vụ</h2>
        <div class="chartgrid">
          ${chart('req_rpm', 'Request mỗi phút', 'đã loại probe của panel')}
          ${chart('req_svc', 'Request theo service', '')}
          ${chart('host_load', 'Load average', '1 · 5 · 15 phút')}
          ${chart('host_mem', 'RAM toàn máy', '')}
          ${chart('req_err', 'Tỉ lệ lỗi', '4xx = client gọi sai · 5xx = server hỏng')}
          ${chart('top_path', 'Endpoint gọi nhiều nhất', '5 phút gần đây')}
          ${chart('ngrok_conns', 'Kết nối ngrok', 'đang mở · lần/phút')}
          ${chart('uptime', 'Thời gian chạy', 'sụt về 0 = service vừa khởi động lại')}
        </div>
      </section>

      <section class="sec"><h2>Gửi thử</h2>
        <div class="loadbox">
          <div class="loadform">
            <label>Hồ sơ
              <select id="lt-profile">
                <option value="intent">intent — POST /intent (ép 1 luồng)</option>
                <option value="transcribe">transcribe — POST /transcribe</option>
                <option value="assess">assess — POST /api/speech/assess</option>
                <option value="gateway">gateway — qua :8090</option>
              </select>
            </label>
            <label>Số request <input id="lt-n" type="number" value="10" min="1" max="50"></label>
            <label>Đồng thời <input id="lt-c" type="number" value="1" min="1" max="4"></label>
            <button id="lt-go" class="go">▶  Bắn</button>
            <button id="lt-cancel" class="stop" disabled>■  Huỷ</button>
            <span id="lt-status" class="sub"></span>
          </div>
          <div class="chart" id="ch-load"><h3>Thời gian mỗi request</h3>
            <div class="chart__body"></div></div>
          <div id="lt-result" class="sub"></div>
        </div>
      </section>

      <div class="chartfoot">
        <span>Cửa sổ thời gian:</span>
        <button data-w="60" class="cw">1 phút</button>
        <button data-w="300" class="cw on">5 phút</button>
        <button data-w="600" class="cw">10 phút</button>
        <span style="flex:1"></span>
        <button id="ch-pause">⏸  Tạm dừng</button>
        <span id="ch-stat" class="sub"></span>
      </div>`;

    root.querySelectorAll('button.cw').forEach(b => {
      b.onclick = () => {
        root.querySelectorAll('button.cw').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        this.window_s = +b.dataset.w;
        this.tick();
      };
    });
    const pause = root.querySelector('#ch-pause');
    pause.onclick = () => {
      this.paused = !this.paused;
      pause.classList.toggle('on', this.paused);
      pause.textContent = this.paused ? '▶  Chạy tiếp' : '⏸  Tạm dừng';
    };

    LoadTest.bind(this);
    this.svcs = svcs;
  },

  // ── một nhịp cập nhật ──────────────────────────────────────────────
  async tick() {
    if (this.paused) return;
    if (this.abort) this.abort.abort();
    this.abort = new AbortController();
    let d, reqs = [];
    try {
      const buckets = this.window_s <= 60 ? 60 : 120;
      const r = await fetch(`/api/series?window_s=${this.window_s}&buckets=${buckets}`,
        { signal: this.abort.signal });
      d = await r.json();
      const rr = await fetch('/api/requests/recent?n=300', { signal: this.abort.signal });
      reqs = await rr.json();
    } catch { return; }
    this.abort = null;

    // làm mới meta để lấy load_runs và pid mới
    try { this.meta = await (await fetch('/api/series/meta')).json(); } catch {}

    this.render(d, reqs);
  },

  render(d, reqs) {
    const S = d.series || {};
    const g = n => S[n] || null;
    const last = n => { const a = S[n]; if (!a) return null; for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
    const base = { t0: d.t0, bucket_s: d.bucket_s, runs: (this.meta && this.meta.load_runs) || [] };
    const body = id => document.querySelector(`#ch-${id} .chart__body`);
    const svcs = this.svcs || [];
    const alive = svcs.filter(s => (S[`proc.${s}.rss_mb`] || []).some(v => v != null));

    // ── KPI ──
    const gpuTotal = (this.meta && this.meta.gpu_total_mb) || 16380;
    const memTotal = (this.meta && this.meta.mem_total_mb) || 1;
    this.kpi('gpu', fmtNum(last('gpu.0.util'), '%'), g('gpu.0.util'), 'var(--cyan)');
    this.kpi('vram', `${((last('gpu.0.mem_used_mb') || 0) / 1024).toFixed(1)}/${(gpuTotal / 1024).toFixed(1)} GB`,
      g('gpu.0.mem_used_mb'), 'var(--violet)');
    this.kpi('cpu', fmtNum(last('host.cpu_pct'), '%'), g('host.cpu_pct'), 'var(--green)');
    this.kpi('ram', `${((last('host.mem_used_mb') || 0) / 1024).toFixed(1)}/${(memTotal / 1024).toFixed(1)} GB`,
      g('host.mem_used_mb'), 'var(--amber)');
    this.kpi('req', fmtNum(last('req.rpm'), ''), g('req.rpm'), 'var(--cyan)');
    this.kpi('lat', fmtNum(last('probe.intent.latency_ms'), 'ms'), g('probe.intent.latency_ms'), 'var(--red)');

    // ── GPU ──
    lineMulti(body('gpu_time'), {
      ...base, unit: '',
      series: [
        { label: 'mức tải %', data: g('gpu.0.util'), color: 'var(--cyan)' },
        { label: 'bộ nhớ %', data: g('gpu.0.util_mem'), color: 'var(--violet)' },
        { label: 'nhiệt °C', data: g('gpu.0.temp'), color: 'var(--amber)' },
        { label: 'điện W', data: g('gpu.0.power_w'), color: 'var(--green)' },
      ],
    });

    // phân rã VRAM: torch cấp phát vs phần ngoài torch (CUDA context, cuBLAS…)
    const procVram = last('gpuproc.speech.vram_mb') || 0;
    const torchAlloc = (last('svc.speech.torch_alloc_gb') || 0) * 1024;
    const torchRes = (last('svc.speech.torch_reserved_gb') || 0) * 1024;
    const others = svcs.filter(s => s !== 'speech')
      .reduce((a, s) => a + (last(`gpuproc.${s}.vram_mb`) || 0), 0)
      + (last('gpuproc._other.vram_mb') || 0);
    stackedBarH(body('vram_split'), [
      { label: 'torch cấp phát', value: torchAlloc, color: 'var(--cyan)' },
      { label: 'torch giữ chưa dùng', value: Math.max(0, torchRes - torchAlloc), color: '#0e7490' },
      { label: 'CUDA context + cuBLAS', value: Math.max(0, procVram - torchRes), color: 'var(--violet)' },
      { label: 'tiến trình khác', value: others, color: 'var(--amber)' },
    ], { total: gpuTotal, unit: 'MB' });

    stackedArea(body('vram_time'), {
      ...base, unit: 'MB',
      series: alive.filter(s => (S[`gpuproc.${s}.vram_mb`] || []).some(v => v)).map(s => ({
        label: s, data: g(`gpuproc.${s}.vram_mb`),
      })),
    });

    lineMulti(body('gpu_clock'), {
      ...base, unit: '',
      series: [
        { label: 'SM', data: g('gpu.0.clock_sm'), color: 'var(--cyan)' },
        { label: 'bộ nhớ', data: g('gpu.0.clock_mem'), color: 'var(--violet)' },
      ],
    });

    // ── Độ trễ ──
    lineMulti(body('lat_dep'), {
      ...base, unit: 'ms',
      series: [
        { label: 'embed', data: g('svc.intent.embed_latency'), color: 'var(--cyan)' },
        { label: 'chat', data: g('svc.intent.chat_latency'), color: 'var(--violet)' },
        { label: 'asr', data: g('svc.intent.asr_latency'), color: 'var(--green)' },
        { label: 'db', data: g('svc.intent.db_latency'), color: 'var(--amber)' },
      ],
    });

    lineMulti(body('lat_probe'), {
      ...base, unit: 'ms',
      series: alive.map(s => ({ label: s, data: g(`probe.${s}.latency_ms`) })),
    });

    lineMulti(body('ngrok_p'), {
      ...base, unit: 'ms',
      series: [
        { label: 'p50', data: g('ngrok.p50_ms'), color: 'var(--green)' },
        { label: 'p90', data: g('ngrok.p90_ms'), color: 'var(--cyan)' },
        { label: 'p95', data: g('ngrok.p95_ms'), color: 'var(--amber)' },
        { label: 'p99', data: g('ngrok.p99_ms'), color: 'var(--red)' },
      ],
    });

    const tEnd = d.t0 + d.bucket_s * d.n;
    scatterPoints(body('ngrok_req'),
      (reqs || []).filter(r => r.t >= d.t0).map(r => ({
        t: r.t, y: r.dur_ms, status: r.status,
        label: `${r.method} ${r.uri} → ${r.status} · ${r.dur_ms}ms`,
      })),
      { t0: d.t0, t1: tEnd, unit: 'ms' });

    // ── Tiến trình ──
    lineMulti(body('proc_cpu'), {
      ...base, unit: '%',
      series: alive.map(s => ({ label: s, data: g(`proc.${s}.cpu_pct`) })),
    });
    stackedArea(body('proc_ram'), {
      ...base, unit: 'MB',
      series: alive.map(s => ({ label: s, data: g(`proc.${s}.rss_mb`) })),
    });
    lineMulti(body('proc_io'), {
      ...base, unit: 'B',
      series: alive.flatMap(s => [
        { label: s + ' đọc', data: g(`proc.${s}.io_read_bps`) },
        { label: s + ' ghi', data: g(`proc.${s}.io_write_bps`), dash: '3 3' },
      ]),
    });
    lineMulti(body('proc_thread'), {
      ...base, unit: '',
      series: alive.map(s => ({ label: s, data: g(`proc.${s}.threads`) })),
    });

    lineMulti(body('proc_ctx'), {
      ...base, unit: '/s',
      series: alive.map(s => ({ label: s, data: g(`proc.${s}.ctxsw_forced_ps`) })),
    });
    lineMulti(body('proc_fd'), {
      ...base, unit: '',
      series: alive.map(s => ({ label: s, data: g(`proc.${s}.fds`) })),
    });

    this.procTable(S, last, svcs);

    // ── Tải nghiệp vụ ──
    lineMulti(body('req_rpm'), {
      ...base, unit: '',
      series: [
        { label: 'request/phút', data: g('req.rpm'), color: 'var(--cyan)' },
        { label: 'lỗi 5xx', data: g('req.err_rpm'), color: 'var(--red)' },
      ],
    });
    const bySvc = svcs.map(s => [s, Math.round(
      (S[`req.${s}.rpm`] || []).reduce((a, v) => a + (v || 0), 0))]).filter(r => r[1] > 0);
    barsH(body('req_svc'), bySvc.sort((a, b) => b[1] - a[1]), null);

    lineMulti(body('host_load'), {
      ...base, unit: '',
      series: [
        { label: '1 phút', data: g('host.load1'), color: 'var(--cyan)' },
        { label: '5 phút', data: g('host.load5'), color: 'var(--green)' },
        { label: '15 phút', data: g('host.load15'), color: 'var(--fg-dim)' },
      ],
    });
    stackedArea(body('host_mem'), {
      ...base, unit: 'MB',
      series: [
        { label: 'đã dùng', data: g('host.mem_used_mb'), color: 'var(--amber)' },
        { label: 'còn trống', data: g('host.mem_avail_mb'), color: 'var(--line-hot)' },
      ],
    });

    lineMulti(body('req_err'), {
      ...base, unit: '/phút',
      series: [
        { label: '5xx server hỏng', data: g('req.err_rpm'), color: 'var(--red)' },
        { label: '4xx gọi sai', data: g('req.err4xx_rpm'), color: 'var(--amber)' },
      ],
    });
    barsH(body('top_path'), (this.meta && this.meta.top_paths) || [], null);
    lineMulti(body('ngrok_conns'), {
      ...base, unit: '',
      series: [
        { label: 'kết nối đang mở', data: g('ngrok.conns'), color: 'var(--cyan)' },
        { label: 'request/phút', data: g('ngrok.rpm'), color: 'var(--green)' },
      ],
    });
    lineMulti(body('uptime'), {
      ...base, unit: 'phút',
      series: alive.map(s => ({
        label: s,
        data: (g(`proc.${s}.uptime_s`) || []).map(v => v == null ? null : v / 60),
      })),
    });

    LoadTest.render(base);

    const st = document.getElementById('ch-stat');
    if (st && this.meta && this.meta.stats) {
      st.textContent = `${this.meta.stats.series} series · ${this.meta.stats.points} điểm`
        + (this.meta.gpu_error ? ` · GPU: ${this.meta.gpu_error}` : '');
    }
  },

  kpi(id, value, data, color) {
    const el = document.getElementById('kpi-' + id);
    if (!el) return;
    el.querySelector('.kpi__v').textContent = value;
    sparkline(el.querySelector('.kpi__spark'), data || [], { color });
  },

  procTable(S, last, svcs) {
    const rows = svcs.map(s => {
      const rss = last(`proc.${s}.rss_mb`);
      if (rss == null) return null;
      const pid = (this.meta.pid_of || {})[s];
      return `<tr><td>${s}</td><td>${pid || '—'}</td>
        <td>${fmtNum(last(`proc.${s}.cpu_pct`), '%')}</td>
        <td>${fmtNum(rss, 'MB')}</td>
        <td>${fmtNum(last(`gpuproc.${s}.vram_mb`), 'MB')}</td>
        <td>${fmtNum(last(`proc.${s}.threads`), '')}</td>
        <td>${fmtNum(last(`proc.${s}.fds`), '')}</td>
        <td>${fmtBytes(last(`proc.${s}.io_read_bps`))}</td>
        <td>${fmtBytes(last(`proc.${s}.io_write_bps`))}</td></tr>`;
    }).filter(Boolean);
    const el = document.querySelector('#ch-proctable .chart__body');
    if (el) {
      el.innerHTML = `<table class="ptable">
        <thead><tr><th>service</th><th>PID</th><th>CPU</th><th>RAM</th><th>VRAM</th>
        <th>luồng</th><th>fd</th><th>đọc</th><th>ghi</th></tr></thead>
        <tbody>${rows.join('')}</tbody></table>`;
    }
  },
};

// ── Gửi thử ───────────────────────────────────────────────────────────
const LoadTest = {
  poll: null,
  last: null,

  bind(tab) {
    this.tab = tab;
    document.getElementById('lt-go').onclick = () => this.go();
    document.getElementById('lt-cancel').onclick = () => this.cancel();
  },

  async go() {
    const body = {
      profile: document.getElementById('lt-profile').value,
      n: +document.getElementById('lt-n').value,
      concurrency: +document.getElementById('lt-c').value,
    };
    const st = document.getElementById('lt-status');
    try {
      const r = await fetch('/api/loadtest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || 'lỗi');
      st.textContent = j.note ? '⚠ ' + j.note : 'đang chạy…';
      document.getElementById('lt-go').disabled = true;
      document.getElementById('lt-cancel').disabled = false;
      this.watch();
    } catch (e) { st.textContent = 'lỗi: ' + e.message; }
  },

  async cancel() {
    try { await fetch('/api/loadtest/cancel', { method: 'POST' }); } catch {}
  },

  watch() {
    if (this.poll) clearInterval(this.poll);
    this.poll = setInterval(async () => {
      let j;
      try { j = await (await fetch('/api/loadtest/status')).json(); } catch { return; }
      this.last = j;
      const st = document.getElementById('lt-status');
      const note = j.note ? ` · ⚠ ${j.note}` : '';
      st.textContent = (j.running
        ? `đang chạy ${j.done}/${j.total}…`
        : `xong ${j.done}/${j.total} · ok ${j.ok} · lỗi ${j.err}`) + note;
      if (!j.running) {
        clearInterval(this.poll); this.poll = null;
        document.getElementById('lt-go').disabled = false;
        document.getElementById('lt-cancel').disabled = true;
      }
      this.renderResult(j);
    }, 1000);
  },

  renderResult(j) {
    const el = document.getElementById('lt-result');
    if (!el || !j) return;
    el.innerHTML = `p50 <b>${fmtNum(j.p50_ms, 'ms')}</b> ·
      p95 <b>${fmtNum(j.p95_ms, 'ms')}</b> ·
      ok <b>${j.ok}</b> · lỗi <b style="color:var(--red)">${j.err}</b>`
      + (j.p50_server_ms != null
        ? ` · server p50 <b>${fmtNum(j.p50_server_ms, 'ms')}</b>
            (chênh <b>${fmtNum(j.p50_ms - j.p50_server_ms, 'ms')}</b> = upload + xếp hàng)` : '');
  },

  render(base) {
    const el = document.querySelector('#ch-load .chart__body');
    if (!el) return;
    const res = (this.last && this.last.results) || [];
    if (!res.length) { el.innerHTML = '<div class="nodata">bấm Bắn để tạo tải</div>'; return; }
    const t1 = Math.max(...res.map(r => r.t)) + 1;
    const t0 = Math.min(...res.map(r => r.t)) - 1;
    const pts = [];
    res.forEach(r => {
      pts.push({ t: r.t, y: r.wall_ms, status: r.ok ? 200 : 500,
        label: `panel đo: ${r.wall_ms}ms` });
      if (r.server_ms != null) {
        pts.push({ t: r.t, y: r.server_ms, color: 'var(--green)',
          label: `server đo: ${r.server_ms}ms` });
      }
    });
    scatterPoints(el, pts, {
      t0, t1, unit: 'ms',
      legend: [
        { label: 'panel đo (gồm upload)', color: 'var(--cyan)' },
        { label: 'server đo (chỉ tính toán)', color: 'var(--green)' },
      ],
    });
  },
};
