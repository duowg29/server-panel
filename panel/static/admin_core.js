/* Trang Admin — lõi: gọi API, toast, modal, điều hướng giữa các mục,
   công tắc "Cho phép ghi". Không framework, không build step (giống panel).

   Mỗi mục là một module tự đăng ký:
     Admin.register({ id, title, group, render(main, args) })
   URL dạng #/<id>/<tham số…> — tải lại trang vẫn đúng chỗ. */

const $ = s => document.querySelector(s);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── HTTP ────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { detail: text }; }
  if (!r.ok) {
    const e = new Error(body.detail || body.error || `HTTP ${r.status}`);
    e.status = r.status;
    if (r.status === 423) Admin.refreshStatus();   // công tắc ghi vừa hết giờ
    throw e;
  }
  return body;
}

/** Gọi hàm tt_admin_* (hàm ghi bị backend chặn khi đang chỉ xem). */
const rpc = (fn, params = {}) => api(`/api/admin/rpc/${fn}`, { method: 'POST', body: JSON.stringify(params) });

function toast(msg, kind = '') {
  const t = el('div', 'toast ' + kind, msg);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'err' ? 9000 : 4500);
}

// ── Modal (cùng kiểu với server panel) ──────────────────────────────
function modal({ title, bodyHTML, body, okLabel = 'OK', onOk, onClose, wide, extra }) {
  const bg = el('div', 'modal-bg');
  const m = el('div', 'modal');
  if (wide) m.style.maxWidth = wide === true ? '60rem' : wide;
  m.innerHTML = `<h3>${esc(title)}</h3><div class="body"></div>
    <div class="foot"><span class="grow"></span><button class="cancel">Huỷ</button>
    <button class="ok go">${esc(okLabel)}</button></div>`;
  const b = m.querySelector('.body');
  if (body) b.appendChild(body); else b.innerHTML = bodyHTML || '';
  if (extra) for (const x of extra) m.querySelector('.foot').insertBefore(x, m.querySelector('.grow'));
  bg.appendChild(m);
  document.body.appendChild(bg);
  let done = false;
  const close = () => {
    bg.remove();
    document.removeEventListener('keydown', onEsc);
    if (!done) { done = true; if (onClose) onClose(); }
  };
  const onEsc = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onEsc);
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  m.querySelector('.cancel').onclick = close;
  const ok = m.querySelector('.ok');
  ok.onclick = async () => {
    ok.disabled = true;
    try {
      const keep = onOk ? await onOk(m) : false;
      if (!keep) { done = true; close(); }
    } catch (e) {
      let err = m.querySelector('.err');
      if (!err) { err = el('div', 'err'); b.appendChild(err); }
      err.textContent = e.message;
    } finally { ok.disabled = false; }
  };
  if (!onOk) { m.querySelector('.cancel').remove(); ok.textContent = 'Đóng'; ok.className = 'ok'; }
  m.close = close;
  return m;
}

function confirmModal(text, okLabel = 'Đồng ý', danger = false) {
  return new Promise(res => {
    const m = modal({
      title: 'Xác nhận', bodyHTML: `<div>${text}</div>`, okLabel,
      onOk: () => { res(true); return false; },
      onClose: () => res(false),
    });
    if (danger) m.querySelector('.ok').className = 'ok stop';
  });
}

const fmtTime = t => t ? new Date(typeof t === 'number' ? t * 1000 : t).toLocaleString('vi-VN') : '';
const fmtNum = n => (n == null ? '—' : Number(n).toLocaleString('vi-VN'));

