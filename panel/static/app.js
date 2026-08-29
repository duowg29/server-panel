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
  incidents: [],
  lastIncidentId: null,   // null = lần nạp đầu, đừng réo lại chuyện cũ
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

// ── Sự cố ───────────────────────────────────────────────────────────
/* Badge đổi màu chỉ tồn tại khi có người đang nhìn. Service chết lúc bạn ở tab
   khác thì đến khi quay lại chỉ còn OFFLINE, không còn hiện trường. Nên: kêu
   ngay, và giữ lại 50 dòng log chụp đúng lúc gãy. */

function beep(kind) {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = kind === 'down' ? 220 : 660;
    gain.gain.setValueAtTime(0.0001, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ac.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.5);
    osc.connect(gain).connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.55);
    setTimeout(() => ac.close(), 900);
  } catch { /* trình duyệt chặn autoplay đến khi người dùng bấm gì đó */ }
}

function notify(item) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(
      item.kind === 'down' ? `${item.name} → ${item.state}` : `${item.name} đã trở lại`,
      { body: item.kind === 'down' ? 'Bấm vào panel để xem log lúc gãy' : `${item.prev} → ONLINE`, tag: `svc-${item.svc_id}` },
    );
  } catch { /* ignore */ }
}

async function showIncident(id) {
  try {
    const item = await api(`/api/incidents/${id}`);
    const when = new Date(item.ts * 1000).toLocaleString('vi-VN');
    const tail = (item.tail || []).join('\n') || '(log rỗng)';
    modal({
      wide: true,
      title: `${item.name} · ${item.prev} → ${item.state}`,
      bodyHTML: `<div class="inc-meta">${when} · ${item.log || 'không có log'}</div>
        <pre class="inc-tail"></pre>`,
    }).querySelector('.inc-tail').textContent = tail;
  } catch (e) { toast('không đọc được sự cố: ' + e.message, 'err'); }
}

function onIncidents(items) {
  State.incidents = items || [];
  const latest = State.incidents.length ? State.incidents[State.incidents.length - 1].id : 0;

  if (State.lastIncidentId === null) {   // lần nạp đầu: chỉ ghi mốc
    State.lastIncidentId = latest;
    renderIncidentBar();
    return;
  }
  const fresh = State.incidents.filter(i => i.id > State.lastIncidentId);
  State.lastIncidentId = latest;

  for (const item of fresh) {
    const down = item.kind === 'down';
    const t = el('div', 'toast ' + (down ? 'err' : 'ok'));
    t.textContent = down
      ? `${item.name}: ${item.prev} → ${item.state} — bấm để xem log lúc gãy`
      : `${item.name} đã trở lại (${item.prev} → ONLINE)`;
    if (down) {
      t.style.cursor = 'pointer';
      t.onclick = () => { showIncident(item.id); t.remove(); };
      // Không tự tắt: sự cố mà biến mất sau 9s thì cũng như không báo.
    } else {
      setTimeout(() => t.remove(), 6000);
    }
    $('#toasts').appendChild(t);
    beep(item.kind);
    notify(item);
  }
  renderIncidentBar();
}

function renderIncidentBar() {
  const last = [...State.incidents].reverse().find(i => i.kind === 'down');
  const bar = $('#incident-bar');
  if (!bar) return;
  if (!last) { bar.hidden = true; return; }
  bar.hidden = false;
  const when = new Date(last.ts * 1000).toLocaleTimeString('vi-VN', { hour12: false });
  bar.textContent = `sự cố gần nhất · ${when} · ${last.name} ${last.prev} → ${last.state}`;
  bar.onclick = () => showIncident(last.id);
}

// ── Render card ─────────────────────────────────────────────────────
function stateOf(id) { return (State.status[id] || {}).state || 'UNKNOWN'; }

/* Card dựng MỘT LẦN, sau đó chỉ cập nhật tại chỗ.

   Trước đây mỗi frame status (2s) gọi renderGroups() → xoá sạch #groups rồi
   dựng lại toàn bộ. Hệ quả không phải chỉ là tốn CPU: bảng "⋯ Thêm" đang mở tự
   sập, tooltip đang hiện biến mất, nút đang hover mất trạng thái. Thao tác của
   người dùng bị reset hai giây một lần.

   Nên tách: buildCard() dựng khung, syncCard() chỉ ghi đè text/class/disabled.
   renderGroups() giờ chỉ chạy khi CONFIG đổi. */
let _cards = new Map();   // svc_id -> phần tử card

