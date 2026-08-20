/* Server Panel — frontend.
   Không framework, không build step. Trạng thái đến từ /ws/status (server đẩy,
   client không poll). Log đến từ /ws/logs/<id>, một socket mỗi pane. */

const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

const State = {
  cfg: null,
  status: {},
  metrics: null,
  jobs: [],
  publicUrl: null,
  busy: new Set(),
  window_s: 60,
};

// ── HTTP ────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { detail: text }; }
  if (!r.ok) throw new Error(body.detail || body.error || `HTTP ${r.status}`);
  return body;
}

function toast(msg, kind = '') {
  const t = el('div', 'toast ' + kind, msg);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 9000 : 4500);
}

// ── Modal ───────────────────────────────────────────────────────────
function modal({ title, bodyHTML, okLabel = 'OK', onOk, onClose, wide }) {
  const bg = el('div', 'modal-bg');
  const m = el('div', 'modal');
  if (wide) m.style.maxWidth = '60rem';
  m.innerHTML = `<h3>${title}</h3><div class="body">${bodyHTML}</div>
    <div class="foot"><button class="cancel">Huỷ</button>
    <button class="ok go">${okLabel}</button></div>`;
  bg.appendChild(m);
  document.body.appendChild(bg);
  let done = false;
  const close = () => {
    bg.remove();
    if (!done) { done = true; if (onClose) onClose(); }
  };
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  m.querySelector('.cancel').onclick = close;
  m.querySelector('.ok').onclick = async () => {
    try {
      const keep = onOk ? await onOk(m) : false;
      done = true;
      if (!keep) close();
    } catch (e) {
      let err = m.querySelector('.err');
      if (!err) { err = el('div', 'err'); m.querySelector('.body').appendChild(err); }
      err.textContent = e.message;
    }
  };
  if (!onOk) { m.querySelector('.cancel').remove(); m.querySelector('.ok').textContent = 'Đóng'; }
  return m;
}

function confirmModal(text) {
  return new Promise(res => {
    modal({
      title: 'Xác nhận', bodyHTML: `<div>${text}</div>`, okLabel: 'Chạy',
      onOk: () => { res(true); return false; },
      onClose: () => res(false),   // huỷ / Esc / click nền — không để promise treo
    });
  });
}

// ── Render card ─────────────────────────────────────────────────────
function stateOf(id) { return (State.status[id] || {}).state || 'UNKNOWN'; }

function renderGroups() {
  const wrap = $('#groups');
  wrap.innerHTML = '';
  if (!State.cfg) return;

  for (const g of State.cfg.groups) {
    const svcs = State.cfg.services.filter(s => s.group === g.id);
    if (!svcs.length) continue;
    const sec = el('section', 'sec');
    const h = el('h2', null, g.label);
    h.appendChild(el('span', 'close-bracket'));
    sec.appendChild(h);
    const grid = el('div', 'cards');
    svcs.forEach(s => grid.appendChild(renderCard(s)));
    sec.appendChild(grid);
    wrap.appendChild(sec);
  }
}

