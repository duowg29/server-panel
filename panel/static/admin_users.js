/* Tài khoản người dùng — chuyển từ tinytalk-admin (pages/user-management/users.tsx).
   Mọi đọc / ghi đi qua các hàm tt_admin_user_* / tt_admin_profile_* có sẵn trên
   Supabase, nên quy tắc (xoá mềm, email / SĐT không trùng, sổ xu…) giữ nguyên. */

const USER_ROLES = [['user', 'User'], ['admin', 'Admin'], ['moderator', 'Moderator']];
const USER_STATUS = [['active', 'Hoạt động'], ['inactive', 'Không hoạt động'], ['banned', 'Cấm'], ['suspended', 'Tạm ngưng'], ['deleted', 'Đã xoá']];
const USER_GENDER = [['male', 'Nam'], ['female', 'Nữ']];
const USER_LANG = [['vi-VN', 'Tiếng Việt (vi-VN)'], ['en-GB', 'English (en-GB)']];
const statusLabel = s => (USER_STATUS.find(x => x[0] === s) || [s, s || '—'])[1];
const statusKind = s => ({ active: 'ok', inactive: '', banned: 'bad', suspended: 'warn', deleted: 'bad' }[s] || '');
const isPremium = u => !!u.premiumUntil && new Date(u.premiumUntil) > new Date();

/** id game → tên (nạp một lần). */
let _gameTitles = null;
async function gameTitles() {
  if (!_gameTitles) {
    _gameTitles = api('/api/admin/tables/game/rows?limit=500')
      .then(d => Object.fromEntries((d.rows || []).map(g => [g.id, g.title || g.codename || `#${g.id}`])))
      .catch(() => { _gameTitles = null; return {}; });
  }
  return _gameTitles;
}

/** Hàm analytics có bản trả tỉ lệ 0..1, có bản trả sẵn phần trăm. */
const stickiness = r => { const v = Number(r) || 0; return (v > 1 ? v : v * 100).toFixed(0); };