function renderGroups() {
  const wrap = $('#groups');
  wrap.innerHTML = '';
  _cards = new Map();
  if (!State.cfg) return;

  for (const g of State.cfg.groups) {
    if (g.hidden) continue;   // vẫn nạp trong config (conflicts_with cần), chỉ ẩn UI
    const svcs = State.cfg.services.filter(s => s.group === g.id);
    if (!svcs.length) continue;
    const sec = el('section', 'sec');
    const h = el('h2', null, g.label);
    h.appendChild(el('span', 'close-bracket'));
    sec.appendChild(h);
    const grid = el('div', 'cards');
    svcs.forEach(s => {
      const card = buildCard(s);
      _cards.set(s.id, card);
      grid.appendChild(card);
    });
    sec.appendChild(grid);
    wrap.appendChild(sec);
  }
  syncAll();
}

/** Cập nhật mọi card theo State.status hiện tại. KHÔNG xoá node nào. */
function syncAll() {
  if (!State.cfg) return;
  for (const svc of State.cfg.services) {
    const card = _cards.get(svc.id);
    if (card) syncCard(card, svc);
  }
  applyFilter();
}

/* Lọc card. ẨN bằng `hidden` chứ không xoá node — giữ nguyên nguyên tắc của
   syncCard: không đụng vào cấu trúc DOM thì bảng "⋯ Thêm" đang mở vẫn mở, và
   gõ vào ô lọc không làm mất thao tác đang dở. */
function applyFilter() {
  const inp = $('#svc-filter');
  // popout.html không có ô lọc — đừng giả định phần tử tồn tại, cũng đừng giả
  // định nó có .value
  const q = ((inp && inp.value) || '').trim().toLowerCase();
  if (!State.cfg) return;
  for (const svc of State.cfg.services) {
    const card = _cards.get(svc.id);
    if (!card) continue;
    const hay = [svc.id, svc.name, svc.port, stateOf(svc.id)].join(' ').toLowerCase();
    card.hidden = q !== '' && !hay.includes(q);
  }
  // khu vực không còn card nào hiện thì ẩn luôn cả tiêu đề nhóm
  document.querySelectorAll('#groups .sec').forEach(sec => {
    const any = [...sec.querySelectorAll('.card')].some(c => !c.hidden);
    sec.hidden = !any;
  });
}

function buildCard(svc) {
  const card = el('div', 'card');
  card.dataset.id = svc.id;
  const p = card._p = {};

  const head = el('div', 'card__head');
  head.appendChild(el('span', 'card__name', svc.name));
  p.badge = el('span', 'card__badge');
  head.appendChild(p.badge);
  card.appendChild(head);

  // meta: port / detail / pid / uptime — không có gì tương tác được ở đây nên
  // dựng lại nội dung của riêng nó là an toàn
  p.meta = el('div', 'card__meta');
  card.appendChild(p.meta);

  // một dòng duy nhất cho cả ba trường hợp: thiếu env / lỗi / ghi chú tĩnh
  p.note = el('div', 'card__note');
  p.note.hidden = true;
  card.appendChild(p.note);

  // thanh tiến trình cho card composite — 100% = mọi service đã lên
  if (svc.kind === 'composite') {
    p.bar = el('div', 'prog');
    p.fill = el('i');
    p.bar.appendChild(p.fill);
    p.cap = el('div', 'prog__cap');
    p.bar.hidden = p.cap.hidden = true;
    card.append(p.bar, p.cap);
  }

  p.urlLine = el('div', 'card__url');
  p.urlLink = el('a');
  p.urlLink.target = '_blank';
  p.urlLink.rel = 'noreferrer';
  p.urlLine.append(el('span', null, '🌐 '), p.urlLink);
  p.urlLine.hidden = true;
  card.appendChild(p.urlLine);

  // hàng nút chính
  const btns = el('div', 'btns');

  if (svc.can_start) {
    p.bStart = el('button', 'go' + (svc.emphasis === 'primary' ? ' big' : ''), '▶  Chạy');
    p.bStart.onclick = () => doStart(svc);
    btns.appendChild(p.bStart);
  }
  if (svc.can_stop) {
    p.bStop = el('button', 'stop' + (svc.emphasis === 'primary' ? ' big' : ''), '■  Dừng');
    p.bStop.onclick = () => act(svc.id, 'stop');
    btns.appendChild(p.bStop);
  }
  if (svc.can_start && svc.can_stop) {
    p.bRestart = el('button', null, '↻  Khởi động lại');
    p.bRestart.onclick = () => act(svc.id, 'restart');
    btns.appendChild(p.bRestart);
  }
  if (svc.log || svc.start_mode === 'script') {
    p.bLog = el('button', null, '▤  Log');
    p.bLog.onclick = () => Logs.toggle(svc.id, svc.name);
    btns.appendChild(p.bLog);
    const pop = el('button', 'ghost', '⇱  Cửa sổ');
    pop.onclick = () => window.open('/popout?log=' + encodeURIComponent(svc.id),
      'log_' + svc.id, 'width=960,height=640');
    btns.appendChild(pop);
  }
  card.appendChild(btns);

  // Hàng nút phụ nằm sau nút "Thêm" — trước đây 7-8 nút chen chúc một hàng,
  // nhìn rối và không biết cái nào quan trọng.
  const extra = el('div', 'btns more');
  extra.style.display = 'none';
  (svc.actions || []).forEach(a => {
    const b = el('button', null, a.label);
    b.onclick = () => runAction(svc, a);
    extra.appendChild(b);
  });
  if (!State.cfg.readonly) {
    const add = el('button', 'ghost', '＋ Lệnh'); add.onclick = () => addActionModal(svc);
    const ed = el('button', 'ghost', '✎ Sửa'); ed.onclick = () => editModal(svc);
    const rm = el('button', 'ghost', '🗑 Xoá'); rm.onclick = () => deleteService(svc);
    extra.append(add, ed, rm);
  }
  if (svc.log) {
    const tr = el('button', 'ghost', '⌫ Xoá file log');
    tr.title = 'Truncate ' + svc.log;
    tr.onclick = async () => {
      if (!await confirmModal('Xoá sạch nội dung <b>' + svc.log + '</b>?')) return;
      await api(`/api/services/${svc.id}/truncate-log`, { method: 'POST' })
        .then(() => toast('đã xoá log', 'ok')).catch(e => toast(e.message, 'err'));
    };
    extra.appendChild(tr);
  }
  if (extra.children.length) {
    const toggle = el('button', 'ghost', '⋯  Thêm');
    toggle.onclick = () => {
      const open = extra.style.display === 'none';
      extra.style.display = open ? 'flex' : 'none';
      toggle.textContent = open ? '⋯  Thu gọn' : '⋯  Thêm';
      toggle.classList.toggle('on', open);
    };
    btns.appendChild(toggle);
    card.appendChild(extra);
  }

  return card;
}

