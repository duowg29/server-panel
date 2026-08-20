/* Chart viết tay bằng inline SVG.
   Chọn SVG thay vì canvas: kế thừa được CSS custom property (dùng chung
   design token, không phải nhân đôi bảng màu sang JS), viewBox tự scale nên
   không phải xử lý devicePixelRatio hay redraw khi resize.
   Dữ liệu chỉ 60-120 điểm/series nên chi phí không đáng kể. */

const NS = 'http://www.w3.org/2000/svg';

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Area chart: requests/min. */
function areaChart(el, series, opts = {}) {
  const W = 600, H = 120, pad = { l: 34, r: 6, t: 8, b: 14 };
  const data = series && series.length ? series : [0];
  const max = Math.max(1, ...data, opts.min || 0);
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const n = data.length;
  const x = i => pad.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = v => pad.t + ih - (v / max) * ih;

  let line = '';
  data.forEach((v, i) => { line += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' '; });
  const area = line + `L${x(n - 1).toFixed(1)} ${(pad.t + ih)} L${x(0).toFixed(1)} ${(pad.t + ih)} Z`;

  // lưới ngang + nhãn trục
  let grid = '';
  for (let g = 0; g <= 2; g++) {
    const v = (max / 2) * g, yy = y(v);
    grid += `<line x1="${pad.l}" y1="${yy.toFixed(1)}" x2="${W - pad.r}" y2="${yy.toFixed(1)}"
      stroke="var(--line)" stroke-dasharray="2 4" stroke-width="1"/>`;
    grid += `<text x="${pad.l - 4}" y="${(yy + 3).toFixed(1)}" text-anchor="end"
      fill="var(--fg-dim)" font-size="9">${Math.round(v)}</text>`;
  }

  // lớp lỗi (5xx) vẽ đè
  let errPath = '';
  if (opts.errors && opts.errors.some(v => v > 0)) {
    opts.errors.forEach((v, i) => {
      errPath += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' ';
    });
    errPath = `<path d="${errPath}" fill="none" stroke="var(--red)" stroke-width="1.2"/>`;
  }

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img"
      aria-label="requests per minute">
    ${grid}
    <path d="${area}" fill="url(#areaFill)"/>
    <path d="${line}" fill="none" stroke="var(--cyan)" stroke-width="1.4" filter="url(#glow)"/>
    ${errPath}
  </svg>`;
}

/** Bar chart ngang: req by service. Màu thanh = màu trạng thái service. */
function barsH(el, rows, stateOf) {
  if (!rows || !rows.length) {
    el.innerHTML = '<div class="sub">chưa có request nào trong cửa sổ</div>';
    return;
  }
  const max = Math.max(...rows.map(r => r[1]), 1);
  const colorFor = st => ({
    ONLINE: 'var(--green)', DEGRADED: 'var(--amber)', STARTING: 'var(--amber)',
    OFFLINE: 'var(--red)', NO_ENV: 'var(--fg-dim)'
  }[st] || 'var(--cyan)');

  const rowH = 15, W = 600, labelW = 108, numW = 40;
  const H = rows.length * rowH + 2;
  let out = '';
  rows.forEach((r, i) => {
    const [id, n] = r;
    const w = ((n / max) * (W - labelW - numW)).toFixed(1);
    const yy = i * rowH + 2;
    out += `<text x="0" y="${yy + 9}" fill="var(--fg-dim)" font-size="10">${esc(id)}</text>`;
    out += `<rect x="${labelW}" y="${yy + 1}" width="${w}" height="9" rx="1"
      fill="${colorFor(stateOf ? stateOf(id) : null)}" opacity=".8"/>`;
    out += `<text x="${W - 2}" y="${yy + 9}" text-anchor="end" fill="var(--fg)"
      font-size="10">${n}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="requests by service">${out}</svg>`;
}

/** VRAM: thanh khối phân đoạn — hợp tông terminal hơn đồng hồ tròn. */
function vramBlocks(el, gpus, gpuError) {
  if (gpuError) {
    el.innerHTML = `<div class="sub" style="color:var(--amber)">NO_GPU_DATA — ${esc(gpuError)}</div>`;
    return;
  }
  if (!gpus || !gpus.length) {
    el.innerHTML = '<div class="sub">đang lấy mẫu…</div>';
    return;
  }
  const N = 24;
  let out = '';
  gpus.forEach(g => {
    const frac = g.total_mb ? g.used_mb / g.total_mb : 0;
    const on = Math.round(frac * N);
    let blocks = '';
    for (let i = 0; i < N; i++) {
      const cls = i < on ? (frac > 0.85 ? 'on hot' : 'on') : '';
      blocks += `<i class="${cls}"></i>`;
    }
    const gb = v => (v / 1024).toFixed(1);
    out += `<div class="vram-row">
        <span class="lbl">VRAM ${Math.round(frac * 100)}%</span>
        <span class="blocks">${blocks}</span>
      </div>
      <div class="sub">${esc(g.name)} · ${gb(g.used_mb)}/${gb(g.total_mb)} GB đã dùng`
      + ` · mức tải GPU ${g.util_pct}%</div>`;
  });
  el.innerHTML = out;
}

/* ══════════════════════════════════════════════════════════════════════
   Hạ tầng dùng chung cho tab biểu đồ.

   Ba nguyên tắc:
   - `null` là KHOẢNG TRỐNG: đường phải ĐỨT, tuyệt đối không nối thẳng qua.
     Nối qua là bịa ra dữ liệu không tồn tại.
   - Màu chỉ dùng var(--…) để đồng bộ với design token, không hardcode hex.
   - Tooltip là MỘT div ngoài SVG dùng chung — vẽ lại innerHTML mỗi 2s mà
     tooltip nằm trong SVG thì sẽ mất hover liên tục.
   ══════════════════════════════════════════════════════════════════════ */

const SERIES_COLORS = [
  'var(--cyan)', 'var(--green)', 'var(--amber)', 'var(--violet)',
  'var(--red)', '#60a5fa', '#f472b6', '#a3e635',
];

function fmtNum(v, unit) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  let s;
  if (a >= 1e9) s = (v / 1e9).toFixed(1) + 'G';
  else if (a >= 1e6) s = (v / 1e6).toFixed(1) + 'M';
  else if (a >= 1e4) s = (v / 1e3).toFixed(1) + 'k';
  else if (a >= 100) s = v.toFixed(0);
  else if (a >= 10) s = v.toFixed(1);
  else if (a >= 1) s = v.toFixed(2);
  else s = v.toFixed(a === 0 ? 0 : 2);
  return unit ? s + unit : s;
}

function fmtBytes(v) {
  if (v == null) return '—';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i ? 1 : 0) + u[i] + '/s';
}

/** Khung vẽ chung: trả kích thước vùng dữ liệu bên trong padding. */
function _frame(opts = {}) {
  const W = opts.W || 640;
  const H = opts.H || 170;
  const p = { l: opts.padL ?? 46, r: opts.padR ?? 10, t: opts.padT ?? 12, b: opts.padB ?? 20 };
  return { W, H, p, iw: W - p.l - p.r, ih: H - p.t - p.b };
}

/** Path từ mảng có thể chứa null. null → bắt đầu sub-path mới (đường ĐỨT). */
function _linePath(data, x, y) {
  let d = '';
  let pen = false;
  data.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' ';
    pen = true;
  });
  return d;
}

/** Điểm lẻ loi (hàng xóm hai bên đều null) — không vẽ thì mất hẳn. */
function _lonePoints(data, x, y) {
  let out = '';
  data.forEach((v, i) => {
    if (v == null) return;
    const prev = i > 0 ? data[i - 1] : null;
    const next = i < data.length - 1 ? data[i + 1] : null;
    if (prev == null && next == null) {
      out += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.8"/>`;
    }
  });
  return out;
}