const Users = {
  rows: [],
  analytics: null,
  filters: { q: '', role: '', status: '', plan: '', expMin: '', expMax: '', streakMin: '' },

  async render(main) {
    const bar = pageHead(main, 'Quản lý tài khoản người dùng',
      'Hồ sơ + tài khoản đăng nhập. Sửa / khoá / cộng xu cần bật "Cho phép ghi"; xoá là xoá mềm (profile.deletedAt).');
    const add = Admin.writeOnly(el('button', 'go', '＋  Tạo tài khoản'));
    add.onclick = () => this.editModal(null);
    const reload = el('button', '', '↻  Tải lại');
    reload.onclick = () => this.load(main);
    bar.append(add, reload);
    this.host = el('div');
    main.appendChild(this.host);
    await this.load();
  },

  async load() {
    this.host.innerHTML = '';
    this.host.appendChild(el('div', 'aempty', 'Đang tải…'));
    try {
      const [rows, an] = await Promise.all([
        rpc('tt_admin_user_account_snapshot'),
        rpc('tt_admin_user_analytics_snapshot').catch(() => null),
      ]);
      this.rows = Array.isArray(rows) ? rows : [];
      this.analytics = an;
      this.draw();
    } catch (e) {
      this.host.innerHTML = '';
      this.host.appendChild(el('div', 'aempty err', e.message));
    }
  },

  filtered() {
    const f = this.filters;
    const q = f.q.trim().toLowerCase();
    return this.rows.filter(u => {
      if (q && ![u.email, u.fullname, u.displayTitle, u.userId, u.phone, String(u.profileId)]
        .some(x => x && String(x).toLowerCase().includes(q))) return false;
      if (f.role && u.role !== f.role) return false;
      if (f.status && u.status !== f.status) return false;
      if (f.plan === 'premium' && !isPremium(u)) return false;
      if (f.plan === 'free' && isPremium(u)) return false;
      if (f.expMin !== '' && (u.expPoint || 0) < Number(f.expMin)) return false;
      if (f.expMax !== '' && (u.expPoint || 0) > Number(f.expMax)) return false;
      if (f.streakMin !== '' && (u.streakDays || 0) < Number(f.streakMin)) return false;
      return true;
    });
  },

  draw() {
    const h = this.host;
    h.innerHTML = '';
    const rows = this.rows;
    const list = this.filtered();
    const an = this.analytics || {};
    const DAY = 86400000;
    const signed7 = rows.filter(u => u.lastSignInAt && Date.now() - new Date(u.lastSignInAt) < 7 * DAY).length;
    const avg = (arr, k) => arr.length ? Math.round(arr.reduce((s, u) => s + (Number(u[k]) || 0), 0) / arr.length) : 0;
    Kit.kpis(h, [
      { label: 'Tài khoản', value: fmtNum(rows.length), sub: `${fmtNum(list.length)} khớp bộ lọc` },
      { label: 'Hoạt động', value: fmtNum(rows.filter(u => u.status === 'active').length) },
      { label: 'Premium', value: fmtNum(rows.filter(isPremium).length) },
      { label: 'EXP trung bình (lọc)', value: fmtNum(avg(list, 'expPoint')) },
      { label: 'Streak trung bình', value: fmtNum(avg(list, 'streakDays')) },
      { label: 'DAU / WAU / MAU', value: `${fmtNum(an.dau)} / ${fmtNum(an.wau)} / ${fmtNum(an.mau)}`, sub: `stickiness ${stickiness(an.dauMauRatio)}%` },
      { label: 'Mới hôm nay', value: fmtNum(an.newUsers) },
      { label: 'Retention D1 / D7 / D30', value: `${an.retentionD1 ?? 0}/${an.retentionD7 ?? 0}/${an.retentionD30 ?? 0}%` },
      { label: 'Đăng nhập trong 7 ngày', value: fmtNum(signed7), sub: rows.length ? `${Math.round(signed7 * 100 / rows.length)}% tài khoản` : '' },
      { label: 'Chưa xác minh email / SĐT', value: fmtNum(rows.filter(u => !u.emailVerified && !u.phoneVerified).length) },
    ]);

    const dist = el('div', 'kgrid3');
    const count = (k, labels) => labels.map(([v, l]) => [l, rows.filter(u => u[k] === v).length]).filter(e => e[1]);
    Kit.bars(dist, 'Phân bố trạng thái', count('status', USER_STATUS));
    Kit.bars(dist, 'Phân bố vai trò', count('role', USER_ROLES));
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      const key = d.toISOString().slice(0, 7);
      months.push([key, rows.filter(u => (u.createdAt || '').startsWith(key)).length]);
    }
    Kit.bars(dist, 'Tài khoản tạo mới (6 tháng)', months);
    h.appendChild(dist);

    // lần đăng nhập gần nhất theo ngày (14 ngày) — như trang cũ
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * DAY);
      const key = d.toLocaleDateString('sv-SE');
      days.push({ key, label: `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`, value: 0 });
    }
    for (const u of rows) {
      if (!u.lastSignInAt) continue;
      const d = days.find(x => x.key === new Date(u.lastSignInAt).toLocaleDateString('sv-SE'));
      if (d) d.value += 1;
    }
    const sc = el('div', 'kcard kcard--chart');
    sc.appendChild(el('h4', 'ksub', 'Lần đăng nhập gần nhất rơi vào ngày nào (14 ngày)'));
    columnChart(sc, days.map(d => ({ label: d.label, value: d.value, sub: 'tài khoản' })));
    h.appendChild(sc);

    // bộ lọc
    const f = this.filters;
    const fb = el('div', 'kfilters');
    const inp = (key, ph, type = 'search', w) => {
      const i = el('input', 'ainput');
      i.type = type; i.placeholder = ph; i.value = f[key];
      if (w) i.style.width = w;
      i.oninput = () => { f[key] = i.value; this.table.setRows(this.filtered()); };
      return i;
    };
    const sel = (key, all, opts) => {
      const s = el('select', 'ainput');
      s.innerHTML = `<option value="">${esc(all)}</option>` + opts.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
      s.value = f[key];
      s.onchange = () => { f[key] = s.value; this.table.setRows(this.filtered()); };
      return s;
    };
    const q = inp('q', '⌕  Tìm theo email, tên, UID, SĐT, profile id…');
    q.style.flex = '1';
    const reset = el('button', 'ghost', 'Reset bộ lọc');
    reset.onclick = () => { this.filters = { q: '', role: '', status: '', plan: '', expMin: '', expMax: '', streakMin: '' }; this.draw(); };
    fb.append(q, sel('role', 'Tất cả vai trò', USER_ROLES), sel('status', 'Tất cả trạng thái', USER_STATUS),
      sel('plan', 'Mọi gói', [['premium', 'Premium'], ['free', 'Free']]),
      inp('expMin', 'EXP min', 'number', '7rem'), inp('expMax', 'EXP max', 'number', '7rem'),
      inp('streakMin', 'Streak min', 'number', '7rem'), reset);
    h.appendChild(fb);

    this.table = Kit.table(h, {
      rows: list,
      csvName: 'tai_khoan',
      onRow: u => this.detail(u),
      rowClass: u => (u.status === 'deleted' ? 'deleted' : ''),
      columns: [
        { key: 'profileId', label: 'ID', value: u => Number(u.profileId) },
        { key: 'fullname', label: 'Người dùng', value: u => u.fullname || u.displayTitle || u.email, render: u => {
          const row = el('div', 'kuser-row');
          const d = el('div', 'kuser');
          d.innerHTML = `<b>${esc(u.fullname || u.displayTitle || '(chưa đặt tên)')}</b><span class="muted">${esc(u.email || u.phone || u.userId || '')}</span>`;
          row.append(Kit.avatar(u.avatarUrl, u.fullname || u.displayTitle || u.email, 34), d);
          return row;
        } },
        { key: 'role', label: 'Vai trò', render: u => Kit.badge(u.role || '—', u.role === 'admin' ? 'warn' : '') },
        { key: 'status', label: 'Trạng thái', render: u => Kit.badge(statusLabel(u.status), statusKind(u.status)) },
        { key: 'emailVerified', label: 'Xác minh', render: u => `${u.emailVerified ? '✉✓' : '✉✗'} ${u.phoneVerified ? '☎✓' : '☎✗'}` },
        { key: 'expPoint', label: 'EXP', render: u => fmtNum(u.expPoint) },
        { key: 'coinBalance', label: 'Xu', render: u => fmtNum(u.coinBalance) },
        { key: 'streakDays', label: 'Streak', render: u => fmtNum(u.streakDays) },
        { key: 'premiumUntil', label: 'Gói', render: u => Kit.badge(isPremium(u) ? 'Premium' : 'Free', isPremium(u) ? 'ok' : '') },
        { key: 'lastSignInAt', label: 'Đăng nhập', render: u => Kit.date(u.lastSignInAt) },
        { key: 'createdAt', label: 'Tạo lúc', render: u => Kit.date(u.createdAt) },
        { key: '_act', label: 'Thao tác', sort: false, render: u => this.actions(u) },
      ],
    });
  },

  actions(u) {
    const d = el('div', 'btns');
    const edit = Admin.writeOnly(el('button', '', '✎'));
    edit.title = 'Sửa';
    edit.onclick = () => this.editModal(u);
    const st = Admin.writeOnly(el('select', 'ainput'));
    st.title = 'Đổi trạng thái';
    st.innerHTML = USER_STATUS.filter(s => s[0] !== 'deleted').map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    st.value = u.status === 'deleted' ? 'active' : (u.status || 'active');
    st.onchange = async () => {
      try {
        const r = await Kit.write('tt_admin_user_account_set_status', { p_profile_id: Number(u.profileId), p_status: st.value },
          { confirm: `Đổi trạng thái <b>${esc(u.email || u.profileId)}</b> thành <b>${esc(statusLabel(st.value))}</b>?`, ok: 'Đã đổi trạng thái' });
        if (r) this.load(); else st.value = u.status;
      } catch (e) { toast(e.message, 'err'); st.value = u.status; }
    };
    const del = Admin.writeOnly(el('button', 'stop', '🗑'));
    del.title = 'Xoá (mềm)';
    del.onclick = async () => {
      try {
        const r = await Kit.write('tt_admin_user_account_delete', { p_profile_id: Number(u.profileId) }, {
          confirm: `Xoá tài khoản <b>${esc(u.email || u.profileId)}</b>?<br><span class="muted">Xoá mềm: đặt profile.deletedAt và trạng thái "deleted".</span>`,
          ok: 'Đã xoá tài khoản', danger: true,
        });
        if (r) this.load();
      } catch (e) { toast(e.message, 'err'); }
    };
    d.append(edit, st, del);
    return d;
  },

  fields(isNew) {
    return [
      { key: 'email', label: 'Email', type: 'email', required: isNew, placeholder: 'email@tinytalk.app',
        validate: v => (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? 'Email không hợp lệ' : null) },
      ...(isNew ? [{ key: 'password', label: 'Mật khẩu', type: 'password', required: true, placeholder: '••••••••',
        validate: v => (v && (v.length < 6 || v.length > 128) ? 'Mật khẩu 6–128 ký tự' : null) }] : []),
      { key: 'fullname', label: 'Họ tên', type: 'text' },
      { key: 'displayTitle', label: 'Tên hiển thị', type: 'text' },
      { key: 'phone', label: 'Số điện thoại', type: 'text', placeholder: '+84…',
        validate: v => (v && !/^\+?[0-9]{8,15}$/.test(v) ? 'SĐT 8–15 chữ số, có thể có + ở đầu' : null) },
      { key: 'role', label: 'Vai trò', type: 'select', required: true, options: USER_ROLES },
      { key: 'gender', label: 'Giới tính', type: 'select', options: USER_GENDER },
      { key: 'birthday', label: 'Ngày sinh', type: 'date' },
      { key: 'preferredLanguage', label: 'Ngôn ngữ ưu tiên', type: 'select', options: USER_LANG },
      { key: 'premiumUntil', label: 'Premium đến', type: 'datetime' },
      { key: 'emailVerified', label: 'Email đã xác minh', type: 'bool' },
      { key: 'phoneVerified', label: 'SĐT đã xác minh', type: 'bool' },
      { key: 'avatarUrl', label: 'URL ảnh đại diện', type: 'text', placeholder: 'https://…', full: true },
      { key: 'address', label: 'Địa chỉ', type: 'text', full: true },
      { key: 'bio', label: 'Tiểu sử', type: 'textarea', rows: 2 },
    ];
  },

  editModal(u) {
    const isNew = !u;
    Kit.formModal({
      title: isNew ? 'Tạo tài khoản mới' : `Chỉnh sửa tài khoản #${u.profileId}`,
      fields: this.fields(isNew),
      values: isNew ? { role: 'user', emailVerified: true, phoneVerified: false, preferredLanguage: 'vi-VN' } : u,
      okLabel: isNew ? 'Tạo' : 'Lưu thay đổi',
      note: isNew ? 'Tạo thẳng trong auth.users (mật khẩu mã hoá bcrypt) + hồ sơ. Email và SĐT không được trùng.' : null,
      onSubmit: async (v) => {
        const p = {
          p_email: v.email, p_display_title: v.displayTitle, p_phone: v.phone, p_fullname: v.fullname,
          p_profile_avatar_url: v.avatarUrl, p_role: v.role, p_gender: v.gender, p_address: v.address, p_bio: v.bio,
          p_birthday: v.birthday, p_preferred_language: v.preferredLanguage,
          p_email_verified: !!v.emailVerified, p_phone_verified: !!v.phoneVerified, p_premium_until: v.premiumUntil,
        };
        if (isNew) await Kit.mustWrite('tt_admin_user_account_create', { ...p, p_password: v.password }, { ok: 'Đã tạo tài khoản' });
        else await Kit.mustWrite('tt_admin_user_account_update', { ...p, p_profile_id: Number(u.profileId) }, { ok: 'Đã lưu tài khoản' });
        this.load();
      },
    });
  },

  // ── chi tiết ───────────────────────────────────────────────────────
  detail(u) {
    const pid = Number(u.profileId);
    const body = el('div', 'kdetail');
    const m = modal({ title: `Chi tiết tài khoản #${pid} — ${u.email || u.fullname || ''}`, body, wide: '72rem' });
    const head = el('div', 'kdetail__head');
    const who = el('div', 'kuser grow');
    who.innerHTML = `<b>${esc(u.fullname || u.displayTitle || '(chưa đặt tên)')}</b><span class="muted">${esc(u.email || u.phone || '')} · ${esc(statusLabel(u.status))}</span>`;
    const stats = el('button', '', '📈  Số liệu học tập');
    stats.title = 'Phiên chơi, từng từ đã luyện, thời gian học của người này';
    stats.onclick = () => { m.close(); location.hash = `#/stats/learner/${pid}`; };
    head.append(Kit.avatar(u.avatarUrl, u.fullname || u.email, 56), who, stats);
    body.appendChild(head);
    const ledger = (title, rows, cols) => {
      const box = el('div');
      box.appendChild(el('h4', 'ksub', title));
      Kit.table(box, { rows, pageSize: 10, columns: cols, empty: 'Chưa có dòng nào.' });
      return box;
    };
    const dt = { key: 'createdAt', label: 'Lúc', render: r => Kit.dateTime(r.createdAt) };
    Kit.tabs(body, [
      { id: 'over', label: 'Tổng quan', render: (b) => {
        const g = el('div', 'kfacts');
        const facts = [
          ['Profile ID', u.profileId], ['UID', u.userId], ['Email', u.email], ['Số điện thoại', u.phone],
          ['Họ tên', u.fullname], ['Tên hiển thị', u.displayTitle], ['Vai trò', u.role], ['Trạng thái', statusLabel(u.status)],
          ['Email đã xác minh', u.emailVerified ? 'có' : 'không'], ['SĐT đã xác minh', u.phoneVerified ? 'có' : 'không'],
          ['Giới tính', u.gender], ['Ngày sinh', u.birthday], ['Ngôn ngữ', u.preferredLanguage],
          ['Premium đến', Kit.dateTime(u.premiumUntil)], ['Providers', Kit.json(u.providers)],
          ['Tạo lúc', Kit.dateTime(u.createdAt)], ['Đăng nhập gần nhất', Kit.dateTime(u.lastSignInAt)],
          ['Địa chỉ', u.address], ['Tiểu sử', u.bio], ['Ảnh đại diện', u.avatarUrl],
        ];
        for (const [k, v] of facts) g.insertAdjacentHTML('beforeend', `<div class="k">${esc(k)}</div><div class="v">${esc(Kit.text(v))}</div>`);
        b.appendChild(g);
      } },
      { id: 'progress', label: 'Tiến độ & xu', render: async (b) => {
        const [pr, coins] = await Promise.all([
          rpc('tt_admin_profile_progress_get', { p_profile_id: pid }),
          rpc('tt_admin_profile_coin_ledger_get', { p_profile_id: pid, p_limit: 100 }),
        ]);
        const p = pr || {};
        const sum = (coins || []).reduce((a, r) => { const d = Number(r.delta) || 0; if (d > 0) a.in += d; else a.out += d; return a; }, { in: 0, out: 0 });
        Kit.kpis(b, [
          { label: 'Xu hiện tại', value: fmtNum(p.coinBalance) }, { label: 'EXP', value: fmtNum(p.expPoint) },
          { label: 'Streak ngày', value: fmtNum(p.streakDays) }, { label: 'Từ vựng thành thạo', value: fmtNum(p.fluentWordCount) },
          { label: 'Bài đã học', value: fmtNum(p.lessonLearned) },
          { label: 'Thu (100 dòng gần nhất)', value: `+${fmtNum(sum.in)}`, sub: `chi ${fmtNum(sum.out)}` },
        ]);
        // số dư thật theo thời gian: đi ngược từ số dư hiện tại qua từng dòng sổ
        const ord = (coins || []).filter(r => r.createdAt).sort((a, c) => new Date(a.createdAt) - new Date(c.createdAt));
        if (ord.length) {
          let bal = Number(p.coinBalance) || 0;
          const pts = [];
          for (let i = ord.length - 1; i >= 0; i--) {
            pts.unshift({ label: Kit.dm(ord[i].createdAt), value: bal });
            bal -= Number(ord[i].delta) || 0;
          }
          const byDay = new Map();
          for (const r of ord) {
            const k = Kit.dm(r.createdAt);
            const v = byDay.get(k) || { in: 0, out: 0 };
            const d = Number(r.delta) || 0;
            if (d > 0) v.in += d; else v.out -= d;
            byDay.set(k, v);
          }
          const g = el('div', 'kstats2');
          const c1 = el('div', 'kcard');
          c1.appendChild(el('h4', 'ksub', 'Số dư xu theo thời gian'));
          lineChart(c1, pts, { unit: ' xu' });
          const c2 = el('div');
          Kit.bars(c2, 'Xu nhận (+) / tiêu (−) theo ngày', [...byDay.entries()].slice(-12).flatMap(([k, v]) => [[`${k} +`, v.in], [`${k} −`, v.out]]).filter(e => e[1]));
          g.append(c1, c2);
          b.appendChild(g);
        }
        b.appendChild(ledger('Sổ xu (profile_coin_ledger)', coins || [], [
          dt, { key: 'delta', label: 'Thay đổi', render: r => (r.delta > 0 ? '+' : '') + fmtNum(r.delta) }, { key: 'reason', label: 'Lý do' },
        ]));
      } },
      { id: 'rewards', label: 'Phần thưởng', render: async (b) => {
        const rows = await rpc('tt_admin_profile_reward_log_get', { p_profile_id: pid, p_limit: 100 });
        b.appendChild(ledger('profile_reward_log', rows || [], [
          dt, { key: 'rewardId', label: 'Reward ID' }, { key: 'sourceType', label: 'Nguồn' },
          { key: '_d', label: '', sort: false, render: r => {
            const x = Admin.writeOnly(el('button', 'stop', '🗑'));
            x.title = 'Xoá dòng nhật ký thưởng';
            x.onclick = async () => {
              try {
                const ok = await Kit.write('tt_admin_profile_reward_log_delete', { p_log_id: Number(r.id) },
                  { confirm: `Xoá dòng phần thưởng #${esc(r.id)}?`, ok: 'Đã xoá', danger: true });
                if (ok) m.close(), this.detail(u);
              } catch (e) { toast(e.message, 'err'); }
            };
            return x;
          } },
        ]));
      } },
      { id: 'games', label: 'Lịch sử game', render: async (b) => {
        const [rows, titles] = await Promise.all([
          rpc('tt_admin_game_sessions_get', { p_profile_id: pid, p_limit: 100 }),
          gameTitles(),
        ]);
        const gname = r => titles[r.gameId] || `#${r.gameId}`;
        const scored = (rows || []).filter(r => typeof r.score === 'number')
          .sort((a, c) => new Date(a.startedAt || a.createdAt) - new Date(c.startedAt || c.createdAt));
        if (scored.length) {
          const c = el('div', 'kcard');
          c.appendChild(el('h4', 'ksub', `Điểm từng phiên (${scored.length} phiên có điểm, cũ → mới)`));
          columnChart(c, scored.map(r => ({
            label: Kit.dm(r.startedAt || r.createdAt),
            value: r.score, sub: gname(r),
          })));
          b.appendChild(c);
        }
        b.appendChild(ledger('Phiên chơi (game_session)', rows || [], [
          { key: 'startedAt', label: 'Bắt đầu', render: r => Kit.dateTime(r.startedAt || r.createdAt) },
          { key: 'gameId', label: 'Game', value: gname, render: gname }, { key: 'score', label: 'Điểm' },
          { key: 'resultStatus', label: 'Kết quả', render: r => Kit.badge(r.resultStatus || '—', r.resultStatus === 'completed' ? 'ok' : '') },
          { key: 'endedAt', label: 'Kết thúc', render: r => Kit.dateTime(r.endedAt) },
          { key: 'metadata', label: 'Metadata', render: r => { const s = Kit.json(r.metadata); return s.length > 60 ? s.slice(0, 60) + '…' : s; } },
        ]));
      } },
      { id: 'tasks', label: 'Nhiệm vụ online', render: async (b) => {
        const rows = await rpc('tt_admin_profile_online_tasks_get', { p_profile_id: pid, p_limit: 100 });
        b.appendChild(ledger('profile_task_progress + task', rows || [], [
          { key: 'title', label: 'Nhiệm vụ', render: r => r.title || r.taskKey }, { key: 'status', label: 'Trạng thái' },
          { key: 'progressPercent', label: 'Tiến độ', render: r => `${fmtNum(r.progressPercent)}%` },
          { key: 'dueAt', label: 'Hạn', render: r => Kit.dateTime(r.dueAt) },
          { key: 'completedAt', label: 'Xong lúc', render: r => Kit.dateTime(r.completedAt) },
        ]));
      } },
      { id: 'exp', label: 'EXP & vật phẩm', render: async (b) => {
        const [exp, items] = await Promise.all([
          rpc('tt_admin_profile_experience_get', { p_profile_id: pid, p_limit: 100 }),
          rpc('tt_admin_profile_items_get', { p_profile_id: pid, p_limit: 100 }),
        ]);
        b.appendChild(ledger('Sổ EXP (profile_experience)', exp || [], [
          dt, { key: 'delta', label: 'Thay đổi', render: r => (r.delta > 0 ? '+' : '') + fmtNum(r.delta) }, { key: 'reason', label: 'Lý do' },
        ]));
        const itemCols = items && items[0] ? Object.keys(items[0]).filter(k => k !== 'profileId').map(k => ({ key: k, label: k, render: r => Kit.json(r[k]) })) : [{ key: 'id', label: 'ID' }];
        b.appendChild(ledger('Vật phẩm (profile_item)', items || [], itemCols));
      } },
      { id: 'pay', label: 'Thanh toán', render: async (b) => {
        const r = await api(`/api/admin/tables/payment_transaction/rows?limit=50&order=createdAt&desc=1&f=${encodeURIComponent(`profileId|eq|${pid}`)}`);
        b.appendChild(ledger('payment_transaction', r.rows, [
          dt, { key: 'subscriptionPlanId', label: 'Gói' }, { key: 'provider', label: 'Cổng' },
          { key: 'amount', label: 'Số tiền', render: x => `${fmtNum(x.amount)} ${x.currency || ''}` },
          { key: 'status', label: 'Trạng thái' }, { key: 'paidAt', label: 'Trả lúc', render: x => Kit.dateTime(x.paidAt) },
        ]));
      } },
      { id: 'grant', label: 'Cộng & reset', render: (b) => this.grantPanel(b, u, () => { m.close(); this.load(); }) },
    ]);
  },

  grantPanel(b, u, done) {
    const pid = Number(u.profileId);
    b.appendChild(el('div', 'muted small', 'Mỗi lần cộng ghi một dòng vào sổ (ledger) và cập nhật profile_progress. Cần bật "Cho phép ghi".'));
    const grid = el('div', 'kgrid3');
    const card = (title, fields, fn, mk, okMsg) => {
      const c = el('div', 'acard');
      c.appendChild(el('h3', null, title));
      const f = Kit.form(fields, {});
      c.appendChild(f.node);
      const go = Admin.writeOnly(el('button', 'go', 'Thực hiện'));
      go.onclick = async () => {
        try {
          const v = f.read();
          const r = await Kit.write(fn, mk(v), { confirm: `${esc(title)} cho <b>${esc(u.email || pid)}</b>?<pre>${esc(JSON.stringify(v, null, 2))}</pre>`, ok: okMsg });
          if (r) done();
        } catch (e) { toast(e.message, 'err'); }
      };
      c.appendChild(go);
      grid.appendChild(c);
    };
    card('Cộng / trừ xu', [
      { key: 'amount', label: 'Số xu (+/-)', type: 'int', required: true },
      { key: 'reason', label: 'Lý do', type: 'text', placeholder: 'admin_grant' },
    ], 'tt_admin_user_account_grant_coin', v => ({ p_profile_id: pid, p_amount: v.amount, p_reason: v.reason || 'admin_grant' }), 'Đã cập nhật xu');
    card('Cộng EXP', [
      { key: 'amount', label: 'EXP', type: 'int', required: true },
      { key: 'reason', label: 'Lý do', type: 'text', placeholder: 'admin_grant_exp' },
    ], 'tt_admin_user_account_grant_exp', v => ({ p_profile_id: pid, p_amount: v.amount, p_reason: v.reason || 'admin_grant_exp' }), 'Đã cộng EXP');
    card('Tặng vật phẩm', [
      { key: 'itemId', label: 'Item ID', type: 'text', required: true, placeholder: 'sku / id' },
      { key: 'quantity', label: 'Số lượng', type: 'int', required: true, min: 1 },
    ], 'tt_admin_user_account_grant_item', v => ({ p_profile_id: pid, p_item_id: v.itemId, p_quantity: v.quantity }), 'Đã tặng vật phẩm');
    b.appendChild(grid);

    const danger = el('div', 'acard danger');
    danger.innerHTML = '<h3>Reset tiến độ</h3><p>Xoá hẳn sổ xu, sổ EXP và vật phẩm của tài khoản này, đưa tiến độ về 0. <b>Không khôi phục được.</b></p>';
    const rs = Admin.writeOnly(el('button', 'stop', '⟲  Reset tiến độ'));
    rs.onclick = async () => {
      try {
        const r = await Kit.write('tt_admin_user_account_reset_progress', { p_profile_id: pid }, {
          confirm: `Reset toàn bộ tiến độ của <b>${esc(u.email || pid)}</b>?<br><span class="err">Xoá hẳn sổ xu, EXP, vật phẩm — không khôi phục được.</span>`,
          ok: 'Đã reset tiến độ', danger: true,
        });
        if (r) done();
      } catch (e) { toast(e.message, 'err'); }
    };
    danger.appendChild(rs);
    b.appendChild(danger);
  },
};

Admin.register({
  id: 'users', title: 'Tài khoản', icon: '👤', group: 'Quản lý', order: 10,
  render: (main) => Users.render(main),
  onWriteChange: () => { if (Users.table) Users.draw(); },
});