/** Ghi đè phần thay đổi được của một card. Không đụng tới cấu trúc DOM —
    nhờ vậy bảng "⋯ Thêm" đang mở vẫn mở, hover/focus không mất. */
function syncCard(card, svc) {
  const p = card._p;
  const st = State.status[svc.id] || {};
  const state = st.state || 'UNKNOWN';
  const busy = State.busy.has(svc.id);

  card.className = 'card' + (svc.emphasis === 'primary' ? ' primary' : '') +
    (busy ? ' busy' : '');

  p.badge.className = 'card__badge st-' + state;
  p.badge.textContent = '● ' + state + (st.external ? ' EXT' : '');

  // meta là chuỗi text thuần: so chữ trước, khác mới dựng lại
  const bits = [];
  if (svc.port) bits.push(['k', ':' + svc.port]);
  (st.detail || []).forEach(d => bits.push([null, d]));
  if (st.pid) bits.push([null, 'pid ' + st.pid]);
  if (st.uptime_s != null) bits.push([null, 'up ' + fmtDur(st.uptime_s)]);
  if (st.latency_ms != null && state !== 'OFFLINE') bits.push([null, st.latency_ms + 'ms']);
  const sig = JSON.stringify(bits);
  if (p.metaSig !== sig) {
    p.metaSig = sig;
    p.meta.textContent = '';
    bits.forEach(([cls, txt]) => p.meta.appendChild(el('span', cls, txt)));
  }

  // ghi chú: thiếu env > lỗi > note tĩnh
  if (state === 'NO_ENV' && (st.missing || []).length) {
    p.note.hidden = false;
    p.note.className = 'card__warn';
    p.note.textContent = '⚠ thiếu: ' + st.missing.join(', ');
    p.note.title = st.missing.join('\n');
  } else {
    const text = (st.error && state === 'OFFLINE') ? st.error : (svc.note || '');
    p.note.hidden = !text;
    p.note.className = 'card__note';
    p.note.title = '';
    if (p.note.textContent !== text) p.note.textContent = text;
  }

  if (p.bar) {
    const pr = st.progress;
    p.bar.hidden = p.cap.hidden = !pr;
    if (!pr) {
      // dọn luôn ruột của node đã ẩn: để nội dung cũ nằm lại là mời một lỗi
      // "hiện lại thấy số của lần trước" vào lần sửa sau
      p.bar.className = 'prog';
      p.fill.style.width = '';
      p.cap.textContent = '';
      p.capSig = null;
    } else {
      p.bar.className = 'prog' + (pr.pct >= 100 ? ' done' : '');
      p.fill.style.width = pr.pct + '%';
      const cbits = [['b', pr.pct + '%'], [null, `${pr.done}/${pr.total} service`]];
      if (pr.current) cbits.push([null, '→ ' + pr.current]);
      if (pr.label) cbits.push(['mono', pr.label]);
      const csig = JSON.stringify(cbits);
      if (p.capSig !== csig) {
        p.capSig = csig;
        p.cap.textContent = '';
        cbits.forEach(([tag, txt]) =>
          p.cap.appendChild(el(tag === 'b' ? 'b' : 'span', tag === 'b' ? null : tag, txt)));
      }
    }
  }

  p.urlLine.hidden = !st.public_url;
  if (!st.public_url) {
    p.urlLink.textContent = '';
    p.urlLink.removeAttribute('href');
  } else if (p.urlLink.textContent !== st.public_url) {
    p.urlLink.textContent = st.public_url;
    p.urlLink.href = st.public_url;
  }

  const running = ['ONLINE', 'DEGRADED', 'STARTING'].includes(state);
  const unmet = (svc.depends_on || []).filter(d => stateOf(d) !== 'ONLINE');
  // server tự tính (nó xác minh có process thật, không chỉ nhìn health —
  // hybrid và vLLM dùng chung port nên health không phân biệt được)
  const conflicts = st.blocked_by || [];

  if (p.bStart) {
    p.bStart.disabled = busy || unmet.length > 0 || conflicts.length > 0 || state === 'NO_ENV';
    p.bStart.title = unmet.length ? 'Cần ONLINE trước: ' + unmet.join(', ')
      : conflicts.length ? 'Đang chạy stack xung đột: ' + conflicts.join(', ')
        : state === 'NO_ENV' ? 'Thiếu môi trường: ' + (st.missing || []).join(', ') : '';
  }
  if (p.bStop) p.bStop.disabled = busy || (!running && !st.pid);
  if (p.bRestart) p.bRestart.disabled = busy || state === 'NO_ENV';
  if (p.bLog) p.bLog.classList.toggle('on', Logs.has(svc.id));
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
  syncAll();
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
    syncAll();
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
  //: số dòng tối đa DỰNG RA DOM một lúc (buffer vẫn giữ 5000)
  DRAW_MAX: 2000,

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

    // Hàng 1: tên log + đóng. Hàng 2: thanh công cụ, nút CÓ CHỮ.
    const head = el('div', 'logpane__head');
    const t = el('span', 'logpane__title', (title || id) + '.log');
    t.title = 'Bấm để thu gọn';
    t.onclick = () => root.classList.toggle('collapsed');
    head.appendChild(t);
    head.appendChild(el('span', 'grow'));
    const bClose = el('button', 'ghost', '✕  Đóng');
    head.appendChild(bClose);
    root.appendChild(head);

    const bar = el('div', 'logpane__bar');
    const bPause = el('button', null, '⏸  Tạm dừng');
    const bGrep = el('button', null, '⌕  Lọc');
    const bFollow = el('button', 'on', '⤓  Bám đáy');
    const bClear = el('button', null, '⌫  Xoá màn hình');
    const bPop = el('button', null, '⇱  Cửa sổ riêng');
    bar.append(bPause, bGrep, bFollow, bClear, bPop);
    root.appendChild(bar);

    const tools = el('div', 'logpane__tools');
    const inp = el('input');
    inp.placeholder = 'lọc dòng theo regex, ví dụ:  ERROR|WARN';
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
      bPause.textContent = pane.paused ? '▶  Chạy tiếp' : '⏸  Tạm dừng';
    };
    bFollow.onclick = () => {
      pane.follow = !pane.follow;
      bFollow.classList.toggle('on', pane.follow);
      bFollow.textContent = pane.follow ? '⤓  Bám đáy' : '⤓  Không bám';
      if (pane.follow) this._toBottom(pane);
    };
    bClear.onclick = () => { pane.buffer = []; this._redraw(pane); };
    bGrep.onclick = () => {
      tools.classList.toggle('show');
      bGrep.classList.toggle('on', tools.classList.contains('show'));
      if (tools.classList.contains('show')) inp.focus();
      else { inp.value = ''; pane.grep = null; this._redraw(pane); }
    };
    // Debounce: mỗi ký tự gõ vào đây kéo theo một lần dựng lại tới vài nghìn
    // dòng. Gõ "ERROR" mà vẽ lại 5 lần thì ô nhập giật theo.
    inp.oninput = () => {
      try { pane.grep = inp.value ? new RegExp(inp.value, 'i') : null; inp.style.borderColor = ''; }
      catch { inp.style.borderColor = 'var(--red)'; return; }
      clearTimeout(pane.grepTimer);
      pane.grepTimer = setTimeout(() => this._redraw(pane), 120);
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
    syncAll();
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
    // Buffer giữ đủ 5000 dòng, nhưng CHỈ vẽ 2000 dòng cuối khớp bộ lọc: không
    // ai cuộn ngược 5000 dòng trong một pane cao mấy trăm pixel, mà dựng chừng
    // ấy node thì thấy giật ngay.
    const matched = [];
    for (const l of pane.buffer) {
      if (pane.grep && !pane.grep.test(l)) continue;
      matched.push(l);
    }
    const shown = matched.slice(-this.DRAW_MAX);
    if (matched.length > shown.length) {
      frag.appendChild(el('div', 'l l-panel',
        `--- panel: ẩn ${matched.length - shown.length} dòng cũ hơn (còn trong bộ nhớ) ---`));
    }
    for (const l of shown) frag.appendChild(this._row(l));
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
      pane.chip.textContent = '↓  ' + pane.unseen + ' dòng mới';
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
    syncAll();
  },

  closeAll() { [...this.panes.keys()].forEach(id => this.close(id)); },
};