function _niceMax(v) {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

function _grid(f, yMax, unit, rows = 4) {
  let g = '';
  for (let i = 0; i <= rows; i++) {
    const val = (yMax / rows) * i;
    const yy = f.p.t + f.ih - (i / rows) * f.ih;
    g += `<line x1="${f.p.l}" y1="${yy.toFixed(1)}" x2="${f.W - f.p.r}" y2="${yy.toFixed(1)}"
      stroke="var(--line)" stroke-width="1" ${i ? 'stroke-dasharray="2 5"' : ''}/>`;
    g += `<text x="${f.p.l - 6}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end"
      fill="var(--fg-dim)" font-size="10">${fmtNum(val, unit)}</text>`;
  }
  return g;
}

function _timeAxis(f, t0, bucket_s, n) {
  let g = '';
  const now = t0 + bucket_s * (n - 1);
  for (let i = 0; i <= 4; i++) {
    const idx = Math.round((n - 1) * i / 4);
    const xx = f.p.l + (idx / (n - 1)) * f.iw;
    const ago = Math.round((now - (t0 + idx * bucket_s)));
    const lbl = ago <= 2 ? 'bây giờ' : ago >= 60 ? `-${Math.round(ago / 60)}p` : `-${ago}s`;
    g += `<text x="${xx.toFixed(1)}" y="${f.H - 5}" text-anchor="middle"
      fill="var(--fg-dim)" font-size="10">${lbl}</text>`;
  }
  return g;
}

/** Vạch dọc mờ đánh dấu khoảng bắn tải — vẽ trên MỌI chart để đối chiếu. */
function _refBands(f, t0, bucket_s, n, runs) {
  if (!runs || !runs.length) return '';
  const tEnd = t0 + bucket_s * n;
  let g = '';
  for (const r of runs) {
    if (r.t1 < t0 || r.t0 > tEnd) continue;
    const x1 = f.p.l + Math.max(0, (r.t0 - t0) / (bucket_s * n)) * f.iw;
    const x2 = f.p.l + Math.min(1, (r.t1 - t0) / (bucket_s * n)) * f.iw;
    g += `<rect x="${x1.toFixed(1)}" y="${f.p.t}" width="${Math.max(2, x2 - x1).toFixed(1)}"
      height="${f.ih}" fill="var(--violet)" opacity=".14"/>`;
  }
  return g;
}

// ── Tooltip dùng chung, nằm NGOÀI svg ────────────────────────────────
let _tip = null;
function _tipEl() {
  if (!_tip) {
    _tip = document.createElement('div');
    _tip.className = 'charttip';
    _tip.hidden = true;
    document.body.appendChild(_tip);
  }
  return _tip;
}

function _attachHover(el, cfg) {
  // gắn một lần cho mỗi container; render lại innerHTML không làm mất listener
  if (el._hoverBound) { el._hoverCfg = cfg; return; }
  el._hoverBound = true;
  el._hoverCfg = cfg;
  const tip = _tipEl();
  el.addEventListener('mousemove', ev => {
    const c = el._hoverCfg;
    if (!c || !c.n) return;
    const r = el.getBoundingClientRect();
    const frac = (ev.clientX - r.left) / r.width;
    const f = c.f;
    const inner = (frac * f.W - f.p.l) / f.iw;
    if (inner < 0 || inner > 1) { tip.hidden = true; return; }
    const idx = Math.min(c.n - 1, Math.max(0, Math.round(inner * (c.n - 1))));
    const html = c.render(idx);
    if (!html) { tip.hidden = true; return; }
    tip.innerHTML = html;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(window.innerWidth - tw - 8, Math.max(8, ev.clientX + 14)) + 'px';
    tip.style.top = (ev.clientY + 14) + 'px';
  });
  el.addEventListener('mouseleave', () => { tip.hidden = true; });
}

/** Nhiều đường trên một trục — xương sống của tab biểu đồ. */
function lineMulti(el, opts) {
  const { t0, bucket_s, series = [], unit = '', runs = null, yMax: forceMax } = opts;
  const n = series.reduce((m, s) => Math.max(m, (s.data || []).length), 0);
  if (!n) { el.innerHTML = '<div class="nodata">chưa có dữ liệu</div>'; return; }

  const f = _frame({ H: opts.H || 175 });
  let peak = 0;
  series.forEach(s => (s.data || []).forEach(v => { if (v != null && v > peak) peak = v; }));
  const yMax = forceMax || _niceMax(peak * 1.15) || 1;

  const x = i => f.p.l + (n === 1 ? f.iw / 2 : (i / (n - 1)) * f.iw);
  const y = v => f.p.t + f.ih - Math.min(1, v / yMax) * f.ih;

  let body = '';
  series.forEach((s, k) => {
    const color = s.color || SERIES_COLORS[k % SERIES_COLORS.length];
    const d = _linePath(s.data || [], x, y);
    if (d) {
      body += `<path d="${d}" fill="none" stroke="${color}" stroke-width="${s.width || 1.6}"
        stroke-linejoin="round" stroke-linecap="round"
        ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/>`;
    }
    const lone = _lonePoints(s.data || [], x, y);
    if (lone) body += `<g fill="${color}">${lone}</g>`;
  });

  el.innerHTML = `<svg viewBox="0 0 ${f.W} ${f.H}" preserveAspectRatio="xMidYMid meet">
    ${_refBands(f, t0, bucket_s, n, runs)}
    ${_grid(f, yMax, unit)}
    ${_timeAxis(f, t0, bucket_s, n)}
    ${body}
  </svg>` + _legend(series);

  _attachHover(el, {
    n, f,
    render: idx => {
      const rows = series
        .map((s, k) => ({ s, k, v: (s.data || [])[idx] }))
        .filter(r => r.v != null);
      if (!rows.length) return '<b>không có dữ liệu</b>';
      const ago = Math.round(t0 + bucket_s * (n - 1) - (t0 + idx * bucket_s));
      return `<div class="t">${ago <= 2 ? 'bây giờ' : '-' + ago + 's'}</div>` + rows.map(r =>
        `<div><i style="background:${r.s.color || SERIES_COLORS[r.k % SERIES_COLORS.length]}"></i>
         ${r.s.label}<b>${fmtNum(r.v, unit)}</b></div>`).join('');
    },
  });
}

function _legend(series) {
  if (!series.length) return '';
  return '<div class="legend">' + series.map((s, k) =>
    `<span><i style="background:${s.color || SERIES_COLORS[k % SERIES_COLORS.length]}"></i>${s.label}</span>`
  ).join('') + '</div>';
}

/** Vùng chồng — trả lời "ai chiếm bao nhiêu trong tổng". */
function stackedArea(el, opts) {
  const { t0, bucket_s, series = [], unit = '', runs = null } = opts;
  const n = series.reduce((m, s) => Math.max(m, (s.data || []).length), 0);
  if (!n) { el.innerHTML = '<div class="nodata">chưa có dữ liệu</div>'; return; }

  const f = _frame({ H: opts.H || 175 });
  // cộng dồn, null coi là 0 CHO RIÊNG phép cộng (nhưng vẫn nhớ để tooltip báo đúng)
  const cum = series.map(() => new Array(n).fill(0));
  let peak = 0;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    series.forEach((s, k) => {
      const v = (s.data || [])[i];
      acc += (v == null ? 0 : v);
      cum[k][i] = acc;
    });
    if (acc > peak) peak = acc;
  }
  const yMax = _niceMax(peak * 1.1) || 1;
  const x = i => f.p.l + (n === 1 ? f.iw / 2 : (i / (n - 1)) * f.iw);
  const y = v => f.p.t + f.ih - Math.min(1, v / yMax) * f.ih;

  let body = '';
  for (let k = series.length - 1; k >= 0; k--) {
    const color = series[k].color || SERIES_COLORS[k % SERIES_COLORS.length];
    let d = `M${x(0).toFixed(1)} ${y(cum[k][0]).toFixed(1)} `;
    for (let i = 1; i < n; i++) d += `L${x(i).toFixed(1)} ${y(cum[k][i]).toFixed(1)} `;
    d += `L${x(n - 1).toFixed(1)} ${(f.p.t + f.ih)} L${x(0).toFixed(1)} ${(f.p.t + f.ih)} Z`;
    body += `<path d="${d}" fill="${color}" opacity=".55"/>`;
    body += `<path d="${d}" fill="none" stroke="${color}" stroke-width="1"/>`;
  }

  el.innerHTML = `<svg viewBox="0 0 ${f.W} ${f.H}" preserveAspectRatio="xMidYMid meet">
    ${_refBands(f, t0, bucket_s, n, runs)}
    ${_grid(f, yMax, unit)}
    ${_timeAxis(f, t0, bucket_s, n)}
    ${body}
  </svg>` + _legend(series);

  _attachHover(el, {
    n, f,
    render: idx => {
      const rows = series.map((s, k) => ({ s, k, v: (s.data || [])[idx] })).filter(r => r.v != null);
      if (!rows.length) return '<b>không có dữ liệu</b>';
      const tot = rows.reduce((a, r) => a + r.v, 0);
      return rows.map(r =>
        `<div><i style="background:${r.s.color || SERIES_COLORS[r.k % SERIES_COLORS.length]}"></i>
         ${r.s.label}<b>${fmtNum(r.v, unit)}</b></div>`).join('')
        + `<div class="tot">tổng<b>${fmtNum(tot, unit)}</b></div>`;
    },
  });
}