function renderCard(svc) {
  const st = State.status[svc.id] || {};
  const state = st.state || 'UNKNOWN';
  const card = el('div', 'card' + (svc.emphasis === 'primary' ? ' primary' : '') +
    (State.busy.has(svc.id) ? ' busy' : ''));
  card.dataset.id = svc.id;

  const head = el('div', 'card__head');
  head.appendChild(el('span', 'card__name', svc.name));
  const badge = el('span', 'card__badge st-' + state, '● ' + state +
    (st.external ? ' EXT' : ''));
  head.appendChild(badge);
  card.appendChild(head);

  // meta: port / detail / pid / uptime
  const meta = el('div', 'card__meta');
  if (svc.port) meta.appendChild(el('span', 'k', ':' + svc.port));
  (st.detail || []).forEach(d => meta.appendChild(el('span', null, d)));
  if (st.pid) meta.appendChild(el('span', null, 'pid ' + st.pid));
  if (st.uptime_s != null) meta.appendChild(el('span', null, 'up ' + fmtDur(st.uptime_s)));
  if (st.latency_ms != null && state !== 'OFFLINE') {
    meta.appendChild(el('span', null, st.latency_ms + 'ms'));
  }
  card.appendChild(meta);

  if (state === 'NO_ENV' && (st.missing || []).length) {
    const w = el('div', 'card__warn', '⚠ thiếu: ' + st.missing.join(', '));
    w.title = st.missing.join('\n');
    card.appendChild(w);
  } else if (st.error && state === 'OFFLINE') {
    card.appendChild(el('div', 'card__note', st.error));
  } else if (svc.note) {
    card.appendChild(el('div', 'card__note', svc.note));
  }

  if (st.public_url) {
    const a = el('a', null, st.public_url);
    a.href = st.public_url; a.target = '_blank'; a.rel = 'noreferrer';
    const line = el('div', 'card__meta'); line.appendChild(a);
    card.appendChild(line);
  }

  // hàng nút chính
  const btns = el('div', 'btns');
  const running = ['ONLINE', 'DEGRADED', 'STARTING'].includes(state);

  const unmet = (svc.depends_on || []).filter(d => stateOf(d) !== 'ONLINE');
  const conflicts = (svc.conflicts_with || [])
    .filter(c => ['ONLINE', 'DEGRADED', 'STARTING'].includes(stateOf(c)));

  if (svc.can_start) {
    const b = el('button', 'go', 'Start');
    b.disabled = State.busy.has(svc.id) || unmet.length > 0 || conflicts.length > 0 ||
      state === 'NO_ENV';
    if (unmet.length) b.title = 'Cần ONLINE trước: ' + unmet.join(', ');
    else if (conflicts.length) b.title = 'Đang chạy stack xung đột: ' + conflicts.join(', ');
    else if (state === 'NO_ENV') b.title = 'Thiếu môi trường: ' + (st.missing || []).join(', ');
    b.onclick = () => doStart(svc);
    btns.appendChild(b);
  }
  if (svc.can_stop) {
    const b = el('button', 'stop', 'Stop');
    b.disabled = State.busy.has(svc.id) || (!running && !st.pid);
    b.onclick = () => act(svc.id, 'stop');
    btns.appendChild(b);
  }
  if (svc.can_start && svc.can_stop) {
    const b = el('button', null, 'Restart');
    b.disabled = State.busy.has(svc.id) || state === 'NO_ENV';
    b.onclick = () => act(svc.id, 'restart');
    btns.appendChild(b);
  }
  if (svc.log || svc.start_mode === 'script') {
    const b = el('button', Logs.has(svc.id) ? 'on' : null, 'Logs');
    b.onclick = () => Logs.toggle(svc.id, svc.name);
    btns.appendChild(b);
    const p = el('button', null, 'Pop ⇱');
    p.onclick = () => window.open('/popout?log=' + encodeURIComponent(svc.id),
      'log_' + svc.id, 'width=960,height=640');
    btns.appendChild(p);
  }
  card.appendChild(btns);

  // hàng nút phụ: action + sửa config
  const extra = el('div', 'btns');
  (svc.actions || []).forEach(a => {
    const b = el('button', null, a.label);
    b.onclick = () => runAction(svc, a);
    extra.appendChild(b);
  });
  if (!State.cfg.readonly) {
    const add = el('button', null, '+ Lệnh'); add.onclick = () => addActionModal(svc);
    const ed = el('button', null, 'Sửa'); ed.onclick = () => editModal(svc);
    const rm = el('button', null, 'Xóa'); rm.onclick = () => deleteService(svc);
    extra.append(add, ed, rm);
  }
  if (svc.log) {
    const tr = el('button', null, 'Xoá log');
    tr.title = 'Truncate ' + svc.log;
    tr.onclick = async () => {
      if (!await confirmModal('Xoá sạch nội dung <b>' + svc.log + '</b>?')) return;
      await api(`/api/services/${svc.id}/truncate-log`, { method: 'POST' })
        .then(() => toast('đã xoá log', 'ok')).catch(e => toast(e.message, 'err'));
    };
    extra.appendChild(tr);
  }
  if (extra.children.length) card.appendChild(extra);

  return card;
}

