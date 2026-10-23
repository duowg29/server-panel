/* TinyFarm — người chơi (ví, kho, công trình, nhiệm vụ, reset), danh mục,
   mã quà, phiếu hỗ trợ, giao dịch. Đọc / ghi thẳng các bảng tiny_farm_* (có
   nhật ký); reset nông trại đi qua /api/admin/tinyfarm/reset (giữ giao dịch
   và phiếu hỗ trợ, như hàm tiny_farm_reset_profile). */

const TF_CATALOG = [
  ['tiny_farm_item_def', 'Vật phẩm'], ['tiny_farm_building_def', 'Công trình'], ['tiny_farm_building_level_def', 'Cấp công trình'],
  ['tiny_farm_quest_def', 'Nhiệm vụ'], ['tiny_farm_shop_product_def', 'Cửa hàng'], ['tiny_farm_character_upgrade_def', 'Nâng cấp nhân vật'],
  ['tiny_farm_tool_def', 'Công cụ'], ['tiny_farm_storage_def', 'Kho chứa'], ['tiny_farm_farm_def', 'Nông trại'], ['tiny_farm_promo_code_def', 'Mã quà'],
];

const TinyFarmAdmin = {
  async tableWrite(method, table, body, ok, done) {
    if (!(await Kit.ensureWrite())) throw new Error('Cần bật "Cho phép ghi"');
    await api(`/api/admin/tables/${table}/rows`, { method, body: JSON.stringify(body) });
    toast(ok);
    done && done();
  },

  render(main) {
    pageHead(main, 'TinyFarm', 'Dữ liệu game nông trại: người chơi, danh mục (giá, nhiệm vụ, công trình…), mã quà, phiếu hỗ trợ, giao dịch.');
    const kp = el('div');
    main.appendChild(kp);
    Promise.all(['tiny_farm_profile', 'tiny_farm_quest_progress', 'tiny_farm_promo_redemption', 'tiny_farm_support_ticket', 'tiny_farm_purchase']
      .map(t => api(`/api/admin/tables/${t}/rows?limit=1`).then(r => r.total).catch(() => null)))
      .then(([p, q, pr, st, pu]) => Kit.kpis(kp, [
        { label: 'Người chơi', value: fmtNum(p) }, { label: 'Tiến độ nhiệm vụ', value: fmtNum(q) },
        { label: 'Lượt dùng mã quà', value: fmtNum(pr) }, { label: 'Phiếu hỗ trợ', value: fmtNum(st) }, { label: 'Giao dịch', value: fmtNum(pu) },
      ]));
    Kit.tabs(main, [
      { id: 'players', label: 'Người chơi', render: b => this.players(b) },
      { id: 'catalog', label: 'Danh mục', render: b => this.catalog(b) },
      { id: 'promo', label: 'Mã quà', render: b => this.promo(b) },
      { id: 'support', label: 'Hỗ trợ', render: b => this.support(b) },
      { id: 'purchase', label: 'Giao dịch', render: b => this.purchases(b) },
    ]);
  },

  async players(b) {
    b.appendChild(el('div', 'aempty', 'Đang tải…'));
    const [rows, users] = await Promise.all([
      allRows('tiny_farm_profile', { order: 'lastSavedAt' }),
      rpc('tt_admin_user_account_snapshot').catch(() => []),
    ]);
    const who = id => (users || []).find(u => String(u.profileId) === String(id));
    b.innerHTML = '';
    const reload = () => { b.innerHTML = ''; this.players(b); };
    Kit.table(b, {
      rows: rows.slice().reverse(), csvName: 'tiny_farm_profile', onRow: r => this.player(r, who(r.profileId), reload),
      columns: [
        { key: 'profileId', label: 'Profile' },
        { key: '_u', label: 'Tài khoản', value: r => { const u = who(r.profileId); return u ? u.email : ''; }, render: r => {
          const u = who(r.profileId);
          const d = el('div', 'kuser');
          d.innerHTML = `<b>${esc(r.displayName || '—')}</b><span class="muted">${esc(u ? (u.email || u.fullname) : '(không thấy tài khoản)')}</span>`;
          return d;
        } },
        { key: 'cash', label: 'Tiền', render: r => fmtNum(r.cash) }, { key: 'coins', label: 'Xu', render: r => fmtNum(r.coins) },
        { key: 'unlockedArea', label: 'Khu đã mở' }, { key: 'rescuedWorkers', label: 'Thợ đã cứu', render: r => Kit.json(r.rescuedWorkers) },
        { key: 'isTutorialDone', label: 'Xong hướng dẫn', render: r => (r.isTutorialDone ? '✓' : (r.tutorialStep || '—')) },
        { key: 'lastSavedAt', label: 'Lưu lần cuối', render: r => Kit.dateTime(r.lastSavedAt) },
      ],
    });
  },

  player(p, user, reload) {
    const pid = p.profileId;
    const body = el('div', 'kdetail');
    const m = modal({ title: `Nông trại của #${pid} — ${p.displayName || ''}${user ? ' · ' + (user.email || '') : ''}`, body, wide: '72rem' });
    const byPid = (t, order) => allRows(t, { order: order || 'profileId', f: [`profileId|eq|${pid}`] });
    Kit.tabs(body, [
      { id: 'over', label: 'Tổng quan & ví', render: b => {
        const g = el('div', 'kfacts');
        for (const [k, v] of Object.entries(p)) g.insertAdjacentHTML('beforeend', `<div class="k">${esc(k)}</div><div class="v">${esc(Kit.json(v))}</div>`);
        b.appendChild(g);
        const fields = [
          { key: 'displayName', label: 'Tên nhân vật', type: 'text' },
          { key: 'cash', label: 'Tiền', type: 'int', min: 0 }, { key: 'coins', label: 'Xu', type: 'int', min: 0 },
          { key: 'cashOnBoard', label: 'Tiền trên quầy', type: 'int', min: 0 }, { key: 'unlockedArea', label: 'Khu đã mở', type: 'int', min: 0 },
          { key: 'isAdsRemoved', label: 'Đã tắt quảng cáo', type: 'bool' }, { key: 'vipUntil', label: 'VIP đến', type: 'datetime' },
          { key: 'isTutorialDone', label: 'Xong hướng dẫn', type: 'bool' },
        ];
        const edit = Admin.writeOnly(el('button', '', '✎  Sửa ví / trạng thái'));
        edit.onclick = () => Kit.formModal({
          title: `Sửa nông trại #${pid}`, fields, values: p, okLabel: 'Lưu',
          note: 'App lưu theo "lastSavedAt" (bản mới nhất thắng): nếu người chơi đang mở game, bản trên máy có thể ghi đè lại. Sửa khi họ không chơi.',
          onSubmit: async v => {
            const changes = {};
            for (const [k, x] of Object.entries(v)) if (JSON.stringify(x) !== JSON.stringify(p[k] ?? null)) changes[k] = x;
            if (!Object.keys(changes).length) return;
            changes.lastSavedAt = new Date().toISOString();
            await this.tableWrite('PATCH', 'tiny_farm_profile', { pk: { profileId: pid }, changes }, 'Đã lưu', () => { m.close(); reload(); });
          },
        });
        const reset = Admin.writeOnly(el('button', 'stop', '⟲  Reset nông trại'));
        reset.onclick = async () => {
          if (!(await confirmModal(`Xoá sạch nông trại của <b>#${pid}</b>? Lần mở game sau là người chơi mới.<br>
            <span class="muted">Xoá: hồ sơ, kho, công trình, nâng cấp, công cụ, nhiệm vụ, khu đã mở, mã quà đã dùng. Giữ: giao dịch, phiếu hỗ trợ.
            Bản sao dữ liệu bị xoá nằm trong Nhật ký thay đổi.</span>`, 'Reset', true))) return;
          if (!(await Kit.ensureWrite())) return;
          try {
            const r = await api('/api/admin/tinyfarm/reset', { method: 'POST', body: JSON.stringify({ profileId: pid }) });
            toast('Đã reset: ' + Object.entries(r.deleted).filter(([, n]) => n).map(([k, n]) => `${n} ${k.replace('tiny_farm_', '')}`).join(', '));
            m.close();
            reload();
          } catch (e) { toast(e.message, 'err'); }
        };
        const bar = el('div', 'btns');
        bar.style.marginTop = '.8rem';
        bar.append(edit, reset);
        b.appendChild(bar);
      } },
      { id: 'stock', label: 'Kho', render: async b => {
        const rows = await byPid('tiny_farm_stock', 'location');
        Kit.table(b, { rows, pageSize: 50, columns: [{ key: 'location', label: 'Kho' }, { key: 'itemId', label: 'Vật phẩm' }, { key: 'quantity', label: 'Số lượng' }, { key: 'updatedAt', label: 'Cập nhật', render: r => Kit.dateTime(r.updatedAt) }] });
      } },
      { id: 'build', label: 'Công trình', render: async b => {
        const rows = await byPid('tiny_farm_building', 'buildingId');
        Kit.table(b, { rows, pageSize: 50, columns: [{ key: 'buildingId', label: 'Công trình' }, { key: 'level', label: 'Cấp' }, { key: 'upgradePhase', label: 'Đang nâng' },
          { key: 'paidCash', label: 'Đã trả' }, { key: 'paidItems', label: 'Vật phẩm đã nộp', render: r => Kit.json(r.paidItems) }, { key: 'upgradeEndsAt', label: 'Xong lúc', render: r => Kit.dateTime(r.upgradeEndsAt) }] });
      } },
      { id: 'up', label: 'Nâng cấp', render: async b => {
        const [ups, tools, farms] = await Promise.all([byPid('tiny_farm_character_upgrade', 'upgradeId'), byPid('tiny_farm_tool_boost', 'toolId'), byPid('tiny_farm_farm_unlock', 'farmId')]);
        b.appendChild(el('h4', 'ksub', 'Nâng cấp nhân vật'));
        Kit.table(b, { rows: ups, columns: [{ key: 'upgradeId', label: 'Bậc' }, { key: 'createdAt', label: 'Mua lúc', render: r => Kit.dateTime(r.createdAt) }] });
        b.appendChild(el('h4', 'ksub', 'Công cụ đang dùng'));
        Kit.table(b, { rows: tools, columns: [{ key: 'toolId', label: 'Công cụ' }, { key: 'expiresAt', label: 'Hết hạn', render: r => Kit.dateTime(r.expiresAt) }] });
        b.appendChild(el('h4', 'ksub', 'Nông trại đã mở'));
        Kit.table(b, { rows: farms, columns: [{ key: 'farmId', label: 'Nông trại' }, { key: 'createdAt', label: 'Lúc', render: r => Kit.dateTime(r.createdAt) }] });
      } },
      { id: 'quest', label: 'Nhiệm vụ', render: async b => {
        const rows = await byPid('tiny_farm_quest_progress', 'updatedAt');
        Kit.table(b, { rows: rows.reverse(), pageSize: 50, columns: [{ key: 'questId', label: 'Nhiệm vụ' }, { key: 'periodKey', label: 'Kỳ' }, { key: 'progress', label: 'Tiến độ' },
          { key: 'completedAt', label: 'Xong', render: r => Kit.dateTime(r.completedAt) }, { key: 'claimedAt', label: 'Đã nhận', render: r => Kit.dateTime(r.claimedAt) }] });
      } },
    ]);
  },

  async catalog(b) {
    b.appendChild(el('div', 'muted small', 'Mở bảng để xem / sửa từng dòng (Bảng dữ liệu). Sửa danh mục đổi giá / thưởng cho mọi người chơi ngay khi app tải lại danh mục.'));
    const grid = el('div', 'acards');
    b.appendChild(grid);
    const totals = await Promise.all(TF_CATALOG.map(([t]) => api(`/api/admin/tables/${t}/rows?limit=1`).then(r => r.total).catch(() => null)));
    TF_CATALOG.forEach(([t, label], i) => {
      const a = el('a', 'acard link');
      a.href = `#/tables/${t}`;
      a.innerHTML = `<h3>${esc(label)}</h3><p>${fmtNum(totals[i])} dòng · <code>${esc(t)}</code></p>`;
      grid.appendChild(a);
    });
  },

  async promo(b) {
    const [codes, used] = await Promise.all([allRows('tiny_farm_promo_code_def', { order: 'code' }), allRows('tiny_farm_promo_redemption', { order: 'createdAt' })]);
    const reload = () => { b.innerHTML = ''; this.promo(b); };
    const fields = isNew => [
      { key: 'code', label: 'Mã (viết hoa, không dấu)', type: 'text', required: true, readonly: !isNew },
      { key: 'rewardCash', label: 'Thưởng tiền', type: 'int', min: 0 }, { key: 'rewardCoins', label: 'Thưởng xu', type: 'int', min: 0 },
      { key: 'startsAt', label: 'Bắt đầu', type: 'datetime' }, { key: 'endsAt', label: 'Hết hạn', type: 'datetime' },
      { key: 'maxRedemptions', label: 'Số lượt tối đa (trống = không giới hạn)', type: 'int', min: 1 },
    ];
    const add = Admin.writeOnly(el('button', 'go', '＋  Thêm mã quà'));
    add.onclick = () => Kit.formModal({
      title: 'Thêm mã quà', fields: fields(true), values: { rewardCash: 0, rewardCoins: 0 }, okLabel: 'Thêm',
      onSubmit: v => this.tableWrite('POST', 'tiny_farm_promo_code_def', { row: { ...v, code: v.code.toUpperCase() } }, 'Đã thêm mã', reload),
    });
    b.appendChild(add);
    Kit.table(b, {
      rows: codes, csvName: 'tiny_farm_promo_code_def',
      columns: [
        { key: 'code', label: 'Mã' }, { key: 'rewardCash', label: 'Tiền' }, { key: 'rewardCoins', label: 'Xu' },
        { key: 'redemptionCount', label: 'Đã dùng', render: r => `${fmtNum(r.redemptionCount)}${r.maxRedemptions ? ' / ' + fmtNum(r.maxRedemptions) : ''}` },
        { key: 'startsAt', label: 'Từ', render: r => Kit.date(r.startsAt) }, { key: 'endsAt', label: 'Đến', render: r => Kit.date(r.endsAt) },
        { key: '_a', label: 'Thao tác', sort: false, render: r => {
          const d = el('div', 'btns');
          const e = Admin.writeOnly(el('button', '', '✎'));
          e.onclick = () => Kit.formModal({ title: `Sửa mã ${r.code}`, fields: fields(false), values: r, okLabel: 'Lưu',
            onSubmit: v => { delete v.code; return this.tableWrite('PATCH', 'tiny_farm_promo_code_def', { pk: { code: r.code }, changes: v }, 'Đã lưu', reload); } });
          const x = Admin.writeOnly(el('button', 'stop', '🗑'));
          x.onclick = async () => {
            if (!(await confirmModal(`Xoá mã <b>${esc(r.code)}</b>? (xoá mềm)`, 'Xoá', true))) return;
            try { await this.tableWrite('DELETE', 'tiny_farm_promo_code_def', { pk: { code: r.code } }, 'Đã xoá mã', reload); } catch (e2) { toast(e2.message, 'err'); }
          };
          d.append(e, x);
          return d;
        } },
      ],
    });
    b.appendChild(el('h4', 'ksub', 'Lượt dùng mã'));
    Kit.table(b, { rows: used.reverse(), csvName: 'tiny_farm_promo_redemption',
      columns: [{ key: 'createdAt', label: 'Lúc', render: r => Kit.dateTime(r.createdAt) }, { key: 'profileId', label: 'Profile' }, { key: 'promoCode', label: 'Mã' }] });
  },

  async support(b) {
    const rows = await allRows('tiny_farm_support_ticket', { order: 'createdAt' });
    const reload = () => { b.innerHTML = ''; this.support(b); };
    const STATUS = ['open', 'in_progress', 'closed'];
    Kit.table(b, {
      rows: rows.reverse(), csvName: 'tiny_farm_support_ticket', empty: 'Chưa có phiếu hỗ trợ nào.',
      onRow: r => modal({ title: `Phiếu hỗ trợ #${r.id}`, bodyHTML: `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`, wide: true }),
      columns: [
        { key: 'createdAt', label: 'Lúc', render: r => Kit.dateTime(r.createdAt) }, { key: 'profileId', label: 'Profile' }, { key: 'email', label: 'Email' },
        { key: 'category', label: 'Loại' }, { key: 'description', label: 'Nội dung', render: r => Kit.text(r.description).slice(0, 80) },
        { key: 'status', label: 'Trạng thái', render: r => {
          const s = Admin.writeOnly(el('select', 'ainput'));
          s.innerHTML = STATUS.map(x => `<option>${x}</option>`).join('');
          s.value = r.status || 'open';
          s.onchange = async () => {
            try { await this.tableWrite('PATCH', 'tiny_farm_support_ticket', { pk: { id: r.id }, changes: { status: s.value } }, 'Đã đổi trạng thái', reload); }
            catch (e) { toast(e.message, 'err'); s.value = r.status; }
          };
          return s;
        } },
      ],
    });
  },

  async purchases(b) {
    const rows = await allRows('tiny_farm_purchase', { order: 'createdAt' });
    Kit.table(b, {
      rows: rows.reverse(), csvName: 'tiny_farm_purchase', empty: 'Chưa có giao dịch nào.',
      onRow: r => modal({ title: `Giao dịch #${r.id}`, bodyHTML: `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`, wide: true }),
      columns: [
        { key: 'createdAt', label: 'Lúc', render: r => Kit.dateTime(r.createdAt) }, { key: 'profileId', label: 'Profile' },
        { key: 'productId', label: 'Sản phẩm' }, { key: 'kind', label: 'Loại' }, { key: 'store', label: 'Cửa hàng' },
        { key: 'status', label: 'Trạng thái' }, { key: 'transactionId', label: 'Mã giao dịch' },
      ],
    });
  },
};

Admin.register({
  id: 'tinyfarm', title: 'TinyFarm', icon: '🌾', group: 'Quản lý', order: 20,
  render: main => TinyFarmAdmin.render(main),
});
