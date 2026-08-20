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

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
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
    out += `<div class="vram-row">
        <span class="lbl">GPU${g.index} ${Math.round(frac * 100)}%</span>
        <span class="blocks">${blocks}</span>
      </div>
      <div class="sub">${esc(g.name)} · ${g.used_mb}/${g.total_mb} MiB · util ${g.util_pct}%</div>`;
  });
  el.innerHTML = out;
}
