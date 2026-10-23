/* Nội dung học — chuyển từ tinytalk-admin (pages/user-management/lesson-content.tsx).

   Theo cấu trúc bảng THẬT trên Supabase. Một số hàm tt_admin_lesson_* /
   tt_admin_topic_* đã lệch cấu trúc (grammar không còn formula/explanation…,
   topic không có displayOrder) nên đọc và ghi lộ trình / topic / từ vựng /
   ngữ pháp đi thẳng vào bảng; unit và nội dung unit vẫn dùng hàm tt_admin_unit_*
   (còn đúng). Xoá luôn là xoá mềm theo chuỗi như bản cũ:
   lộ trình → topic → unit → nội dung unit; xoá từ vựng / ngữ pháp / game thì gỡ
   các liên kết tới nó. */

const CEFR = ['prestart', 'a1', 'a2', 'b1', 'b2', 'c1', 'c2'];
const CONTENT_TYPES = [['vocabulary', 'Từ vựng'], ['grammar', 'Ngữ pháp'], ['game', 'Game']];
const CONTENT_TABLE = { vocabulary: ['vocabulary', 'word'], grammar: ['grammar', 'title'], game: ['game', 'title'] };

const POS = ['noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'conjunction', 'determiner', 'interjection', 'phrase', 'phrasal verb', 'idiom'];

/* Định dạng từ vựng trên Supabase (đo từ dữ liệu thật):
     meaning {"vi": "…"}  ·  phonetic {"en_us": "/…/"}  ·  partOfSpeech ["noun"]
     example [{"sentence": "…", "sentence_vi": "…"}]
   Vài dòng cũ (quét OCR) dạng danh sách chuỗi — đọc được, lưu lại thì về dạng chuẩn. */
const V = {
  meaning: v => (v && typeof v === 'object' && !Array.isArray(v) ? v.vi : Array.isArray(v) ? v[0] : v) || '',
  phonetic: v => (v && typeof v === 'object' && !Array.isArray(v) ? v.en_us : Array.isArray(v) ? v[0] : v) || '',
  pos: v => (Array.isArray(v) ? v[0] : v) || '',
  examples: v => (Array.isArray(v) ? v : []).map(x => (typeof x === 'object' && x
    ? `${x.sentence || ''}${x.sentence_vi ? ' | ' + x.sentence_vi : ''}` : String(x))).join('\n'),
  parseExamples: s => s.split('\n').map(x => x.trim()).filter(Boolean).map(line => {
    const [sentence, vi] = line.split('|').map(x => x.trim());
    return vi ? { sentence, sentence_vi: vi } : { sentence, sentence_vi: '' };
  }),
};

/** Đọc hết một bảng nhỏ (đang dùng), tối đa 2000 dòng. */
async function allRows(table, { order = 'id', f = [] } = {}) {
  const out = [];
  for (let offset = 0; offset < 2000; offset += 500) {
    const p = new URLSearchParams({ limit: 500, offset, order });
    for (const x of f) p.append('f', x);
    const r = await api(`/api/admin/tables/${table}/rows?${p}`);
    out.push(...r.rows);
    if (r.rows.length < 500) break;
  }
  return out;
}

const Lessons = {
  sel: { path: null, topic: null, unit: null },

  async render(main) {
    const bar = pageHead(main, 'Quản lý nội dung bài học',
      'Lộ trình → topic → unit → nội dung (từ vựng / ngữ pháp / game). Xoá là xoá mềm theo chuỗi.');
    const weight = Admin.writeOnly(el('button', '', '⚖  Phân bổ trọng số'));
    weight.onclick = () => this.weightModal();
    const bulk = Admin.writeOnly(el('button', '', '⇪  Nhập hàng loạt'));
    bulk.onclick = () => this.bulkModal();
    const scan = el('button', '', '📄  Quét tài liệu');
    scan.onclick = () => this.scanModal();
    const reload = el('button', '', '↻  Tải lại');
    reload.onclick = () => { main.innerHTML = ''; this.render(main); };
    bar.append(scan, weight, bulk, reload);

    const kp = el('div');
    main.appendChild(kp);
    this.kpis(kp);
    Kit.tabs(main, [
      { id: 'tree', label: 'Cây nội dung', render: b => this.tree(b) },
      { id: 'vocab', label: 'Từ vựng', render: b => this.vocabTab(b) },
      { id: 'grammar', label: 'Ngữ pháp', render: b => this.grammarTab(b) },
      { id: 'games', label: 'Game', render: b => this.gameTab(b) },
    ]);
  },

  async kpis(box) {
    const names = [['learning_path', 'Lộ trình'], ['topic', 'Topic'], ['unit', 'Unit'], ['unit_content', 'Nội dung unit'],
      ['vocabulary', 'Từ vựng'], ['grammar', 'Ngữ pháp'], ['game', 'Game']];
    const [totals, eff] = await Promise.all([
      Promise.all(names.map(([t]) => api(`/api/admin/tables/${t}/rows?limit=1`).then(r => r.total).catch(() => null))),
      // "hiệu quả học" như trang cũ: nội dung đã học xong + từ đã thành thạo (toàn hệ thống)
      rpc('tt_admin_lesson_effective_stats').catch(() => null),
    ]);
    box.innerHTML = '';
    Kit.kpis(box, [
      ...names.map(([, label], i) => ({ label, value: fmtNum(totals[i]) })),
      { label: 'Lượt học xong nội dung', value: eff ? fmtNum(eff.completedCount) : '—', sub: 'mọi học sinh cộng lại' },
      { label: 'Từ đã thành thạo', value: eff ? fmtNum(eff.masteredCount) : '—', sub: 'mọi học sinh cộng lại' },
    ]);
  },

  // ── cây nội dung ───────────────────────────────────────────────────
  async tree(b) {
    b.appendChild(el('div', 'aempty', 'Đang tải cây nội dung…'));
    const [paths, topics, units] = await Promise.all([
      allRows('learning_path'), allRows('topic'), allRows('unit', { order: 'displayOrder' }),
    ]);
    this.data = { paths, topics, units };
    b.innerHTML = '';
    const cols = el('div', 'ktree');
    b.appendChild(cols);
    const content = el('div', 'kunit');
    b.appendChild(content);
    const self = this;

    const column = (title, items, { label, key, onPick, onAdd, onEdit, onDelete, sub }) => {
      const c = el('div', 'ktree__col');
      const h = el('div', 'ktree__h');
      h.innerHTML = `<b>${esc(title)}</b><span class="muted">${items.length}</span>`;
      if (onAdd) {
        const a = Admin.writeOnly(el('button', 'ghost', '＋'));
        a.title = 'Thêm';
        a.onclick = onAdd;
        h.appendChild(a);
      }
      c.appendChild(h);
      const list = el('div', 'ktree__list');
      for (const it of items) {
        const row = el('div', 'ktree__it' + (self.sel[key] === it.id ? ' on' : ''));
        row.innerHTML = `<span class="t">${esc(label(it))}</span>${sub ? `<span class="muted s">${esc(sub(it))}</span>` : ''}`;
        row.onclick = () => onPick(it);
        const tools = el('span', 'ktree__tools');
        const e = Admin.writeOnly(el('button', 'ghost', '✎'));
        e.onclick = (ev) => { ev.stopPropagation(); onEdit(it); };
        const d = Admin.writeOnly(el('button', 'ghost', '🗑'));
        d.onclick = (ev) => { ev.stopPropagation(); onDelete(it); };
        tools.append(e, d);
        row.appendChild(tools);
        list.appendChild(row);
      }
      if (!items.length) list.appendChild(el('div', 'muted small', '— trống —'));
      c.appendChild(list);
      cols.appendChild(c);
    };

    const redraw = () => {
      cols.innerHTML = '';
      const { paths, topics, units } = this.data;
      column('Lộ trình', paths, {
        key: 'path', label: p => p.title, sub: p => `#${p.id} · ${p.targetLevelMin || '?'}–${p.targetLevelMax || '?'}`,
        onPick: p => { this.sel = { path: p.id, topic: null, unit: null }; redraw(); },
        onAdd: () => this.pathModal(null, refresh), onEdit: p => this.pathModal(p, refresh),
        onDelete: p => this.cascadeDelete('learning_path', p.id, p.title, refresh),
      });
      const tps = topics.filter(t => t.learningPathId === this.sel.path);
      column('Topic', this.sel.path ? tps : [], {
        key: 'topic', label: t => t.title, sub: t => `#${t.id} · ${t.wordCount ?? 0} từ · ${t.grammarCount ?? 0} ngữ pháp`,
        onPick: t => { this.sel.topic = t.id; this.sel.unit = null; redraw(); },
        onAdd: this.sel.path ? () => this.topicModal(null, refresh) : null, onEdit: t => this.topicModal(t, refresh),
        onDelete: t => this.cascadeDelete('topic', t.id, t.title, refresh),
      });
      const uns = units.filter(u => u.topicId === this.sel.topic);
      column('Unit', this.sel.topic ? uns : [], {
        key: 'unit', label: u => u.unitName, sub: u => `#${u.id} · thứ tự ${u.displayOrder ?? '—'}`,
        onPick: u => { this.sel.unit = u.id; redraw(); },
        onAdd: this.sel.topic ? () => this.unitModal(null, refresh) : null, onEdit: u => this.unitModal(u, refresh),
        onDelete: u => this.unitDelete(u, refresh),
      });
      this.unitContents(content);
    };
    const refresh = async () => {
      const [paths, topics, units] = await Promise.all([allRows('learning_path'), allRows('topic'), allRows('unit', { order: 'displayOrder' })]);
      this.data = { paths, topics, units };
      redraw();
    };
    redraw();
  },

  async unitContents(box) {
    box.innerHTML = '';
    const uid = this.sel.unit;
    if (!uid) { box.appendChild(el('div', 'aempty', 'Chọn một unit để xem / sắp xếp nội dung của nó.')); return; }
    const unit = this.data.units.find(u => u.id === uid);
    const h = el('div', 'apage__head');
    h.innerHTML = `<h2>Nội dung unit — ${esc(unit ? unit.unitName : uid)}</h2>`;
    const bar = el('div', 'apage__bar');
    const add = Admin.writeOnly(el('button', 'go', '＋  Gắn nội dung'));
    add.onclick = () => this.attachModal(uid, () => this.unitContents(box));
    bar.appendChild(add);
    h.appendChild(bar);
    box.appendChild(h);
    const rows = await allRows('unit_content', { order: 'displayOrder', f: [`unitId|eq|${uid}`] });
    // tên của từng mục được gắn
    const names = {};
    for (const [type, [table, col]] of Object.entries(CONTENT_TABLE)) {
      const ids = [...new Set(rows.filter(r => r.contentType === type).map(r => r.contentRefId))];
      if (!ids.length) continue;
      const r = await api(`/api/admin/tables/${table}/rows?limit=500&deleted=all&f=${encodeURIComponent(`id|in|${ids.join(',')}`)}`);
      for (const x of r.rows) names[`${type}:${x.id}`] = x[col] + (x.deletedAt ? ' (đã xoá)' : '');
    }
    const move = async (i, d) => {
      const ids = rows.map(r => r.id);
      const j = i + d;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      try {
        const ok = await Kit.write('tt_admin_unit_content_reorder', { p_unit_id: uid, p_ordered_ids: ids }, { ok: 'Đã đổi thứ tự' });
        if (ok) this.unitContents(box);
      } catch (e) { toast(e.message, 'err'); }
    };
    Kit.table(box, {
      rows, pageSize: 100, empty: 'Unit này chưa có nội dung.',
      columns: [
        { key: 'displayOrder', label: '#', render: r => Kit.text(r.displayOrder) },
        { key: 'contentType', label: 'Loại', render: r => Kit.badge((CONTENT_TYPES.find(t => t[0] === r.contentType) || [0, r.contentType])[1]) },
        { key: 'contentRefId', label: 'Mục', value: r => names[`${r.contentType}:${r.contentRefId}`], render: r => `${names[`${r.contentType}:${r.contentRefId}`] || '?'}  (#${r.contentRefId})` },
        { key: 'isRequired', label: 'Bắt buộc', render: r => {
          const s = Admin.writeOnly(el('select', 'ainput'));
          s.innerHTML = '<option value="true">bắt buộc</option><option value="false">tuỳ chọn</option>';
          s.value = String(r.isRequired !== false);
          s.onchange = async () => {
            try {
              if (!(await Kit.ensureWrite())) { s.value = String(r.isRequired !== false); return; }
              await api('/api/admin/tables/unit_content/rows', { method: 'PATCH', body: JSON.stringify({ pk: { id: r.id }, changes: { isRequired: s.value === 'true' } }) });
              toast('Đã lưu');
            } catch (e) { toast(e.message, 'err'); }
          };
          return s;
        } },
        { key: '_m', label: 'Thứ tự / xoá', sort: false, render: r => {
          const i = rows.indexOf(r);
          const d = el('div', 'btns');
          const up = Admin.writeOnly(el('button', '', '↑')); up.disabled = i === 0; up.onclick = () => move(i, -1);
          const dn = Admin.writeOnly(el('button', '', '↓')); dn.disabled = i === rows.length - 1; dn.onclick = () => move(i, 1);
          const del = Admin.writeOnly(el('button', 'stop', '🗑'));
          del.title = 'Gỡ khỏi unit';
          del.onclick = async () => {
            try {
              const ok = await Kit.write('tt_admin_unit_content_delete', { p_unit_content_id: r.id },
                { confirm: 'Gỡ nội dung này khỏi unit? (xoá mềm liên kết, không xoá mục gốc)', ok: 'Đã gỡ', danger: true });
              if (ok) this.unitContents(box);
            } catch (e) { toast(e.message, 'err'); }
          };
          d.append(up, dn, del);
          return d;
        } },
      ],
    });
  },

  attachModal(uid, done) {
    const body = el('div');
    body.innerHTML = '<label>Loại nội dung</label>';
    const type = el('select');
    type.innerHTML = CONTENT_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    const q = el('input');
    q.placeholder = 'gõ để tìm (từ, tiêu đề hoặc id)…';
    const res = el('div', 'kpick');
    body.append(type, el('label', null, 'Tìm mục'), q, res);
    let chosen = null;
    let timer;
    const search = async () => {
      const [table, col] = CONTENT_TABLE[type.value];
      const p = new URLSearchParams({ limit: 20, order: 'id', desc: '1' });
      if (q.value.trim()) p.set('q', q.value.trim());
      const r = await api(`/api/admin/tables/${table}/rows?${p}`);
      res.innerHTML = '';
      for (const x of r.rows) {
        const it = el('div', 'kpick__it' + (chosen && chosen.id === x.id ? ' on' : ''), `#${x.id}  ${x[col]}${x.level ? '  · ' + x.level : ''}`);
        it.onclick = () => { chosen = x; for (const n of res.children) n.classList.remove('on'); it.classList.add('on'); };
        res.appendChild(it);
      }
      if (!r.rows.length) res.appendChild(el('div', 'muted small', 'Không thấy mục nào.'));
    };
    q.oninput = () => { clearTimeout(timer); timer = setTimeout(search, 300); };
    type.onchange = () => { chosen = null; search(); };
    search();
    modal({
      title: 'Gắn nội dung vào unit', body, okLabel: 'Gắn',
      onOk: async () => {
        if (!chosen) throw new Error('Chọn một mục trong danh sách');
        await Kit.mustWrite('tt_admin_unit_content_create', { p_unit_id: uid, p_content_type: type.value, p_content_ref_id: chosen.id }, { ok: 'Đã gắn vào unit' });
        done();
      },
    });
  },

  // ── form từng loại ─────────────────────────────────────────────────
  async saveRow(table, row, values, done, okMsg) {
    if (!(await Kit.ensureWrite())) throw new Error('Chưa thực hiện — cần bật "Cho phép ghi"');
    if (row) {
      const changes = {};
      for (const [k, v] of Object.entries(values)) if (JSON.stringify(v) !== JSON.stringify(row[k] ?? null)) changes[k] = v;
      if (!Object.keys(changes).length) { toast('Không có gì thay đổi'); return; }
      await api(`/api/admin/tables/${table}/rows`, { method: 'PATCH', body: JSON.stringify({ pk: { id: row.id }, changes }) });
    } else {
      await api(`/api/admin/tables/${table}/rows`, { method: 'POST', body: JSON.stringify({ row: values, autoId: true }) });
    }
    toast(okMsg || 'Đã lưu');
    done && done();
  },

  pathModal(p, done) {
    Kit.formModal({
      title: p ? `Sửa lộ trình #${p.id}` : 'Thêm lộ trình', values: p || {},
      fields: [
        { key: 'title', label: 'Tên lộ trình / sách', type: 'text', required: true, full: true },
        { key: 'description', label: 'Mô tả', type: 'textarea', rows: 2 },
        { key: 'targetLevelMin', label: 'Cấp từ', type: 'select', options: CEFR },
        { key: 'targetLevelMax', label: 'Cấp đến', type: 'select', options: CEFR },
        { key: 'totalSteps', label: 'Số bước', type: 'int', min: 0 },
        { key: 'thumbnailURL', label: 'Ảnh bìa (URL)', type: 'text' },
      ],
      onSubmit: v => this.saveRow('learning_path', p, v, done),
    });
  },

  topicModal(t, done) {
    Kit.formModal({
      title: t ? `Sửa topic #${t.id}` : 'Thêm topic', values: t || { learningPathId: this.sel.path, tags: [] },
      fields: [
        { key: 'learningPathId', label: 'Thuộc lộ trình', type: 'select', required: true, options: this.data.paths.map(p => [p.id, `#${p.id} ${p.title}`]) },
        { key: 'title', label: 'Tên topic', type: 'text', required: true },
        { key: 'description', label: 'Mô tả', type: 'textarea', rows: 2 },
        { key: 'targetLevelMin', label: 'Cấp từ', type: 'select', options: CEFR },
        { key: 'targetLevelMax', label: 'Cấp đến', type: 'select', options: CEFR },
        { key: 'iconURL', label: 'Icon (URL)', type: 'text' },
        { key: 'tags', label: 'Tags (mỗi dòng một tag)', type: 'lines', rows: 2 },
      ],
      onSubmit: v => this.saveRow('topic', t, { ...v, learningPathId: Number(v.learningPathId) }, done),
    });
  },

  unitModal(u, done) {
    Kit.formModal({
      title: u ? `Sửa unit #${u.id}` : 'Thêm unit', values: u || {},
      fields: [
        { key: 'unitName', label: 'Tên unit', type: 'text', required: true },
        { key: 'displayOrder', label: 'Thứ tự', type: 'int', min: 0, help: 'Để trống = cuối danh sách' },
      ],
      onSubmit: async (v) => {
        if (u) await Kit.mustWrite('tt_admin_unit_update', { p_unit_id: u.id, p_name: v.unitName, p_order_index: v.displayOrder }, { ok: 'Đã lưu unit' });
        else await Kit.mustWrite('tt_admin_unit_create', { p_topic_id: this.sel.topic, p_name: v.unitName, p_order_index: v.displayOrder }, { ok: 'Đã thêm unit' });
        done();
      },
    });
  },

  async unitDelete(u, done) {
    try {
      const ok = await Kit.write('tt_admin_unit_delete', { p_unit_id: u.id },
        { confirm: `Xoá unit <b>${esc(u.unitName)}</b> và nội dung gắn trong nó? (xoá mềm)`, ok: 'Đã xoá unit', danger: true });
      if (ok) { if (this.sel.unit === u.id) this.sel.unit = null; done(); }
    } catch (e) { toast(e.message, 'err'); }
  },

  async cascadeDelete(entity, id, name, done) {
    const what = { learning_path: 'lộ trình (kèm topic, unit, nội dung bên trong)', topic: 'topic (kèm unit, nội dung bên trong)',
      vocabulary: 'từ vựng (gỡ khỏi mọi unit)', grammar: 'ngữ pháp (gỡ khỏi mọi unit)', game: 'game (gỡ khỏi mọi unit)' }[entity];
    if (!(await confirmModal(`Xoá ${what}: <b>${esc(name)}</b>?<br><span class="muted">Xoá mềm — khôi phục được ở "Bảng dữ liệu".</span>`, 'Xoá', true))) return;
    if (!(await Kit.ensureWrite())) return;
    try {
      const r = await api('/api/admin/cms/delete', { method: 'POST', body: JSON.stringify({ entity, id }) });
      toast('Đã xoá: ' + Object.entries(r.deleted).map(([k, n]) => `${n} ${k}`).join(', '));
      done && done();
    } catch (e) { toast(e.message, 'err'); }
  },

  // ── từ vựng / ngữ pháp / game ──────────────────────────────────────
  vocabTab(b) {
    let level = '';
    const lv = el('select', 'ainput');
    lv.innerHTML = '<option value="">mọi cấp</option>' + CEFR.map(c => `<option>${c}</option>`).join('');
    lv.onchange = () => { level = lv.value; t.reload(); };
    const add = Admin.writeOnly(el('button', 'go', '＋  Thêm từ'));
    add.onclick = () => this.vocabModal(null, () => t.reload());
    const t = Kit.serverTable(b, {
      table: 'vocabulary', toolbar: [lv, add], query: () => ({ f: level ? [`level|eq|${level}`] : [] }),
      onRow: r => this.vocabModal(r, () => t.reload()),
      columns: [
        { key: 'id', label: 'ID' }, { key: 'word', label: 'Từ' },
        { key: 'level', label: 'Cấp', render: r => Kit.badge(r.level || '—') },
        { key: 'phonetic', label: 'Phiên âm', sort: false, render: r => V.phonetic(r.phonetic) },
        { key: 'meaning', label: 'Nghĩa', sort: false, render: r => { const s = V.meaning(r.meaning); return s.length > 60 ? s.slice(0, 60) + '…' : s; } },
        { key: 'partOfSpeech', label: 'Từ loại', sort: false, render: r => V.pos(r.partOfSpeech) },
        { key: 'baseWeight', label: 'Trọng số' },
        { key: 'updatedAt', label: 'Sửa lúc', render: r => Kit.date(r.updatedAt || r.createdAt) },
      ],
    });
  },

  vocabFields() {
    return [
      { key: 'word', label: 'Từ', type: 'text', required: true },
      { key: 'level', label: 'Cấp CEFR', type: 'select', required: true, options: CEFR },
      { key: 'meaning', label: 'Nghĩa tiếng Việt', type: 'text', required: true, full: true },
      { key: 'phonetic', label: 'Phiên âm (en_us)', type: 'text', placeholder: '/ˈfæməli/' },
      { key: 'pos', label: 'Từ loại', type: 'select', options: POS },
      { key: 'baseWeight', label: 'Trọng số (0–100)', type: 'int', min: 0, max: 100 },
      { key: 'examples', label: 'Ví dụ — mỗi dòng: câu tiếng Anh | nghĩa tiếng Việt', type: 'textarea', rows: 4 },
      { key: 'imageURL', label: 'Ảnh (URL / đường dẫn storage)', type: 'text', full: true },
      { key: 'audioURL', label: 'Âm thanh (URL)', type: 'text', full: true },
    ];
  },

  vocabModal(r, done) {
    const extra = [];
    if (r) {
      const del = Admin.writeOnly(el('button', 'stop', '🗑  Xoá'));
      del.onclick = () => { m.close(); this.cascadeDelete('vocabulary', r.id, r.word, done); };
      extra.push(del);
      const raw = el('button', 'ghost', '{ } JSON');
      raw.onclick = () => modal({ title: `vocabulary #${r.id}`, bodyHTML: `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`, wide: true });
      extra.push(raw);
    }
    const start = r ? {
      ...r, meaning: V.meaning(r.meaning), phonetic: V.phonetic(r.phonetic), pos: V.pos(r.partOfSpeech), examples: V.examples(r.example),
    } : { baseWeight: 50, level: 'a1' };
    const f = Kit.form(this.vocabFields(), start);
    const m = modal({
      title: r ? `Từ vựng #${r.id} — ${r.word}` : 'Thêm từ vựng', body: f.node, wide: '48rem', extra, okLabel: 'Lưu',
      onOk: async () => {
        const v = f.read();
        // giữ các khoá khác trong JSON gốc (nếu có), chỉ thay phần đang sửa
        const keep = (orig, key, val) => ({ ...(orig && typeof orig === 'object' && !Array.isArray(orig) ? orig : {}), [key]: val });
        const out = {
          word: v.word, level: v.level, baseWeight: v.baseWeight,
          meaning: keep(r && r.meaning, 'vi', v.meaning),
          phonetic: v.phonetic ? keep(r && r.phonetic, 'en_us', v.phonetic) : null,
          partOfSpeech: v.pos ? [v.pos] : null,
          example: V.parseExamples(v.examples || ''),
          imageURL: v.imageURL, audioURL: v.audioURL,
        };
        // trùng (từ + cấp) như ràng buộc của bảng: báo trước cho dễ hiểu
        const dup = await api(`/api/admin/tables/vocabulary/rows?limit=5&f=${encodeURIComponent(`word|ilike|${v.word}`)}&f=${encodeURIComponent(`level|eq|${v.level}`)}`);
        const other = dup.rows.find(x => x.word.trim().toLowerCase() === v.word.trim().toLowerCase() && (!r || x.id !== r.id));
        if (other) throw new Error(`Đã có "${other.word}" cấp ${v.level} (#${other.id})`);
        await this.saveRow('vocabulary', r, out, done, r ? 'Đã lưu từ vựng' : 'Đã thêm từ vựng');
      },
    });
  },

  grammarTab(b) {
    let level = '';
    const lv = el('select', 'ainput');
    lv.innerHTML = '<option value="">mọi cấp</option>' + CEFR.map(c => `<option>${c}</option>`).join('');
    lv.onchange = () => { level = lv.value; t.reload(); };
    const add = Admin.writeOnly(el('button', 'go', '＋  Thêm ngữ pháp'));
    add.onclick = () => this.grammarModal(null, () => t.reload());
    const t = Kit.serverTable(b, {
      table: 'grammar', toolbar: [lv, add], query: () => ({ f: level ? [`level|eq|${level}`] : [] }),
      onRow: r => this.grammarModal(r, () => t.reload()),
      columns: [
        { key: 'id', label: 'ID' }, { key: 'title', label: 'Tiêu đề' }, { key: 'codename', label: 'Mã' },
        { key: 'level', label: 'Cấp', render: r => Kit.badge(r.level || '—') },
        { key: 'studyDurationSecond', label: 'Thời lượng (s)' },
        { key: 'updatedAt', label: 'Sửa lúc', render: r => Kit.date(r.updatedAt || r.createdAt) },
      ],
    });
  },

  grammarModal(r, done) {
    const extra = [];
    if (r) {
      const del = Admin.writeOnly(el('button', 'stop', '🗑  Xoá'));
      del.onclick = () => { m.close(); this.cascadeDelete('grammar', r.id, r.title, done); };
      extra.push(del);
    }
    const f = Kit.form([
      { key: 'title', label: 'Tiêu đề', type: 'text', required: true, full: true },
      { key: 'codename', label: 'Mã (codename)', type: 'text' },
      { key: 'level', label: 'Cấp CEFR', type: 'select', options: CEFR },
      { key: 'studyDurationSecond', label: 'Thời lượng học (giây)', type: 'int', min: 0 },
      { key: 'content', label: 'Nội dung (JSON: tabs → blocks)', type: 'json', rows: 14 },
    ], r || { level: 'a1', content: { tabs: [] } });
    const m = modal({
      title: r ? `Ngữ pháp #${r.id}` : 'Thêm ngữ pháp', body: f.node, wide: '60rem', extra, okLabel: 'Lưu',
      onOk: async () => this.saveRow('grammar', r, f.read(), done, r ? 'Đã lưu ngữ pháp' : 'Đã thêm ngữ pháp'),
    });
  },

  gameTab(b) {
    b.appendChild(el('div', 'muted small', 'Danh sách game để gắn vào unit. Sửa game (cho chơi, premium, phần thưởng…) ở mục "Game".'));
    Kit.serverTable(b, {
      table: 'game', order: 'id', desc: false,
      columns: [
        { key: 'id', label: 'ID' }, { key: 'title', label: 'Tên' }, { key: 'gameDifficulty', label: 'Độ khó' },
        { key: 'isPlayable', label: 'Cho chơi', render: r => (r.isPlayable ? '✓' : '—') },
        { key: 'isPremium', label: 'Premium', render: r => (r.isPremium ? '✓' : '—') },
        { key: 'playCount', label: 'Lượt chơi' },
      ],
    });
  },

  // ── công cụ ────────────────────────────────────────────────────────
  weightModal() {
    Kit.formModal({
      title: 'Phân bổ trọng số từ vựng',
      note: 'Đặt lại baseWeight của mọi từ vựng trong khoảng [min, max] theo số lần được học (learnCount) trung bình — từ hay học thì trọng số thấp.',
      values: { min: 20, max: 100 },
      fields: [{ key: 'min', label: 'Min', type: 'int', required: true, min: 0, max: 100 }, { key: 'max', label: 'Max', type: 'int', required: true, min: 0, max: 100 }],
      okLabel: 'Phân bổ',
      onSubmit: async v => {
        if (v.min > v.max) throw new Error('Min phải ≤ max');
        const r = await Kit.mustWrite('tt_admin_vocabulary_weight_distribute', { p_min: v.min, p_max: v.max },
          { confirm: `Đặt lại trọng số <b>mọi</b> từ vựng trong khoảng ${v.min}–${v.max}?`, ok: null });
        toast('Đã phân bổ: ' + (typeof r === 'object' ? JSON.stringify(r) : 'xong'));
      },
    });
  },

  /** Quét tài liệu → chọn từ mới → điền nghĩa / cấp → lưu (định dạng chuẩn). */
  scanModal() {
    const body = el('div', 'kscan');
    body.innerHTML = `<div class="muted small">PDF có chữ, PDF scan / ảnh (cần tesseract trên máy), hoặc .txt. Từ đã có trong bảng vocabulary được đánh dấu.
      Phiên âm / từ loại / câu ví dụ tra tự động; <b>nghĩa tiếng Việt và cấp CEFR do bạn điền</b>.</div>
      <div class="kscan__src"><input type="file" class="s-file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv">
      <input class="ainput s-pages" placeholder="trang: 3-7 (trống = cả file)" style="width:12rem">
      <button class="go s-go">Quét</button></div><div class="s-out"></div>`;
    const out = body.querySelector('.s-out');
    let rows = [];
    const m = modal({ title: 'Quét tài liệu lấy từ vựng', body, wide: '78rem', okLabel: 'Lưu các từ đã chọn',
      onOk: async () => {
        const pick = rows.filter(r => r.on);
        if (!pick.length) throw new Error('Chưa chọn từ nào');
        const bad = pick.filter(r => !r.meaning.trim() || !CEFR.includes(r.level));
        if (bad.length) throw new Error(`${bad.length} từ thiếu nghĩa hoặc cấp: ${bad.slice(0, 5).map(r => r.word).join(', ')}…`);
        const dup = pick.filter(r => r.existing.includes(r.level));
        if (dup.length) throw new Error(`Đã có sẵn cùng cấp: ${dup.slice(0, 5).map(r => r.word + ' ' + r.level).join(', ')}`);
        if (!(await Kit.ensureWrite())) throw new Error('Cần bật "Cho phép ghi"');
        const res = await api('/api/admin/tables/vocabulary/bulk', { method: 'POST', body: JSON.stringify({ autoId: true, rows: pick.map(r => ({
          word: r.word, level: r.level, baseWeight: 50, meaning: { vi: r.meaning.trim() },
          phonetic: r.phonetic ? { en_us: r.phonetic } : null, partOfSpeech: r.pos ? [r.pos] : null,
          example: r.example ? [{ sentence: r.example, sentence_vi: '' }] : [],
        })) }) });
        toast(`Đã thêm ${res.rows.length} từ vựng`);
      } });
    const draw = () => {
      out.innerHTML = '';
      const bar = el('div', 'btns');
      const all = el('button', 'ghost', 'Chọn mọi từ mới');
      all.onclick = () => { rows.forEach(r => { r.on = !r.existing.length; }); draw(); };
      const none = el('button', 'ghost', 'Bỏ chọn');
      none.onclick = () => { rows.forEach(r => { r.on = false; }); draw(); };
      const lv = el('select', 'ainput');
      lv.innerHTML = '<option value="">đặt cấp cho từ đã chọn…</option>' + CEFR.map(c => `<option>${c}</option>`).join('');
      lv.onchange = () => { rows.filter(r => r.on).forEach(r => { r.level = lv.value; }); draw(); };
      const look = el('button', '', '🔎  Tra phiên âm / ví dụ (từ đã chọn, tối đa 40)');
      look.onclick = async () => {
        const pick = rows.filter(r => r.on).slice(0, 40);
        if (!pick.length) { toast('Chọn từ trước'); return; }
        look.disabled = true;
        try {
          const r = await api('/api/admin/ocr/lookup', { method: 'POST', body: JSON.stringify({ words: pick.map(x => x.word) }) });
          let n = 0;
          for (const x of pick) {
            const d = r.results[x.word];
            if (!d) continue;
            n++;
            x.phonetic = x.phonetic || d.phonetic || '';
            x.pos = x.pos || d.pos || '';
            x.example = x.example || d.example || '';
          }
          toast(`Tra được ${n}/${pick.length} từ`);
          draw();
        } catch (e) { toast(e.message, 'err'); } finally { look.disabled = false; }
      };
      bar.append(all, none, lv, look, el('span', 'muted small', `${rows.filter(r => r.on).length} / ${rows.length} từ đang chọn`));
      out.appendChild(bar);
      const t = el('table', 'dgrid');
      t.innerHTML = '<thead><tr><th></th><th>Từ</th><th>Lần</th><th>Đã có</th><th>Cấp</th><th>Nghĩa tiếng Việt *</th><th>Phiên âm</th><th>Từ loại</th><th>Câu ví dụ</th></tr></thead>';
      const tb = el('tbody');
      for (const r of rows) {
        const tr = el('tr');
        if (r.existing.length) tr.classList.add('dup');
        const cell = (n) => { const td = el('td'); td.appendChild(n); tr.appendChild(td); return td; };
        const cb = el('input'); cb.type = 'checkbox'; cb.checked = r.on; cb.onchange = () => { r.on = cb.checked; };
        cell(cb);
        tr.appendChild(el('td', null, r.word));
        tr.appendChild(el('td', null, String(r.count)));
        tr.appendChild(el('td', r.existing.length ? 'err' : 'muted', r.existing.join(', ') || '—'));
        const lvl = el('select', 'ainput'); lvl.innerHTML = CEFR.map(c => `<option>${c}</option>`).join(''); lvl.value = r.level; lvl.onchange = () => { r.level = lvl.value; };
        cell(lvl);
        for (const k of ['meaning', 'phonetic', 'pos', 'example']) {
          const i = el('input', 'ainput'); i.value = r[k]; i.oninput = () => { r[k] = i.value; };
          if (k === 'meaning') i.placeholder = 'nghĩa…';
          cell(i);
        }
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      const wrap = el('div', 'dgrid-wrap');
      wrap.appendChild(t);
      out.appendChild(wrap);
    };
    body.querySelector('.s-go').onclick = async () => {
      const f = body.querySelector('.s-file').files[0];
      if (!f) { toast('Chọn file trước', 'err'); return; }
      if (f.size > 15 * 1024 * 1024) { toast('File quá 15 MB', 'err'); return; }
      out.innerHTML = '<div class="aempty">Đang quét…</div>';
      try {
        const data = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(String(fr.result).split(',')[1]);
          fr.onerror = () => rej(new Error('Không đọc được file'));
          fr.readAsDataURL(f);
        });
        const r = await api('/api/admin/ocr/extract', { method: 'POST', body: JSON.stringify({ name: f.name, data, pages: body.querySelector('.s-pages').value.trim() || null }) });
        rows = r.words.map(w => ({ ...w, on: !w.existing.length, level: 'a1', meaning: '', phonetic: '', pos: '', example: '' }));
        toast(`${r.method}: ${fmtNum(r.chars)} ký tự → ${rows.length} từ${r.truncated ? ' (chỉ lấy 400 từ hay gặp nhất)' : ''}`);
        draw();
      } catch (e) { out.innerHTML = ''; out.appendChild(el('div', 'aempty err', e.message)); }
    };
    return m;
  },

  bulkModal() {
    const body = el('div');
    body.innerHTML = `<label>Loại</label><select class="b-type"><option value="vocabulary">Từ vựng</option><option value="grammar">Ngữ pháp</option></select>
      <label>Dữ liệu — mỗi dòng một mục</label>
      <div class="muted small b-help"></div>
      <textarea class="b-text" rows="12"></textarea>
      <div class="b-prev"></div>`;
    const type = body.querySelector('.b-type');
    const text = body.querySelector('.b-text');
    const help = body.querySelector('.b-help');
    const prev = body.querySelector('.b-prev');
    const HELP = {
      vocabulary: 'từ | nghĩa | cấp | phiên âm | từ loại | câu ví dụ | nghĩa câu ví dụ   — "từ" và "nghĩa" bắt buộc; cấp mặc định a1, trọng số 50.<br>Vd: <code>cat | con mèo | a1 | /kæt/ | noun | I have a cat. | Tôi có một con mèo.</code>',
      grammar: 'tiêu đề | codename | cấp   — vd: <code>Present simple | present_simple | a1</code>',
    };
    const parse = () => {
      const lines = text.value.split('\n').map(x => x.trim()).filter(Boolean);
      const seen = new Set();
      return lines.map((line, i) => {
        const p = line.split('|').map(x => x.trim());
        let row, err = null;
        if (type.value === 'vocabulary') {
          const level = (p[2] || 'a1').toLowerCase();
          row = {
            word: p[0], level, baseWeight: 50,
            meaning: { vi: p[1] || '' }, phonetic: p[3] ? { en_us: p[3] } : null,
            partOfSpeech: p[4] ? [p[4]] : null,
            example: p[5] ? [{ sentence: p[5], sentence_vi: p[6] || '' }] : [],
          };
          if (!p[0]) err = 'thiếu từ';
          else if (!p[1]) err = 'thiếu nghĩa';
          else if (!CEFR.includes(level)) err = `cấp "${level}" không hợp lệ`;
          const k = `${p[0].toLowerCase()}|${level}`;
          if (!err && seen.has(k)) err = 'trùng trong danh sách';
          seen.add(k);
        } else {
          const level = (p[2] || 'a1').toLowerCase();
          row = { title: p[0], codename: p[1] || null, level, content: { tabs: [] } };
          if (!p[0]) err = 'thiếu tiêu đề';
          else if (!CEFR.includes(level)) err = `cấp "${level}" không hợp lệ`;
        }
        return { i: i + 1, row, err };
      });
    };
    const show = () => {
      help.innerHTML = HELP[type.value];
      const items = parse();
      const bad = items.filter(x => x.err);
      prev.innerHTML = `<div class="muted small">${items.length} dòng · <span class="${bad.length ? 'err' : 'ok'}">${bad.length} lỗi</span></div>` +
        bad.slice(0, 20).map(x => `<div class="err small">dòng ${x.i}: ${esc(x.err)}</div>`).join('');
    };
    type.onchange = show;
    text.oninput = show;
    show();
    modal({
      title: 'Nhập hàng loạt', body, okLabel: 'Nhập', wide: '52rem',
      onOk: async () => {
        const items = parse();
        if (!items.length) throw new Error('Chưa có dòng nào');
        if (items.some(x => x.err)) throw new Error('Còn dòng lỗi — sửa trước khi nhập');
        if (!(await Kit.ensureWrite())) throw new Error('Cần bật "Cho phép ghi"');
        const r = await api(`/api/admin/tables/${type.value}/bulk`, { method: 'POST', body: JSON.stringify({ rows: items.map(x => x.row), autoId: true }) });
        toast(`Đã nhập ${r.rows.length} ${type.value === 'vocabulary' ? 'từ vựng' : 'ngữ pháp'}`);
      },
    });
  },
};

Admin.register({
  id: 'lessons', title: 'Nội dung học', icon: '📚', group: 'Quản lý', order: 11,
  render: (main) => Lessons.render(main),
});