function renderStrip() {
  const strip = $('#strip');
  const m = State.metrics;
  const clk = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  const parts = [];
  parts.push(`<span class="chip">CLK <b>${clk}</b></span>`);
  if (m && m.gpu && m.gpu.length) {
    const g = m.gpu[0];
    // Tách hẳn hai con số: bộ nhớ và mức tải GPU là hai thứ khác nhau, để
    // cạnh nhau không nhãn thì đọc thành "11.7/16.4 GB = 40%" (sai).
    const gb = v => (v / 1024).toFixed(1);
    const memPct = Math.round(100 * g.used_mb / g.total_mb);
    parts.push(`<span class="chip ok">${g.name}</span>`);
    parts.push(`<span class="chip ok">VRAM <b>${gb(g.used_mb)}/${gb(g.total_mb)} GB</b> (${memPct}%)</span>`);
    parts.push(`<span class="chip ok">TẢI GPU <b>${g.util_pct}%</b></span>`);
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
  ws.onopen = () => { $('#conn').textContent = '● đang theo dõi'; $('#conn').style.color = 'var(--green)'; };
  ws.onmessage = ev => {
    const d = JSON.parse(ev.data);
    State.status = d.services || {};
    State.jobs = d.jobs || [];
    State.publicUrl = d.public_url;
    // payload đẩy kèm cửa sổ 300s; nếu người dùng chọn khác thì lấy riêng
    // Telemetry chi tiết đã chuyển hẳn sang tab Biểu đồ; ở đây chỉ giữ
    // metrics cho thanh trạng thái trên cùng (GPU/VRAM).
    State.metrics = d.metrics || null;
    onIncidents(d.incidents);
    syncAll();
    renderStrip();
  };
  ws.onclose = () => {
    $('#conn').textContent = '○ mất kết nối, đang thử lại…';
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
if ($('#svc-filter')) $('#svc-filter').oninput = () => applyFilter();
$('#btn-notify').onclick = async () => {
  if (!('Notification' in window)) return toast('trình duyệt không hỗ trợ thông báo', 'err');
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? 'đã bật thông báo khi service chết' : 'thông báo bị từ chối', p === 'granted' ? 'ok' : 'err');
};



setInterval(renderStrip, 1000);
loadConfig().then(connect).catch(e => toast('không tải được config: ' + e.message, 'err'));


// ── Biểu đồ nằm thẳng trang chính, không tab ──────────────────────────
// Chỉ tạm dừng khi cửa sổ trình duyệt bị ẩn — đỡ tốn CPU lúc để nền.
document.addEventListener('visibilitychange', () => {
  if (typeof ChartsTab === 'undefined') return;
  // ChartsTab tự cân nhắc cả "có trong tầm nhìn không" — đừng ép start ở đây,
  // không thì cuộn khuất mà quay lại tab là nó vẽ tiếp dù không ai nhìn.
  ChartsTab.sync();
});
// KHÔNG start ở đây: app.js nạp TRƯỚC charts_tab.js nên ChartsTab còn undefined.
// charts_tab.js tự khởi động ở cuối file của nó.