// ── Admin: trạng thái, công tắc ghi, điều hướng ────────────────────
const Admin = {
  modules: [],
  beforeStart: [],      // hàm chạy trước khi dựng menu (module đăng ký muộn)
  status: null,
  current: null,

  register(mod) {
    this.modules.push(mod);
    this.modules.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  },

  get canWrite() { return !!(this.status && this.status.write && this.status.write.on); },

  async refreshStatus() {
    try {
      this.status = await api('/api/admin/status');
    } catch (e) {
      this.status = { ok: false, error: e.message, write: { on: false } };
    }
    this.renderStrip();
    this.renderWrite();
    document.body.classList.toggle('can-write', this.canWrite);
    return this.status;
  },

  renderStrip() {
    const s = this.status || {};
    const strip = $('#strip');
    strip.innerHTML = '';
    const chip = (label, val, cls = '') => {
      const c = el('span', 'chip ' + cls);
      c.innerHTML = `${esc(label)} <b>${esc(val)}</b>`;
      strip.appendChild(c);
    };
    const conn = $('#conn');
    if (!s.configured) {
      conn.textContent = '○ chưa cấu hình';
      chip('Cấu hình', 'thiếu .env.admin', 'bad');
      return;
    }
    if (!s.ok) {
      conn.textContent = '● lỗi kết nối';
      chip('Supabase', s.error || 'lỗi', 'bad');
      return;
    }
    conn.textContent = `● ${s.project}`;
    chip('Dự án', s.project, 'ok');
    chip('Bảng', s.tables);
    const miss = (s.rpcs_missing || []).length;
    chip('Hàm admin', `${s.rpcs_total - miss}/${s.rpcs_total}`, miss ? 'bad' : 'ok');
    chip('Chế độ', s.write && s.write.on ? 'CHO PHÉP GHI' : 'chỉ xem', s.write && s.write.on ? 'warn' : '');
  },

  renderWrite() {
    const b = $('#btn-write');
    const w = (this.status && this.status.write) || {};
    if (w.on) {
      const m = Math.floor(w.left_s / 60), s = String(w.left_s % 60).padStart(2, '0');
      b.textContent = `✎  Đang cho ghi · ${m}:${s}`;
      b.className = 'stop';
    } else {
      b.textContent = '🔒  Chỉ xem';
      b.className = '';
    }
  },

  async toggleWrite() {
    if (this.canWrite) {
      this.status.write = await api('/api/admin/write', { method: 'POST', body: '{"on":false}' });
      toast('Đã về chế độ chỉ xem');
    } else {
      const min = (this.status && this.status.write_minutes) || 15;
      const yes = await confirmModal(
        `Bật <b>cho phép ghi</b> trong ${min} phút?<br><br>Mọi sửa / xoá đi thẳng vào dữ liệu ` +
        `<b>thật</b> trên Supabase và được ghi vào nhật ký.`, 'Bật ghi', true);
      if (!yes) return;
      this.status.write = await api('/api/admin/write', { method: 'POST', body: '{"on":true}' });
      toast(`Đang cho ghi — tự tắt sau ${min} phút`, 'warn');
    }
    this.renderStrip();
    this.renderWrite();
    document.body.classList.toggle('can-write', this.canWrite);
    if (this.current && this.current.onWriteChange) this.current.onWriteChange();
  },

  /** Nút / ô nhập chỉ dùng được khi đang cho ghi. */
  writeOnly(node) { node.classList.add('w-only'); return node; },

  renderNav() {
    const nav = $('#anav');
    nav.innerHTML = '';
    let group = null;
    for (const m of this.modules) {
      if (m.group !== group) {
        group = m.group;
        if (group) nav.appendChild(el('div', 'anav__group', group));
      }
      const a = el('a', 'anav__item');
      a.href = `#/${m.id}`;
      a.dataset.id = m.id;
      a.innerHTML = `<span class="ic">${m.icon || '▸'}</span>${esc(m.title)}` +
        (m.wip ? '<span class="anav__wip">sắp có</span>' : '');
      nav.appendChild(a);
    }
  },

  route() {
    const parts = (location.hash.replace(/^#\/?/, '') || 'home').split('/').map(decodeURIComponent);
    const mod = this.modules.find(m => m.id === parts[0]) || this.modules[0];
    for (const a of document.querySelectorAll('.anav__item')) a.classList.toggle('on', a.dataset.id === mod.id);
    const main = $('#amain');
    if (this.current && this.current.leave) this.current.leave();
    this.current = mod;
    main.innerHTML = '';
    try {
      mod.render(main, parts.slice(1));
    } catch (e) {
      main.appendChild(el('div', 'aempty', `Lỗi dựng trang: ${e.message}`));
    }
  },

  async start() {
    for (const f of this.beforeStart) f();
    this.renderNav();
    $('#btn-write').onclick = () => this.toggleWrite().catch(e => toast(e.message, 'err'));
    $('#btn-refresh').onclick = async () => { await this.refreshStatus(); this.route(); };
    window.addEventListener('hashchange', () => this.route());
    await this.refreshStatus();
    this.route();
    // Đếm ngược công tắc ghi; hỏi lại server mỗi 30 s (hết giờ là tự về chỉ xem).
    setInterval(() => {
      const w = this.status && this.status.write;
      if (w && w.on) {
        w.left_s = Math.max(0, w.left_s - 1);
        if (w.left_s === 0) { this.refreshStatus(); if (this.current && this.current.onWriteChange) this.current.onWriteChange(); }
        else this.renderWrite();
      }
    }, 1000);
    setInterval(() => this.refreshStatus(), 30000);
  },
};

/** Khung một trang: tiêu đề + mô tả + thanh nút. */
function pageHead(main, title, desc) {
  const h = el('div', 'apage__head');
  h.innerHTML = `<h2>${esc(title)}</h2>${desc ? `<p>${desc}</p>` : ''}`;
  const bar = el('div', 'apage__bar');
  h.appendChild(bar);
  main.appendChild(h);
  return bar;
}

/** Trang chờ cho mục chưa làm. */
function wipPage(title, what) {
  return (main) => {
    pageHead(main, title);
    main.appendChild(el('div', 'aempty', what || 'Mục này đang được chuyển từ tinytalk-admin sang.'));
  };
}

document.addEventListener('DOMContentLoaded', () => {
  // Các file module nạp sau admin_core.js đã kịp register().
  Admin.start();
});