function fmtDur(s) {
  s = Math.floor(s);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  return Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm';
}

// ── Hành động ───────────────────────────────────────────────────────
async function doStart(svc) {
  if (svc.warn_on_start && !(await confirmModal(svc.warn_on_start + '<br><br>Vẫn chạy?'))) return;
  await act(svc.id, 'start');
}

async function act(id, what) {
  State.busy.add(id);
  renderGroups();
  try {
    const res = await api(`/api/services/${id}/${what}`, { method: 'POST' });
    if (res.job_id) {
      toast(`${what} ${id}: đang chạy script…`, 'ok');
      Logs.open(res.job_id, id + ' · ' + what, true);
    } else if (res.already_running) {
      toast(`${id} đã chạy sẵn (pid ${res.pid})`);
    } else {
      toast(`${what} ${id} ok`, 'ok');
    }
  } catch (e) {
    toast(`${what} ${id}: ${e.message}`, 'err');
  } finally {
    State.busy.delete(id);
    renderGroups();
  }
}

async function runAction(svc, a) {
  if (a.type === 'url') { window.open(a.url, '_blank', 'noreferrer'); return; }
  if (a.confirm && !(await confirmModal(a.confirm))) return;
  try {
    const res = await api(`/api/services/${svc.id}/actions/${a.id}`, { method: 'POST' });
    if (a.show_output === 'modal' && res.job_id) {
      showJobOutput(res.job_id, a.label);
    } else if (res.job_id) {
      Logs.open(res.job_id, a.label, true);
    }
    toast(a.label + ': đang chạy', 'ok');
  } catch (e) {
    toast(a.label + ': ' + e.message, 'err');
  }
}

function showJobOutput(jobId, title) {
  const m = modal({ title, bodyHTML: '<pre id="jobout">đang chạy…</pre>' });
  const pre = m.querySelector('#jobout');
  const ws = new WebSocket(`ws://${location.host}/ws/logs/${encodeURIComponent(jobId)}`);
  let text = '';
  ws.onmessage = ev => {
    const d = JSON.parse(ev.data);
    if (d.type === 'line') { text += d.text + '\n'; pre.textContent = text; pre.scrollTop = 1e9; }
  };
  const obs = new MutationObserver(() => {
    if (!document.body.contains(pre)) { ws.close(); obs.disconnect(); }
  });
  obs.observe(document.body, { childList: true });
}

// ── Sửa config ──────────────────────────────────────────────────────
function addActionModal(svc) {
  modal({
    title: '+ Lệnh cho ' + svc.name,
    bodyHTML: `
      <label>ID (không dấu, không khoảng trắng)</label><input id="a-id" placeholder="my_cmd">
      <label>Nhãn nút</label><input id="a-label" placeholder="Chạy test">
      <label>Loại</label>
      <select id="a-type"><option value="shell">shell (lệnh bash)</option>
        <option value="script">script (file .sh)</option><option value="url">url</option></select>
      <label>Nội dung (lệnh / đường dẫn script / URL)</label><input id="a-cmd">
      <label>Thư mục chạy (bỏ trống = root)</label><input id="a-cwd">
      <label>Câu xác nhận (bỏ trống = không hỏi)</label><input id="a-confirm">`,
    okLabel: 'Lưu',
    onOk: async m => {
      const type = m.querySelector('#a-type').value;
      const cmd = m.querySelector('#a-cmd').value.trim();
      const body = {
        id: m.querySelector('#a-id').value.trim(),
        label: m.querySelector('#a-label').value.trim(),
        type,
        show_output: type === 'url' ? undefined : 'modal',
      };
      if (type === 'url') body.url = cmd;
      else if (type === 'script') body.script = cmd;
      else body.shell = cmd;
      const cwd = m.querySelector('#a-cwd').value.trim();
      if (cwd) body.cwd = cwd;
      const cf = m.querySelector('#a-confirm').value.trim();
      if (cf) body.confirm = cf;
      Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);
      await api(`/api/config/services/${svc.id}/actions`, {
        method: 'POST', body: JSON.stringify(body),
      });
      await loadConfig();
      toast('đã thêm lệnh — ghi vào services.yaml', 'ok');
    },
  });
}

