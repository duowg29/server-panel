/* Khối dựng dùng chung cho các mục admin: thẻ số liệu, biểu đồ cột ngang,
   bảng (tìm / sắp xếp / phân trang / CSV ở phía trình duyệt), form, tab,
   và gọi hàm ghi (tự hỏi bật "Cho phép ghi" nếu đang chỉ xem). */

const Kit = {
  // ── định dạng ──────────────────────────────────────────────────────
  date(v) { return v ? new Date(v).toLocaleDateString('vi-VN') : '—'; },
  dateTime(v) { return v ? new Date(v).toLocaleString('vi-VN') : '—'; },
  /** "dd/mm" — nhãn trục ngày. */
  dm(v) { if (!v) return '—'; const d = new Date(v); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`; },
  num: fmtNum,
  text(v) { return v == null || v === '' ? '—' : String(v); },
  json(v) { return v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v); },

  badge(text, kind = '') {
    const b = el('span', 'kbadge ' + kind, text);
    return b;
  },

  // ── thẻ số liệu ────────────────────────────────────────────────────
  kpis(parent, items) {
    const row = el('div', 'kkpis');
    for (const it of items) {
      const k = el('div', 'kpi');
      k.innerHTML = `<h4>${esc(it.label)}</h4><div class="kpi__v ${it.cls || ''}">${esc(it.value)}</div>` +
        (it.sub ? `<div class="kpi__s">${esc(it.sub)}</div>` : '');
      row.appendChild(k);
    }
    parent.appendChild(row);
    return row;
  },

  /** Biểu đồ cột ngang đơn giản: entries = [[nhãn, số], …]. */
  bars(parent, title, entries) {
    const box = el('div', 'kbars');
    box.appendChild(el('h4', null, title));
    const max = Math.max(1, ...entries.map(e => e[1]));
    for (const [label, n] of entries) {
      const r = el('div', 'kbars__r');
      r.innerHTML = `<span class="l">${esc(label)}</span><span class="b"><i style="width:${(n / max) * 100}%"></i></span><span class="n">${fmtNum(n)}</span>`;
      box.appendChild(r);
    }
    if (!entries.length) box.appendChild(el('div', 'muted small', 'Không có dữ liệu'));
    parent.appendChild(box);
    return box;
  },

  // ── bảng ───────────────────────────────────────────────────────────
  /** columns: [{key, label, render(row) → chuỗi | Node, sort (mặc định có), value(row) để sắp xếp / CSV}] */
  table(parent, { columns, rows = [], pageSize = 25, empty = 'Không có dòng nào.', onRow, rowClass, csvName, toolbar }) {
    const wrap = el('div', 'ktable');
    const bar = el('div', 'ktable__bar');
    const grid = el('div', 'dgrid-wrap');
    const pager = el('div', 'tables__pager');
    wrap.append(bar, grid, pager);
    parent.appendChild(wrap);
    const st = { rows, page: 0, size: pageSize, sort: null, desc: false };
    const val = (c, r) => (c.value ? c.value(r) : r[c.key]);

    if (toolbar) for (const n of toolbar) bar.appendChild(n);
    if (csvName) {
      const b = el('button', 'ghost', '⇩  CSV');
      b.onclick = () => Kit.csv(csvName, columns, st.rows, val);
      bar.appendChild(b);
    }
    if (!bar.children.length) bar.remove();

    const draw = () => {
      let list = st.rows.slice();
      if (st.sort) {
        const c = columns.find(x => x.key === st.sort);
        list.sort((a, b) => {
          const x = val(c, a), y = val(c, b);
          if (x == null && y == null) return 0;
          if (x == null) return 1;
          if (y == null) return -1;
          const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'vi', { numeric: true });
          return st.desc ? -r : r;
        });
      }
      const pages = Math.max(1, Math.ceil(list.length / st.size));
      st.page = Math.min(st.page, pages - 1);
      const view = list.slice(st.page * st.size, (st.page + 1) * st.size);

      const t = el('table', 'dgrid');
      const hr = el('tr');
      for (const c of columns) {
        const th = el('th', null, c.label + (st.sort === c.key ? (st.desc ? ' ▼' : ' ▲') : ''));
        if (c.sort !== false) {
          th.onclick = () => {
            if (st.sort === c.key) st.desc = !st.desc; else { st.sort = c.key; st.desc = false; }
            draw();
          };
        } else th.style.cursor = 'default';
        hr.appendChild(th);
      }
      const th = el('thead');
      th.appendChild(hr);
      t.appendChild(th);
      const tb = el('tbody');
      for (const r of view) {
        const tr = el('tr');
        if (rowClass) { const k = rowClass(r); if (k) tr.className = k; }
        for (const c of columns) {
          const td = el('td');
          const out = c.render ? c.render(r) : Kit.text(r[c.key]);
          if (out instanceof Node) td.appendChild(out); else td.textContent = out;
          if (c.cls) td.className = c.cls;
          tr.appendChild(td);
        }
        if (onRow) tr.onclick = (e) => { if (!e.target.closest('button,a,select,input')) onRow(r); };
        else tr.style.cursor = 'default';
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      grid.innerHTML = '';
      grid.appendChild(list.length ? t : el('div', 'aempty', empty));

      pager.innerHTML = '';
      const from = list.length ? st.page * st.size + 1 : 0;
      pager.appendChild(el('span', 'muted', `${fmtNum(from)}–${fmtNum(st.page * st.size + view.length)} / ${fmtNum(list.length)}`));
      const prev = el('button', '', '‹');
      prev.disabled = st.page === 0;
      prev.onclick = () => { st.page--; draw(); };
      const next = el('button', '', '›');
      next.disabled = st.page >= pages - 1;
      next.onclick = () => { st.page++; draw(); };
      pager.append(prev, el('span', 'muted pg', `trang ${st.page + 1}/${pages}`), next);
    };
    draw();
    return {
      setRows(r) { st.rows = r; st.page = 0; draw(); },
      get rows() { return st.rows; },
    };
  },

  /** Bảng đọc thẳng từ một bảng Supabase, phân trang / tìm / sắp xếp ở server
   *  (cho bảng lớn). query() trả thêm tham số: {f: ['col|op|val'], deleted, q}. */
  serverTable(parent, { table, columns, pageSize = 25, order = 'id', desc = true, query, onRow, toolbar, empty = 'Không có dòng nào.' }) {
    const wrap = el('div', 'ktable');
    const bar = el('div', 'ktable__bar');
    const q = el('input', 'ainput');
    q.type = 'search';
    q.placeholder = '⌕  tìm…';
    q.style.flex = '1';
    bar.appendChild(q);
    if (toolbar) for (const n of toolbar) bar.appendChild(n);
    const grid = el('div', 'dgrid-wrap');
    const pager = el('div', 'tables__pager');
    wrap.append(bar, grid, pager);
    parent.appendChild(wrap);
    const st = { offset: 0, size: pageSize, order, desc, total: null, rows: [] };
    let timer;
    q.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { st.offset = 0; load(); }, 350); };
    const load = async () => {
      const p = new URLSearchParams({ limit: st.size, offset: st.offset, order: st.order });
      if (st.desc) p.set('desc', '1');
      if (q.value.trim()) p.set('q', q.value.trim());
      const extra = query ? query() : {};
      for (const f of extra.f || []) p.append('f', f);
      if (extra.deleted) p.set('deleted', extra.deleted);
      grid.classList.add('loading');
      try {
        const r = await api(`/api/admin/tables/${table}/rows?${p}`);
        st.rows = r.rows;
        st.total = r.total;
        draw();
      } catch (e) {
        grid.innerHTML = '';
        grid.appendChild(el('div', 'aempty err', e.message));
      } finally { grid.classList.remove('loading'); }
    };
    const draw = () => {
      const t = el('table', 'dgrid');
      const hr = el('tr');
      for (const c of columns) {
        const th = el('th', null, c.label + (st.order === c.key ? (st.desc ? ' ▼' : ' ▲') : ''));
        if (c.sort === false) th.style.cursor = 'default';
        else th.onclick = () => { if (st.order === c.key) st.desc = !st.desc; else { st.order = c.key; st.desc = false; } st.offset = 0; load(); };
        hr.appendChild(th);
      }
      const thd = el('thead'); thd.appendChild(hr); t.appendChild(thd);
      const tb = el('tbody');
      for (const r of st.rows) {
        const tr = el('tr');
        for (const c of columns) {
          const td = el('td');
          const out = c.render ? c.render(r) : Kit.text(r[c.key]);
          if (out instanceof Node) td.appendChild(out); else td.textContent = out;
          tr.appendChild(td);
        }
        if (onRow) tr.onclick = (e) => { if (!e.target.closest('button,a,select,input')) onRow(r); };
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      grid.innerHTML = '';
      grid.appendChild(st.rows.length ? t : el('div', 'aempty', empty));
      pager.innerHTML = '';
      const to = st.offset + st.rows.length;
      pager.appendChild(el('span', 'muted', `${fmtNum(st.rows.length ? st.offset + 1 : 0)}–${fmtNum(to)} / ${st.total == null ? '?' : fmtNum(st.total)}`));
      const prev = el('button', '', '‹');
      prev.disabled = st.offset === 0;
      prev.onclick = () => { st.offset = Math.max(0, st.offset - st.size); load(); };
      const next = el('button', '', '›');
      next.disabled = st.total != null ? to >= st.total : st.rows.length < st.size;
      next.onclick = () => { st.offset += st.size; load(); };
      pager.append(prev, next);
    };
    load();
    return { reload: load, get total() { return st.total; } };
  },

  csv(name, columns, rows, val) {
    const cell = x => {
      const s = x == null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [columns.map(c => c.label).join(','), ...rows.map(r => columns.map(c => cell(val(c, r))).join(','))];
    const a = el('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }));
    a.download = `${name}.csv`;
    a.click();
  },

  /** Một bảng quản lý gọi hàm tt_admin_*:
   *  create / edit: {fields, fn, params(v, row), values(row)} · del: {fn, params(row), label(row)}
   *  toggles: [{label, get(row), fn, params(row, on)}] · actions(row) → [Node] · onChange() để tải lại. */
  section(parent, { title, desc, rows, columns, create, edit, del, toggles = [], actions, onChange, csvName, pageSize = 25, filter }) {
    const box = el('div', 'ksection');
    if (title) {
      const h = el('div', 'ksection__h');
      h.innerHTML = `<h3>${esc(title)}</h3><span class="muted">${fmtNum(rows.length)}</span>` + (desc ? `<p class="muted small">${desc}</p>` : '');
      if (create) {
        const b = Admin.writeOnly(el('button', 'go', create.label || '＋  Thêm'));
        b.onclick = () => Kit.formModal({
          title: `${create.label ? create.label.replace(/^＋\s*/, '') : 'Thêm'} — ${title}`,
          fields: create.fields, values: create.values ? create.values() : {}, okLabel: 'Thêm',
          onSubmit: async v => { await Kit.mustWrite(create.fn, create.params(v), { ok: 'Đã thêm' }); onChange && onChange(); },
        });
        h.appendChild(b);
      }
      box.appendChild(h);
    }
    const cols = columns.slice();
    for (const t of toggles) {
      cols.push({ key: '_t_' + t.label, label: t.label, sort: false, render: r => {
        const on = !!t.get(r);
        const b = Admin.writeOnly(el('button', on ? 'on' : 'ghost', on ? '● bật' : '○ tắt'));
        b.onclick = async () => {
          try { const ok = await Kit.write(t.fn, t.params(r, !on), { ok: 'Đã đổi' }); if (ok) onChange && onChange(); }
          catch (e) { toast(e.message, 'err'); }
        };
        return b;
      } });
    }
    if (edit || del || actions) {
      cols.push({ key: '_a', label: 'Thao tác', sort: false, render: r => {
        const d = el('div', 'btns');
        if (edit) {
          const b = Admin.writeOnly(el('button', '', '✎'));
          b.title = 'Sửa';
          b.onclick = () => Kit.formModal({
            title: `Sửa — ${title || ''}`, fields: edit.fields, values: edit.values ? edit.values(r) : r, okLabel: 'Lưu',
            onSubmit: async v => { await Kit.mustWrite(edit.fn, edit.params(v, r), { ok: 'Đã lưu' }); onChange && onChange(); },
          });
          d.appendChild(b);
        }
        if (actions) for (const n of actions(r)) d.appendChild(n);
        if (del) {
          const b = Admin.writeOnly(el('button', 'stop', '🗑'));
          b.title = 'Xoá';
          b.onclick = async () => {
            try {
              const ok = await Kit.write(del.fn, del.params(r), {
                confirm: `Xoá <b>${esc(del.label ? del.label(r) : (r.title || r.name || r.codename || r.id))}</b>?` + (del.note ? `<br><span class="muted">${del.note}</span>` : ''),
                ok: 'Đã xoá', danger: true,
              });
              if (ok) onChange && onChange();
            } catch (e) { toast(e.message, 'err'); }
          };
          d.appendChild(b);
        }
        return d;
      } });
    }
    let shown = rows;
    const toolbar = [];
    if (filter !== false && rows.length > 8) {
      const q = el('input', 'ainput');
      q.type = 'search';
      q.placeholder = '⌕  lọc…';
      q.oninput = () => {
        const s = q.value.trim().toLowerCase();
        shown = s ? rows.filter(r => JSON.stringify(r).toLowerCase().includes(s)) : rows;
        tbl.setRows(shown);
      };
      toolbar.push(q);
    }
    const tbl = Kit.table(box, { rows, columns: cols, pageSize, csvName, toolbar });
    parent.appendChild(box);
    return box;
  },

  /** Chọn từ một danh sách: [[giá trị, nhãn]]. */
  opts(rows, val = 'id', label = r => r.title || r.name || r.codename || r.id) {
    return rows.map(r => [r[val], `#${r[val]} ${label(r)}`]);
  },

  // ── tab ────────────────────────────────────────────────────────────
  tabs(parent, items, active) {
    const head = el('div', 'tabs');
    const body = el('div', 'ktabs__body');
    parent.append(head, body);
    const open = (id) => {
      for (const b of head.children) b.classList.toggle('on', b.dataset.id === id);
      body.innerHTML = '';
      const it = items.find(x => x.id === id);
      Promise.resolve(it.render(body)).catch(e => body.appendChild(el('div', 'aempty err', e.message)));
    };
    for (const it of items) {
      const b = el('button', null, it.label);
      b.dataset.id = it.id;
      b.onclick = () => open(it.id);
      head.appendChild(b);
    }
    open(active || items[0].id);
    return { open };
  },

  // ── form ───────────────────────────────────────────────────────────
  /** fields: [{key, label, type: text|email|password|number|int|select|bool|date|datetime|textarea|json,
   *            options: [[value, nhãn]] | [value], required, placeholder, help, min, max, full}] */
  form(fields, values = {}) {
    const node = el('div', 'kform');
    const inputs = {};
    for (const f of fields) {
      const box = el('div', 'kform__f' + (f.full || f.type === 'textarea' || f.type === 'json' || f.type === 'lines' ? ' full' : ''));
      const lab = el('label');
      lab.innerHTML = esc(f.label) + (f.required ? ' <span class="req">*</span>' : '');
      box.appendChild(lab);
      const v = values[f.key];
      let inp;
      if (f.type === 'select' || f.type === 'bool') {
        inp = el('select');
        const opts = f.type === 'bool' ? [['true', 'Có'], ['false', 'Không']] : (f.options || []);
        if (!f.required || f.type === 'bool') {
          const o = el('option', null, f.type === 'bool' ? '—' : '— không chọn —');
          o.value = '';
          inp.appendChild(o);
        }
        for (const o of opts) {
          const [val, label] = Array.isArray(o) ? o : [o, o];
          const n = el('option', null, label);
          n.value = String(val);
          inp.appendChild(n);
        }
        inp.value = v == null ? '' : String(v);
      } else if (f.type === 'textarea' || f.type === 'json' || f.type === 'lines') {
        inp = el('textarea');
        inp.rows = f.rows || 4;
        if (f.type === 'lines') inp.value = Array.isArray(v) ? v.join('\n') : (v == null ? '' : String(v));
        else inp.value = v == null ? '' : (f.type === 'json' && typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v));
      } else {
        inp = el('input');
        inp.type = { password: 'password', email: 'email', number: 'number', int: 'number', date: 'date', datetime: 'datetime-local' }[f.type] || 'text';
        if (f.min != null) inp.min = f.min;
        if (f.max != null) inp.max = f.max;
        if (f.type === 'int') inp.step = '1';
        let s = v == null ? '' : String(v);
        if (f.type === 'date' && s) s = s.slice(0, 10);
        if (f.type === 'datetime' && s) { const d = new Date(s); if (!isNaN(d)) s = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
        inp.value = s;
      }
      if (f.placeholder) inp.placeholder = f.placeholder;
      if (f.readonly) inp.disabled = true;
      box.appendChild(inp);
      if (f.help) box.appendChild(el('div', 'muted small', f.help));
      inputs[f.key] = inp;
      node.appendChild(box);
    }
    const read = () => {
      const out = {};
      for (const f of fields) {
        if (f.readonly) continue;
        const raw = inputs[f.key].value;
        const s = typeof raw === 'string' ? raw.trim() : raw;
        if (f.required && s === '') throw new Error(`Thiếu "${f.label}"`);
        let v;
        if (s === '') v = null;
        else if (f.type === 'number') { v = Number(s); if (Number.isNaN(v)) throw new Error(`"${f.label}" phải là số`); }
        else if (f.type === 'int') { if (!/^-?\d+$/.test(s)) throw new Error(`"${f.label}" phải là số nguyên`); v = Number(s); }
        else if (f.type === 'bool') v = s === 'true';
        else if (f.type === 'json') { try { v = JSON.parse(s); } catch { throw new Error(`"${f.label}" không phải JSON hợp lệ`); } }
        else if (f.type === 'lines') v = s.split('\n').map(x => x.trim()).filter(Boolean);
        else if (f.type === 'datetime') v = new Date(s).toISOString();
        else v = f.type === 'password' ? raw : s;
        if (v != null && f.min != null && typeof v === 'number' && v < f.min) throw new Error(`"${f.label}" tối thiểu ${f.min}`);
        if (v != null && f.max != null && typeof v === 'number' && v > f.max) throw new Error(`"${f.label}" tối đa ${f.max}`);
        if (f.validate) { const e = f.validate(v); if (e) throw new Error(e); }
        out[f.key] = v;
      }
      return out;
    };
    return { node, inputs, read };
  },

  /** Form trong modal; onSubmit(values) ném lỗi = hiện lỗi, giữ modal mở. */
  formModal({ title, fields, values, okLabel = 'Lưu', onSubmit, note, wide = '46rem' }) {
    const f = Kit.form(fields, values);
    const body = el('div');
    if (note) body.appendChild(el('div', 'muted small', note));
    body.appendChild(f.node);
    return modal({ title, body, okLabel, wide, onOk: async () => { await onSubmit(f.read()); } });
  },

  // ── ghi ────────────────────────────────────────────────────────────
  /** Đang chỉ xem thì hỏi bật ghi; trả true khi đã sẵn sàng ghi. */
  async ensureWrite() {
    if (Admin.canWrite) return true;
    await Admin.toggleWrite();
    return Admin.canWrite;
  },

  /** Gọi hàm ghi tt_admin_*: hỏi lại (nếu có confirm), báo kết quả. Trả kết quả hoặc null. */
  async write(fn, params, { confirm, ok = 'Đã lưu', danger = false } = {}) {
    if (confirm && !(await confirmModal(confirm, 'Thực hiện', danger))) return null;
    if (!(await Kit.ensureWrite())) return null;
    const r = await rpc(fn, params);
    if (ok) toast(ok);
    return r ?? true;
  },

  /** Như write() nhưng ném lỗi khi người dùng không bật ghi / huỷ — dùng trong form (giữ form mở). */
  async mustWrite(fn, params, opts = {}) {
    const r = await Kit.write(fn, params, opts);
    if (r === null) throw new Error('Chưa thực hiện — cần bật "Cho phép ghi"');
    return r;
  },
};

