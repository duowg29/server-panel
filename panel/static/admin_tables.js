/* Bảng dữ liệu — duyệt / lọc / sửa mọi bảng trên Supabase.
   Cấu trúc bảng đọc từ Supabase (không khai báo tay), nên bảng thêm sau cũng
   hiện ra ngay. Bảng có cột deletedAt thì xoá = xoá mềm, khôi phục được. */

const Tables = {
  schema: null,          // [{name, columns, pk, softDelete, writable}]
  view: null,            // trạng thái bảng đang mở

  async loadSchema(refresh = false) {
    if (this.schema && !refresh) return this.schema;
    const r = await api('/api/admin/schema' + (refresh ? '?refresh=1' : ''));
    this.schema = r.tables;
    return this.schema;
  },

  table(name) { return (this.schema || []).find(t => t.name === name); },

  // ── giá trị ↔ chuỗi ────────────────────────────────────────────────
  isJson(c) { return c.format === 'jsonb' || c.format === 'json' || (c.type !== 'string' && c.type !== 'integer' && c.type !== 'number' && c.type !== 'boolean'); },

  show(v) {
    if (v === null || v === undefined) return '∅';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  },

  parse(c, raw) {
    if (raw === '' || raw == null) return c.type === 'string' && !this.isJson(c) ? '' : null;
    if (c.type === 'integer') {
      if (!/^-?\d+$/.test(raw.trim())) throw new Error(`${c.name}: phải là số nguyên`);
      return Number(raw);
    }
    if (c.type === 'number') {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error(`${c.name}: phải là số`);
      return n;
    }
    if (c.type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : null;
    if (this.isJson(c)) {
      try { return JSON.parse(raw); } catch { throw new Error(`${c.name}: JSON không hợp lệ`); }
    }
    return raw;
  },

  // ── trang ──────────────────────────────────────────────────────────
  render(main, args) {
    const wrap = el('div', 'tables');
    const side = el('div', 'tables__side');
    const body = el('div', 'tables__body');
    wrap.append(side, body);
    main.appendChild(wrap);

    const find = el('input', 'ainput');
    find.type = 'search';
    find.placeholder = '⌕  tìm bảng…';
    const list = el('div', 'tables__list');
    const reload = el('button', 'ghost', '↻  Đọc lại cấu trúc');
    side.append(find, list, reload);

    const draw = () => {
      const q = find.value.trim().toLowerCase();
      list.innerHTML = '';
      for (const t of this.schema || []) {
        if (q && !t.name.toLowerCase().includes(q)) continue;
        const a = el('a', 'tables__item' + (t.name === args[0] ? ' on' : ''));
        a.href = `#/tables/${encodeURIComponent(t.name)}`;
        a.innerHTML = `${esc(t.name)}${t.writable ? '' : ' <span class="muted">view</span>'}`;
        list.appendChild(a);
      }
    };
    find.oninput = draw;
    reload.onclick = async () => {
      try { await this.loadSchema(true); draw(); toast('Đã đọc lại cấu trúc bảng'); }
      catch (e) { toast(e.message, 'err'); }
    };

    body.appendChild(el('div', 'aempty', 'Đang đọc cấu trúc…'));
    this.loadSchema().then(() => {
      draw();
      body.innerHTML = '';
      if (args[0]) this.openTable(body, args[0]);
      else body.appendChild(el('div', 'aempty',
        `${(this.schema || []).length} bảng. Chọn một bảng bên trái để xem dữ liệu.`));
    }).catch(e => { body.innerHTML = ''; body.appendChild(el('div', 'aempty err', e.message)); });
  },

  openTable(body, name) {
    const t = this.table(name);
    if (!t) { body.appendChild(el('div', 'aempty', `Không có bảng '${name}'.`)); return; }
    const v = this.view = {
      t, body, offset: 0, limit: 50, order: null, desc: false, q: '',
      deleted: 'active', filters: [], rows: [], total: null,
    };
    const pf = this.pendingFilter;
    this.pendingFilter = null;
    if (pf && pf.table === name) v.filters.push({ col: pf.col, op: pf.op, val: pf.val });

    const head = el('div', 'tables__head');
    head.innerHTML = `<h2>${esc(t.name)}</h2>
      <span class="muted">${t.columns.length} cột · khoá chính: ${esc(t.pk.join(', ') || 'không có')}
      ${t.softDelete ? ' · xoá mềm (deletedAt)' : ''}${t.writable ? '' : ' · chỉ đọc (view)'}</span>`;
    body.appendChild(head);

    const bar = el('div', 'tables__bar');
    const q = el('input', 'ainput');
    q.type = 'search';
    q.placeholder = '⌕  tìm trong các cột chữ (hoặc số id)…';
    let qt;
    q.oninput = () => { clearTimeout(qt); qt = setTimeout(() => { v.q = q.value; v.offset = 0; this.load(); }, 350); };
    bar.appendChild(q);
    if (t.softDelete) {
      const sel = el('select', 'ainput');
      sel.innerHTML = '<option value="active">đang dùng</option><option value="deleted">đã xoá</option><option value="all">tất cả</option>';
      sel.onchange = () => { v.deleted = sel.value; v.offset = 0; this.load(); };
      bar.appendChild(sel);
    }
    const addF = el('button', '', '＋  Bộ lọc');
    addF.onclick = () => this.filterModal();
    const csv = el('button', '', '⇩  CSV');
    csv.onclick = () => this.exportCsv();
    const refresh = el('button', '', '↻');
    refresh.title = 'Tải lại';
    refresh.onclick = () => this.load();
    bar.append(addF, csv, refresh);
    if (t.writable) {
      const add = Admin.writeOnly(el('button', 'go', '＋  Thêm dòng'));
      add.onclick = () => this.rowModal(null);
      bar.appendChild(add);
    }
    body.appendChild(bar);

    v.chips = el('div', 'tables__chips');
    body.appendChild(v.chips);
    v.grid = el('div', 'dgrid-wrap');
    body.appendChild(v.grid);
    v.pager = el('div', 'tables__pager');
    body.appendChild(v.pager);
    this.load();
  },

  async load() {
    const v = this.view;
    if (!v) return;
    const p = new URLSearchParams({ limit: v.limit, offset: v.offset, deleted: v.deleted });
    if (v.order) { p.set('order', v.order); if (v.desc) p.set('desc', '1'); }
    if (v.q.trim()) p.set('q', v.q.trim());
    for (const f of v.filters) p.append('f', `${f.col}|${f.op}|${f.val}`);
    v.grid.classList.add('loading');
    try {
      const r = await api(`/api/admin/tables/${encodeURIComponent(v.t.name)}/rows?${p}`);
      if (this.view !== v) return;
      v.rows = r.rows;
      v.total = r.total;
      this.drawGrid();
    } catch (e) {
      v.grid.innerHTML = '';
      v.grid.appendChild(el('div', 'aempty err', e.message));
    } finally { v.grid.classList.remove('loading'); }
  },

  drawGrid() {
    const v = this.view;
    const t = v.t;
    // bộ lọc đang áp
    v.chips.innerHTML = '';
    v.filters.forEach((f, i) => {
      const c = el('span', 'fchip', `${f.col} ${f.op} ${f.val}`);
      const x = el('button', 'ghost', '✕');
      x.onclick = () => { v.filters.splice(i, 1); v.offset = 0; this.load(); };
      c.appendChild(x);
      v.chips.appendChild(c);
    });

    const tbl = el('table', 'dgrid');
    const thead = el('tr');
    for (const c of t.columns) {
      const th = el('th');
      th.textContent = c.name + (v.order === c.name ? (v.desc ? ' ▼' : ' ▲') : '');
      th.title = `${c.type}${c.format ? ' / ' + c.format : ''}${c.pk ? ' · khoá chính' : ''}${c.fk ? ` · → ${c.fk.table}.${c.fk.column}` : ''}`;
      if (c.pk) th.classList.add('pk');
      th.onclick = () => {
        if (v.order === c.name) v.desc = !v.desc; else { v.order = c.name; v.desc = false; }
        v.offset = 0;
        this.load();
      };
      thead.appendChild(th);
    }
    const thd = el('thead');
    thd.appendChild(thead);
    tbl.appendChild(thd);
    const tb = el('tbody');
    for (const row of v.rows) {
      const tr = el('tr');
      if (t.softDelete && row.deletedAt) tr.classList.add('deleted');
      for (const c of t.columns) {
        const td = el('td');
        const s = this.show(row[c.name]);
        td.textContent = s.length > 80 ? s.slice(0, 80) + '…' : s;
        if (row[c.name] === null || row[c.name] === undefined) td.classList.add('nul');
        if (c.fk && row[c.name] != null) {
          td.classList.add('fk');
          td.title = `Mở ${c.fk.table} có ${c.fk.column} = ${row[c.name]}`;
          td.onclick = (e) => {
            e.stopPropagation();
            // bảng đích mở ra là lọc sẵn theo khoá ngoại
            this.pendingFilter = { table: c.fk.table, col: c.fk.column, op: 'eq', val: String(row[c.name]) };
            location.hash = `#/tables/${encodeURIComponent(c.fk.table)}`;
          };
        }
        tr.appendChild(td);
      }
      tr.onclick = () => this.rowModal(row);
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    v.grid.innerHTML = '';
    if (!v.rows.length) v.grid.appendChild(el('div', 'aempty', 'Không có dòng nào.'));
    else v.grid.appendChild(tbl);

    // phân trang
    v.pager.innerHTML = '';
    const from = v.rows.length ? v.offset + 1 : 0;
    const to = v.offset + v.rows.length;
    const info = el('span', 'muted', `${fmtNum(from)}–${fmtNum(to)} / ${v.total == null ? '?' : fmtNum(v.total)} dòng`);
    const prev = el('button', '', '‹  Trước');
    prev.disabled = v.offset === 0;
    prev.onclick = () => { v.offset = Math.max(0, v.offset - v.limit); this.load(); };
    const next = el('button', '', 'Sau  ›');
    next.disabled = v.total != null ? to >= v.total : v.rows.length < v.limit;
    next.onclick = () => { v.offset += v.limit; this.load(); };
    const size = el('select', 'ainput');
    for (const n of [25, 50, 100, 200, 500]) {
      const o = el('option', null, `${n} / trang`);
      o.value = n;
      if (n === v.limit) o.selected = true;
      size.appendChild(o);
    }
    size.onchange = () => { v.limit = Number(size.value); v.offset = 0; this.load(); };
    v.pager.append(info, prev, next, size);
  },

  filterModal() {
    const v = this.view;
    const body = el('div');
    body.innerHTML = `
      <label>Cột</label><select class="f-col">${v.t.columns.map(c => `<option>${esc(c.name)}</option>`).join('')}</select>
      <label>Phép</label><select class="f-op">
        <option value="eq">= bằng</option><option value="neq">≠ khác</option>
        <option value="ilike">chứa (không phân biệt hoa thường)</option>
        <option value="gt">&gt;</option><option value="gte">≥</option><option value="lt">&lt;</option><option value="lte">≤</option>
        <option value="is">là (null / true / false)</option></select>
      <label>Giá trị</label><input class="f-val" placeholder="vd: 42, a1, null">`;
    modal({
      title: 'Thêm bộ lọc', body, okLabel: 'Lọc',
      onOk: (m) => {
        const col = m.querySelector('.f-col').value;
        const op = m.querySelector('.f-op').value;
        let val = m.querySelector('.f-val').value.trim();
        if (op === 'ilike' && !val.includes('*')) val = `*${val}*`;
        if (op === 'is' && !['null', 'true', 'false'].includes(val)) throw new Error('Phép "là" chỉ nhận null / true / false');
        v.filters.push({ col, op, val });
        v.offset = 0;
        this.load();
      },
    });
  },

  rowModal(row) {
    const v = this.view;
    const t = v.t;
    const isNew = row == null;
    const form = el('div', 'rowform');
    const inputs = new Map();
    for (const c of t.columns) {
      const f = el('div', 'rowform__f');
      const lab = el('label');
      lab.innerHTML = `${esc(c.name)} <span class="muted">${esc(c.format || c.type)}${c.pk ? ' · khoá chính' : ''}${c.required ? ' · bắt buộc' : ''}</span>`;
      f.appendChild(lab);
      const val = isNew ? (c.default !== undefined ? undefined : null) : row[c.name];
      let inp;
      if (c.type === 'boolean') {
        inp = el('select');
        inp.innerHTML = '<option value="">∅ null</option><option value="true">true</option><option value="false">false</option>';
        inp.value = val === true ? 'true' : val === false ? 'false' : '';
      } else if (c.enum) {
        inp = el('select');
        inp.innerHTML = '<option value="">∅ null</option>' + c.enum.map(e => `<option>${esc(e)}</option>`).join('');
        inp.value = val ?? '';
      } else if (this.isJson(c) || (typeof val === 'string' && val.length > 80)) {
        inp = el('textarea');
        inp.rows = this.isJson(c) ? 4 : 3;
        inp.value = val == null ? '' : (typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val));
      } else {
        inp = el('input');
        inp.value = val == null ? '' : String(val);
      }
      if (isNew && c.default !== undefined) inp.placeholder = `mặc định: ${c.default}`;
      inp.classList.add('w-input');
      f.appendChild(inp);
      if (c.fk) f.appendChild(el('div', 'muted small', `→ ${c.fk.table}.${c.fk.column}`));
      form.appendChild(f);
      inputs.set(c.name, inp);
    }

    const extra = [];
    if (!isNew && t.writable) {
      if (t.softDelete && row.deletedAt) {
        const rs = Admin.writeOnly(el('button', 'go', '↺  Khôi phục'));
        rs.onclick = async () => {
          try {
            await api(`/api/admin/tables/${t.name}/restore`, { method: 'POST', body: JSON.stringify({ pk: this.pkOf(row) }) });
            toast('Đã khôi phục');
            m.close();
            this.load();
          } catch (e) { toast(e.message, 'err'); }
        };
        extra.push(rs);
      } else {
        const del = Admin.writeOnly(el('button', 'stop', t.softDelete ? '🗑  Xoá (mềm)' : '🗑  Xoá'));
        del.onclick = () => this.deleteRow(row, m);
        extra.push(del);
      }
    }
    const raw = el('button', 'ghost', '{ } JSON');
    raw.onclick = () => modal({ title: `${t.name} — JSON`, bodyHTML: `<pre>${esc(JSON.stringify(row, null, 2))}</pre>`, wide: true });
    if (!isNew) extra.push(raw);

    const canSave = t.writable && Admin.canWrite;
    const m = modal({
      title: isNew ? `Thêm dòng — ${t.name}` : `${t.name} — ${t.pk.map(k => `${k}=${row[k]}`).join(', ') || 'dòng'}`,
      body: form, wide: '52rem', extra,
      okLabel: isNew ? 'Thêm' : 'Lưu thay đổi',
      onOk: canSave ? async () => {
        if (isNew) {
          const out = {};
          for (const c of t.columns) {
            const inp = inputs.get(c.name);
            if (inp.value === '' && (c.default !== undefined || !c.required)) continue;
            out[c.name] = this.parse(c, inp.value);
          }
          await api(`/api/admin/tables/${t.name}/rows`, { method: 'POST', body: JSON.stringify({ row: out }) });
          toast('Đã thêm dòng');
        } else {
          const changes = {};
          for (const c of t.columns) {
            const nv = this.parse(c, inputs.get(c.name).value);
            if (JSON.stringify(nv) !== JSON.stringify(row[c.name] ?? (c.type === 'string' && !this.isJson(c) ? '' : null))) changes[c.name] = nv;
          }
          if (!Object.keys(changes).length) { toast('Không có gì thay đổi'); return; }
          const ok = await confirmModal(`Lưu ${Object.keys(changes).length} thay đổi vào <b>${esc(t.name)}</b>?<pre>${esc(JSON.stringify(changes, null, 2))}</pre>`, 'Lưu');
          if (!ok) return true;
          await api(`/api/admin/tables/${t.name}/rows`, { method: 'PATCH', body: JSON.stringify({ pk: this.pkOf(row), changes }) });
          toast('Đã lưu');
        }
        this.load();
      } : null,
    });
    if (!canSave) {
      for (const inp of inputs.values()) inp.disabled = true;
      const note = el('div', 'muted small',
        t.writable ? 'Đang ở chế độ chỉ xem — bật "Cho phép ghi" để sửa.' : 'View chỉ đọc.');
      form.prepend(note);
    }
  },

  pkOf(row) {
    const pk = {};
    for (const k of this.view.t.pk) pk[k] = row[k];
    return pk;
  },

  async deleteRow(row, m) {
    const t = this.view.t;
    const soft = t.softDelete;
    const ok = await confirmModal(
      `${soft ? 'Xoá mềm' : '<b>Xoá hẳn</b>'} dòng <b>${esc(t.pk.map(k => `${k}=${row[k]}`).join(', '))}</b> trong ${esc(t.name)}?` +
      (soft ? '<br><span class="muted">Đặt deletedAt — khôi phục được.</span>' : '<br><span class="err">Không khôi phục được (trừ từ nhật ký).</span>'),
      soft ? 'Xoá' : 'Xoá hẳn', true);
    if (!ok) return;
    try {
      await api(`/api/admin/tables/${t.name}/rows`, { method: 'DELETE', body: JSON.stringify({ pk: this.pkOf(row) }) });
      toast(soft ? 'Đã xoá mềm' : 'Đã xoá');
      m.close();
      this.load();
    } catch (e) { toast(e.message, 'err'); }
  },

  exportCsv() {
    const v = this.view;
    const cols = v.t.columns.map(c => c.name);
    const cell = x => {
      const s = x == null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(','), ...v.rows.map(r => cols.map(c => cell(r[c])).join(','))];
    const a = el('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' }));
    a.download = `${v.t.name}_${v.offset + 1}-${v.offset + v.rows.length}.csv`;
    a.click();
    toast(`Đã xuất ${v.rows.length} dòng đang hiện`);
  },

  onWriteChange() { /* nút w-only tự đổi qua CSS body.can-write */ },
};

Admin.register({
  id: 'tables', title: 'Bảng dữ liệu', icon: '▦', group: 'Công cụ', order: 90,
  render: (main, args) => Tables.render(main, args),
  onWriteChange: () => Tables.onWriteChange(),
});