/** Thanh ngang phân đoạn — phân rã một tổng tại một thời điểm. */
function stackedBarH(el, segs, opts = {}) {
  const total = opts.total || segs.reduce((a, s) => a + Math.max(0, s.value || 0), 0) || 1;
  const unit = opts.unit || '';
  let bar = '';
  let acc = 0;
  segs.forEach((s, k) => {
    const v = Math.max(0, s.value || 0);
    if (v <= 0) return;
    const w = (v / total) * 100;
    bar += `<span class="seg" style="width:${w}%;background:${s.color || SERIES_COLORS[k % SERIES_COLORS.length]}"
      title="${s.label}: ${fmtNum(v, unit)}"></span>`;
    acc += v;
  });
  const rest = Math.max(0, total - acc);
  if (rest > 0) bar += `<span class="seg rest" style="width:${(rest / total) * 100}%"></span>`;

  el.innerHTML = `<div class="hbar">${bar}</div>
    <div class="hbar__legend">` + segs.map((s, k) =>
      `<span><i style="background:${s.color || SERIES_COLORS[k % SERIES_COLORS.length]}"></i>
       ${s.label}<b>${fmtNum(s.value, unit)}</b></span>`).join('')
    + (rest > 0 ? `<span><i class="rest"></i>còn trống<b>${fmtNum(rest, unit)}</b></span>` : '')
    + `</div>`;
}