// ── biểu đồ / avatar dùng chung ─────────────────────────────────────────
/** Biểu đồ cột đứng (SVG) — data: [{label, value, sub}]. */
function columnChart(parent, data, { height = 170, unit = '' } = {}) {
  const box = el('div', 'kcol');
  const w = Math.max(data.length * 22, 300);
  const max = Math.max(1, ...data.map(d => d.value));
  const bw = w / data.length;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  for (let i = 0; i <= 4; i++) {
    const y = 4 + (height - 4) * i / 4;
    const ln = document.createElementNS(svgNS, 'line');
    Object.entries({ x1: 0, x2: w, y1: y, y2: y, class: 'grid' }).forEach(([k, v]) => ln.setAttribute(k, v));
    svg.appendChild(ln);
  }
  data.forEach((d, i) => {
    const h = d.value ? Math.max(2, (height - 6) * d.value / max) : 0;
    const r = document.createElementNS(svgNS, 'rect');
    Object.entries({ x: i * bw + bw * .18, y: height - h, width: bw * .64, height: h, rx: 2, class: 'bar' }).forEach(([k, v]) => r.setAttribute(k, v));
    const t = document.createElementNS(svgNS, 'title');
    t.textContent = `${d.label}: ${fmtNum(d.value)}${unit}${d.sub ? ' · ' + d.sub : ''}`;
    r.appendChild(t);
    svg.appendChild(r);
  });
  box.appendChild(svg);
  axisLabels(box, data.map((d, i) => [(i * bw + bw / 2) / w, d.label]));
  box.appendChild(el('div', 'kcol__max muted small', `cao nhất ${fmtNum(max)}${unit}`));
  parent.appendChild(box);
  return box;
}