async function editModal(svc) {
  const raw = await api('/api/config/services/' + svc.id + '/yaml').catch(() => null);
  const text = raw ? raw.yaml : `id: ${svc.id}\n# không tải được node gốc`;
  modal({
    wide: true,
    title: 'Sửa ' + svc.id,
    bodyHTML: `<div class="sub" style="color:var(--fg-dim);font-size:10px">
        Sửa trực tiếp node YAML. Giữ nguyên <b>id</b>. Sai schema sẽ tự rollback.</div>
      <textarea id="y">${text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</textarea>`,
    okLabel: 'Lưu + reload',
    onOk: async m => {
      await api('/api/config/services/' + svc.id, {
        method: 'PUT', body: JSON.stringify({ yaml: m.querySelector('#y').value }),
      });
      await loadConfig();
      toast('đã lưu services.yaml', 'ok');
    },
  });
}

async function deleteService(svc) {
  if (!await confirmModal(`Xoá <b>${svc.name}</b> khỏi services.yaml?<br>
    (chỉ xoá khai báo, không đụng tới server đang chạy)`)) return;
  try {
    await api('/api/config/services/' + svc.id, { method: 'DELETE' });
    await loadConfig();
    toast('đã xoá khai báo', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

// ── Log pane ────────────────────────────────────────────────────────
const Logs = {
  panes: new Map(),
  MAX: 4,

  has(id) { return this.panes.has(id); },

  toggle(id, title) { this.has(id) ? this.close(id) : this.open(id, title); },

  open(id, title, autoscrollJob) {
    if (this.panes.has(id)) return;
    if (this.panes.size >= this.MAX) {
      const first = this.panes.keys().next().value;
      this.panes.get(first).root.classList.add('collapsed');
    }
    $('#logempty').style.display = 'none';

    const root = el('div', 'logpane');
    const head = el('div', 'logpane__head');
    const t = el('span', 'logpane__title', (title || id) + '.log');
    t.onclick = () => root.classList.toggle('collapsed');
    head.appendChild(t);
    head.appendChild(el('span', 'grow'));

    const bPause = el('button', null, '⏸');
    bPause.title = 'Tạm dừng';
    const bGrep = el('button', null, '⌕');
    bGrep.title = 'Lọc';
    const bFollow = el('button', 'on', '⤓');
    bFollow.title = 'Bám đáy';
    const bPop = el('button', null, '⇱');
    bPop.title = 'Mở cửa sổ riêng';
    const bClose = el('button', null, '✕');
    head.append(bPause, bGrep, bFollow, bPop, bClose);
    root.appendChild(head);

    const tools = el('div', 'logpane__tools');
    const inp = el('input');
    inp.placeholder = 'regex lọc dòng…';
    tools.appendChild(inp);
    root.appendChild(tools);

    const body = el('div', 'logpane__body');
    root.appendChild(body);
    $('#logstack').appendChild(root);

    const pane = {
      root, body, id, buffer: [], follow: true, paused: false, grep: null,
      pending: [], raf: 0, unseen: 0, ws: null, chip: null,
    };
    this.panes.set(id, pane);

    bClose.onclick = () => this.close(id);
    bPop.onclick = () => window.open('/popout?log=' + encodeURIComponent(id),
      'log_' + id, 'width=960,height=640');
    bPause.onclick = () => {
      pane.paused = !pane.paused;
      bPause.classList.toggle('on', pane.paused);
      bPause.textContent = pane.paused ? '▶' : '⏸';
    };
    bFollow.onclick = () => {
      pane.follow = !pane.follow;
      bFollow.classList.toggle('on', pane.follow);
      if (pane.follow) this._toBottom(pane);
    };
    bGrep.onclick = () => {
      tools.classList.toggle('show');
      if (tools.classList.contains('show')) inp.focus();
      else { inp.value = ''; pane.grep = null; this._redraw(pane); }
    };
    inp.oninput = () => {
      try { pane.grep = inp.value ? new RegExp(inp.value, 'i') : null; inp.style.borderColor = ''; }
      catch { inp.style.borderColor = 'var(--red)'; return; }
      this._redraw(pane);
    };
    body.onscroll = () => {
      const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      if (!atEnd && pane.follow) { pane.follow = false; bFollow.classList.remove('on'); }
      if (atEnd && pane.unseen) { pane.unseen = 0; this._chip(pane); }
    };

    // backfill rồi mới stream
    fetch(`/api/services/${encodeURIComponent(id)}/log?lines=400`)
      .then(r => r.json())
      .then(d => {
        (d.lines || []).forEach(l => pane.buffer.push(l));
        this._redraw(pane);
        if (autoscrollJob) { pane.follow = true; this._toBottom(pane); }
      })
      .catch(() => {});

    this._connect(pane);
    renderGroups();
  },

  _connect(pane) {
    const ws = new WebSocket(`ws://${location.host}/ws/logs/${encodeURIComponent(pane.id)}`);
    pane.ws = ws;
    ws.onmessage = ev => {
      const d = JSON.parse(ev.data);
      if (d.type === 'line') this._push(pane, d.text);
      else if (d.type === 'error') this._push(pane, '[panel] ' + d.text);
    };
    ws.onclose = () => {
      if (this.panes.has(pane.id)) {
        this._push(pane, '--- panel: mất kết nối log, thử lại sau 3s ---');
        setTimeout(() => { if (this.panes.has(pane.id)) this._connect(pane); }, 3000);
      }
    };
  },

  _push(pane, line) {
    if (pane.paused) return;
    pane.buffer.push(line);
    if (pane.buffer.length > 5000) pane.buffer.splice(0, pane.buffer.length - 5000);
    pane.pending.push(line);
    if (!pane.raf) pane.raf = requestAnimationFrame(() => this._flush(pane));
  },

  _flush(pane) {
    pane.raf = 0;
    const lines = pane.pending;
    pane.pending = [];
    const frag = document.createDocumentFragment();
    let added = 0;
    for (const l of lines) {
      if (pane.grep && !pane.grep.test(l)) continue;
      frag.appendChild(this._row(l));
      added++;
    }
    if (!added) return;
    pane.body.appendChild(frag);
    while (pane.body.childElementCount > 5000) pane.body.removeChild(pane.body.firstChild);
    if (pane.follow) this._toBottom(pane);
    else { pane.unseen += added; this._chip(pane); }
  },

  _row(line) {
    const d = el('div', 'l ' + this._cls(line), line);
    return d;
  },

  _cls(l) {
    if (/^---\s*panel|^===\s*\[server-panel\]/.test(l)) return 'l-panel';
    if (/ERROR|Traceback|CRITICAL|Exception/i.test(l)) return 'l-err';
    if (/WARN/i.test(l)) return 'l-warn';
    if (/"\s*(GET|POST|PUT|DELETE)[^"]*"\s+[45]\d\d/.test(l)) return 'l-err';
    if (/"\s*(GET|POST|PUT|DELETE)[^"]*"\s+[23]\d\d/.test(l)) return 'l-req';
    if (/READY|healthy|✔|OK\b/.test(l)) return 'l-ok';
    return '';
  },

  _redraw(pane) {
    pane.body.textContent = '';
    const frag = document.createDocumentFragment();
    for (const l of pane.buffer) {
      if (pane.grep && !pane.grep.test(l)) continue;
      frag.appendChild(this._row(l));
    }
    pane.body.appendChild(frag);
    if (pane.follow) this._toBottom(pane);
  },

  _toBottom(pane) {
    pane.body.scrollTop = pane.body.scrollHeight;
    pane.unseen = 0;
    this._chip(pane);
  },

  _chip(pane) {
    if (pane.unseen > 0) {
      if (!pane.chip) {
        pane.chip = el('div', 'newchip');
        pane.chip.onclick = () => { pane.follow = true; this._toBottom(pane); };
        pane.root.appendChild(pane.chip);
      }
      pane.chip.textContent = '↓ ' + pane.unseen + ' dòng mới';
    } else if (pane.chip) {
      pane.chip.remove();
      pane.chip = null;
    }
  },

  close(id) {
    const p = this.panes.get(id);
    if (!p) return;
    if (p.ws) { p.ws.onclose = null; p.ws.close(); }
    p.root.remove();
    this.panes.delete(id);
    if (!this.panes.size) $('#logempty').style.display = '';
    renderGroups();
  },

  closeAll() { [...this.panes.keys()].forEach(id => this.close(id)); },
};

// ── Telemetry ───────────────────────────────────────────────────────
function renderTelemetry() {
  const m = State.metrics;
  if (!m) return;
  vramBlocks($('#vram'), m.gpu, m.gpu_error);
  $('#wav-total').textContent = m.wav_total;
  $('#wav-sub').textContent = `${m.wav_in_window} trong ${Math.round(m.window_s)}s`;
  areaChart($('#chart-req'), m.requests_per_min, { errors: m.errors_per_min });
  barsH($('#chart-bars'), m.by_service, stateOf);
  $('#tele-foot').textContent =
    `Window · ${Math.round(m.window_s)}s · ${m.total_in_window} requests parsed from logs` +
    ` · ${m.probes_in_window} probe bị loại`;
}

function renderStrip() {
  const strip = $('#strip');
  const m = State.metrics;
  const clk = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  const parts = [];
  parts.push(`<span class="chip">CLK <b>${clk}</b></span>`);
  if (m && m.gpu && m.gpu.length) {
    const g = m.gpu[0];
    parts.push(`<span class="chip ok">GPU <b>${g.name}</b> · ${g.used_mb}/${g.total_mb} MiB · ${g.util_pct}%</span>`);
  } else if (m && m.gpu_error) {
    parts.push(`<span class="chip bad">GPU ${m.gpu_error}</span>`);
  }
  if (State.publicUrl) {
    parts.push(`<span class="chip ok">NGROK <b>${State.publicUrl}</b></span>`);
  } else {
    parts.push(`<span class="chip">NGROK <b>—</b></span>`);
  }
  const running = State.jobs.filter(j => j.running);
  if (running.length) {
    parts.push(`<span class="chip ok">JOB <b>${running.map(j => j.label).join(', ')}</b></span>`);
  }
  if (State.cfg) parts.push(`<span class="chip">CFG <b>${State.cfg.config_path}</b></span>`);
  strip.innerHTML = parts.join('');
}

// ── Kết nối ─────────────────────────────────────────────────────────
async function loadConfig() {
  State.cfg = await api('/api/config');
  renderGroups();
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws/status`);
  ws.onopen = () => { $('#conn').textContent = '● live'; $('#conn').style.color = 'var(--green)'; };
  ws.onmessage = ev => {
    const d = JSON.parse(ev.data);
    State.status = d.services || {};
    State.jobs = d.jobs || [];
    State.publicUrl = d.public_url;
    // payload đẩy kèm cửa sổ 300s; nếu người dùng chọn khác thì lấy riêng
    if (State.window_s === 300) {
      State.metrics = d.metrics || null;
      renderTelemetry();
    } else {
      api('/api/metrics?window_s=' + State.window_s)
        .then(m => { State.metrics = m; renderTelemetry(); })
        .catch(() => {});
    }
    renderGroups();
    renderStrip();
  };
  ws.onclose = () => {
    $('#conn').textContent = '○ mất kết nối, thử lại…';
    $('#conn').style.color = 'var(--red)';
    setTimeout(connect, 2000);
  };
}

// ── Khởi động ───────────────────────────────────────────────────────
$('#btn-reload').onclick = async () => {
  try {
    const r = await api('/api/config/reload', { method: 'POST' });
    await loadConfig();
    toast(`reload ok — ${r.services} service`, 'ok');
  } catch (e) { toast('reload lỗi: ' + e.message, 'err'); }
};
$('#btn-closeall').onclick = () => Logs.closeAll();

document.querySelectorAll('button.win').forEach(b => {
  b.onclick = async () => {
    document.querySelectorAll('button.win').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    State.window_s = +b.dataset.win;
    State.metrics = await api('/api/metrics?window_s=' + State.window_s);
    renderTelemetry();
  };
});

setInterval(renderStrip, 1000);
loadConfig().then(connect).catch(e => toast('không tải được config: ' + e.message, 'err'));