/** Điểm rời rạc — dữ liệu KHÔNG đều theo thời gian.
    Gộp thành đường sẽ giấu mất outlier, mà outlier chính là thứ cần tìm. */
function scatterPoints(el, points, opts = {}) {
  const { t0, t1 } = opts;
  if (!points || !points.length) { el.innerHTML = '<div class="nodata">chưa có request nào</div>'; return; }
  const f = _frame({ H: opts.H || 175 });
  const span = Math.max(1, t1 - t0);
  const peak = points.reduce((m, p) => Math.max(m, p.y || 0), 0);
  const yMax = opts.yMax || _niceMax(peak * 1.15) || 1;

  const colorOf = p => p.color
    || (p.status >= 500 ? 'var(--red)'
      : p.status >= 400 ? 'var(--amber)' : 'var(--cyan)');

  let body = '';
  points.forEach(p => {
    const xx = f.p.l + Math.min(1, Math.max(0, (p.t - t0) / span)) * f.iw;
    const yy = f.p.t + f.ih - Math.min(1, (p.y || 0) / yMax) * f.ih;
    body += `<circle cx="${xx.toFixed(1)}" cy="${yy.toFixed(1)}" r="${opts.r || 3}"
      fill="${colorOf(p)}" opacity=".8"><title>${(p.label || '').replace(/"/g, '')}</title></circle>`;
  });

  el.innerHTML = `<svg viewBox="0 0 ${f.W} ${f.H}" preserveAspectRatio="xMidYMid meet">
    ${_grid(f, yMax, opts.unit || 'ms')}
    ${_timeAxis(f, t0, span / 60, 60)}
    ${body}
  </svg>` + (opts.legend ? _legend(opts.legend) : '');
}

/** Đường nhỏ trong ô KPI — không trục, không nhãn. */
function sparkline(el, data, opts = {}) {
  const vals = (data || []).filter(v => v != null);
  if (!vals.length) { el.innerHTML = ''; return; }
  const W = 120, H = 30;
  const max = opts.max || Math.max(...vals) || 1;
  const min = opts.min != null ? opts.min : 0;
  const span = (max - min) || 1;
  const n = data.length;
  const x = i => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const y = v => H - 2 - ((v - min) / span) * (H - 4);
  const d = _linePath(data, x, y);
  const color = opts.color || 'var(--cyan)';
  const fill = d ? d + `L${x(n - 1).toFixed(1)} ${H} L${x(0).toFixed(1)} ${H} Z` : '';
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="spark">
    ${fill ? `<path d="${fill}" fill="${color}" opacity=".16"/>` : ''}
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"
      stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}