/** Nhãn trục X bằng HTML (SVG kéo giãn preserveAspectRatio=none làm méo chữ).
    items: [[vị trí 0..1, nhãn]] — tự thưa ra cho khỏi chồng nhau. */
function axisLabels(box, items) {
  const row = el('div', 'kcol__x');
  if (!items.length) return;
  const step = Math.max(1, Math.ceil(items.length / 9));
  const idx = [];
  for (let i = 0; i < items.length; i += step) idx.push(i);
  const last = items.length - 1;
  if (idx[idx.length - 1] !== last) {
    if (idx.length > 1 && last - idx[idx.length - 1] < step / 2) idx.pop();
    idx.push(last);
  }
  idx.forEach(i => {
    const [pos, label] = items[i];
    const s = el('span', null, label);
    s.style.left = (pos * 100).toFixed(2) + '%';
    row.appendChild(s);
  });
  box.appendChild(row);
}

/** Biểu đồ đường (SVG) — data: [{label, value}]. Dùng cho số dư theo thời gian. */
function lineChart(parent, data, { height = 170, unit = '' } = {}) {
  const box = el('div', 'kcol');
  if (!data.length) { parent.appendChild(el('div', 'aempty', 'Chưa có dữ liệu.')); return box; }
  const w = Math.max(data.length * 14, 300);
  const vals = data.map(d => d.value);
  const max = Math.max(...vals, 0), min = Math.min(...vals, 0);
  const span = max - min || 1;
  const x = i => (data.length === 1 ? w / 2 : 6 + (w - 12) * i / (data.length - 1));
  const y = v => 6 + (height - 12) * (1 - (v - min) / span);
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const mk = (tag, attrs) => { const n = document.createElementNS(svgNS, tag); for (const [k2, v] of Object.entries(attrs)) n.setAttribute(k2, v); svg.appendChild(n); return n; };
  for (let i = 0; i <= 4; i++) mk('line', { x1: 0, x2: w, y1: 6 + (height - 12) * i / 4, y2: 6 + (height - 12) * i / 4, class: 'grid' });
  if (min < 0) mk('line', { x1: 0, x2: w, y1: y(0), y2: y(0), class: 'zero' });
  const pts = data.map((d, i) => `${x(i)},${y(d.value)}`).join(' ');
  mk('polygon', { points: `${x(0)},${y(Math.max(min, 0))} ${pts} ${x(data.length - 1)},${y(Math.max(min, 0))}`, class: 'area' });
  mk('polyline', { points: pts, class: 'line', fill: 'none' });
  data.forEach((d, i) => {
    // chấm = đoạn thẳng dài 0, nét tròn không co giãn → luôn tròn dù SVG bị kéo
    const c = mk('line', { x1: x(i), x2: x(i), y1: y(d.value), y2: y(d.value), class: 'dot' });
    const t = document.createElementNS(svgNS, 'title');
    t.textContent = `${d.label}: ${fmtNum(d.value)}${unit}`;
    c.appendChild(t);
  });
  box.appendChild(svg);
  axisLabels(box, data.map((d, i) => [x(i) / w, d.label]));
  box.appendChild(el('div', 'kcol__max muted small', `thấp nhất ${fmtNum(min)}${unit} · cao nhất ${fmtNum(max)}${unit}`));
  parent.appendChild(box);
  return box;
}

/** Ảnh đại diện tròn. `src` là URL đầy đủ hoặc đường dẫn trong bucket (status.avatar_base);
    không có ảnh / ảnh lỗi → chữ cái đầu của tên. */
Kit.avatar = function (src, name, size = 32) {
  const box = el('span', 'kavatar');
  box.style.width = box.style.height = size + 'px';
  box.style.fontSize = Math.round(size * 0.42) + 'px';
  const initial = () => {
    box.innerHTML = '';
    box.textContent = (String(name || '?').trim()[0] || '?').toUpperCase();
    box.classList.add('kavatar--txt');
  };
  const raw = String(src || '').trim();
  if (!raw) { initial(); return box; }
  const base = (Admin.status && Admin.status.avatar_base) || '';
  const url = /^(https?:)?\/\//i.test(raw) || raw.startsWith('data:') ? raw : (base ? base + raw.replace(/^\/+/, '') : '');
  if (!url) { initial(); return box; }
  const img = el('img');
  img.loading = 'lazy';
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.onerror = initial;
  img.src = url;
  box.appendChild(img);
  return box;
};
