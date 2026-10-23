/* Số liệu học tập (Dashboard P2): phiên chơi, điểm phát âm theo từng từ,
   thiết bị đang hoạt động. Số liệu tổng hợp ở backend: /api/admin/stats/learning. */

/** Biểu đồ cột đứng (SVG) — data: [{label, value, sub}]. */
function columnChart(parent, data, { height = 170, unit = '' } = {}) {
  const box = el('div', 'kcol');
  const w = Math.max(data.length * 22, 300);
  const max = Math.max(1, ...data.map(d => d.value));
  const bw = w / data.length;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${height + 22}`);
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
    if (data.length <= 31 ? i % Math.ceil(data.length / 10) === 0 || i === data.length - 1 : i % 7 === 0) {
      const tx = document.createElementNS(svgNS, 'text');
      Object.entries({ x: i * bw + bw / 2, y: height + 16, class: 'lbl' }).forEach(([k, v]) => tx.setAttribute(k, v));
      tx.textContent = d.label;
      svg.appendChild(tx);
    }
  });
  box.appendChild(svg);
  box.appendChild(el('div', 'kcol__max muted small', `cao nhất ${fmtNum(max)}${unit}`));
  parent.appendChild(box);
  return box;
}

const LearningStats = {
  days: 30,
  minAttempts: 3,

  render(main) {
    const bar = pageHead(main, 'Số liệu học tập',
      'Phiên chơi, điểm phát âm trung bình theo từng từ (vocabulary_global_stats), thiết bị đang hoạt động. Giờ Việt Nam.');
    const days = el('select', 'ainput');
    days.innerHTML = [7, 30, 90, 180].map(d => `<option value="${d}">${d} ngày</option>`).join('');
    days.value = String(this.days);
    const reload = el('button', '', '↻  Tải lại');
    bar.append(days, reload);
    const host = el('div');
    main.appendChild(host);
    const load = async () => {
      host.innerHTML = '';
      host.appendChild(el('div', 'aempty', 'Đang tổng hợp số liệu…'));
      try {
        const [d, an] = await Promise.all([
          api(`/api/admin/stats/learning?days=${this.days}&min_attempts=${this.minAttempts}`),
          rpc('tt_admin_user_analytics_snapshot').catch(() => null),
        ]);
        host.innerHTML = '';
        this.draw(host, d, an || {}, load);
      } catch (e) { host.innerHTML = ''; host.appendChild(el('div', 'aempty err', e.message)); }
    };
    days.onchange = () => { this.days = Number(days.value); load(); };
    reload.onclick = load;
    load();
  },

  draw(h, d, an, reload) {
    const s = d.sessions, p = d.pronunciation, dv = d.devices;

    // ── phiên chơi ────────────────────────────────────────────────────
    h.appendChild(el('h3', 'kh3', `Phiên chơi · ${d.days} ngày`));
    Kit.kpis(h, [
      { label: `Phiên trong ${d.days} ngày`, value: fmtNum(s.inRange) },
      { label: 'Hôm nay', value: fmtNum(s.today) },
      { label: '7 ngày qua', value: fmtNum(s.last7) },
      { label: 'Người chơi', value: fmtNum(s.players) },
      { label: 'DAU / WAU / MAU', value: `${fmtNum(an.dau)} / ${fmtNum(an.wau)} / ${fmtNum(an.mau)}`, sub: 'người dùng app' },
    ]);
    const grid = el('div', 'kstats2');
    const left = el('div', 'kcard');
    left.appendChild(el('h4', 'ksub', 'Số phiên mỗi ngày'));
    columnChart(left, s.byDay.map(x => ({ label: x.day.slice(5).split('-').reverse().join('/'), value: x.count, sub: `${x.players} người` })));
    const right = el('div', 'kcard');
    right.appendChild(el('h4', 'ksub', 'Theo game'));
    Kit.table(right, {
      rows: s.byGame, pageSize: 8, empty: 'Không có phiên nào trong kỳ.',
      columns: [
        { key: 'title', label: 'Game' }, { key: 'count', label: 'Phiên', render: r => fmtNum(r.count) },
        { key: 'players', label: 'Người', render: r => fmtNum(r.players) },
        { key: 'avgScore', label: 'Điểm TB', render: r => (r.avgScore == null ? '—' : String(r.avgScore)) },
        { key: '_r', label: 'Kết quả', sort: false, render: r => Object.entries(r.results).map(([k, n]) => `${k} ${n}`).join(' · ') },
      ],
    });
    grid.append(left, right);
    h.appendChild(grid);

    // ── phát âm ───────────────────────────────────────────────────────
    h.appendChild(el('h3', 'kh3', 'Điểm phát âm theo từng từ'));
    Kit.kpis(h, [
      { label: 'Điểm TB (theo lượt chấm)', value: p.avgWeighted == null ? '—' : `${p.avgWeighted}`, sub: 'mỗi lượt chấm tính một lần' },
      { label: 'Điểm TB (theo từ)', value: p.avgPlain == null ? '—' : `${p.avgPlain}`, sub: 'mỗi từ tính một lần' },
      { label: 'Từ đã được chấm', value: fmtNum(p.words) },
      { label: 'Lượt chấm', value: fmtNum(p.attempts) },
      { label: 'Tỉ lệ đọc đúng', value: p.attempts ? `${Math.round(p.correct * 100 / p.attempts)}%` : '—' },
      { label: 'Cập nhật gần nhất', value: Kit.date(p.lastUpdate) },
    ]);
    const g2 = el('div', 'kstats2');
    Kit.bars(g2, 'Phân bố điểm (số từ theo khoảng điểm)', p.histogram.map(b => [`${b.from}–${b.to === 100 ? 100 : b.to - 1}`, b.words]));
    const tabsBox = el('div', 'kcard');
    const minSel = el('select', 'ainput');
    minSel.innerHTML = [1, 3, 5, 10].map(n => `<option value="${n}">≥ ${n} lượt</option>`).join('');
    minSel.value = String(this.minAttempts);
    minSel.onchange = () => { this.minAttempts = Number(minSel.value); reload(); };
    const head = el('div', 'kcard__h');
    head.append(el('h4', 'ksub', 'Từ theo điểm'), el('span', 'muted small', 'chỉ tính từ có'), minSel);
    tabsBox.appendChild(head);
    const wordCols = [
      { key: 'word', label: 'Từ', render: r => r.word || `#${r.vocabularyId}` },
      { key: 'level', label: 'Cấp', render: r => Kit.badge(r.level || '—') },
      { key: 'avgScore100', label: 'Điểm TB', render: r => {
        const d2 = el('div', 'kscore');
        d2.innerHTML = `<span class="b"><i style="width:${r.avgScore100}%"></i></span><b>${r.avgScore100}</b>`;
        d2.classList.add(r.avgScore100 < 50 ? 'low' : r.avgScore100 < 80 ? 'mid' : 'hi');
        return d2;
      } },
      { key: 'attempts', label: 'Lượt', render: r => fmtNum(r.attempts) },
      { key: 'correct', label: 'Đúng', render: r => fmtNum(r.correct) },
    ];
    Kit.tabs(tabsBox, [
      { id: 'hard', label: 'Khó nhất', render: b => Kit.table(b, { rows: p.hardest, pageSize: 10, columns: wordCols, empty: 'Chưa có từ đủ số lượt.' }) },
      { id: 'easy', label: 'Dễ nhất', render: b => Kit.table(b, { rows: p.easiest, pageSize: 10, columns: wordCols, empty: 'Chưa có từ đủ số lượt.' }) },
      { id: 'most', label: 'Luyện nhiều nhất', render: b => Kit.table(b, { rows: p.mostPracticed, pageSize: 10, columns: wordCols }) },
    ]);
    g2.appendChild(tabsBox);
    h.appendChild(g2);

    // ── thiết bị ──────────────────────────────────────────────────────
    const tb = dv.tinybot;
    h.appendChild(el('h3', 'kh3', 'Thiết bị đang hoạt động'));
    Kit.kpis(h, [
      { label: 'TinyBot đã gắn', value: fmtNum(tb.total), sub: Object.entries(tb.byStatus).map(([k, n]) => `${k} ${n}`).join(' · ') },
      { label: 'TinyBot hoạt động 24 giờ', value: fmtNum(tb.active24h) },
      { label: 'TinyBot hoạt động 7 ngày', value: fmtNum(tb.active7d) },
    ]);
    Kit.table(h, {
      rows: tb.list, pageSize: 10, empty: 'Chưa có TinyBot nào.',
      columns: [
        { key: 'deviceId', label: 'Thiết bị' }, { key: 'profileId', label: 'Profile' },
        { key: 'connectionStatus', label: 'Trạng thái', render: r => Kit.badge(r.connectionStatus || '—', r.connectionStatus === 'online' ? 'ok' : '') },
        { key: 'isPrimary', label: 'Chính', render: r => (r.isPrimary ? '✓' : '—') },
        { key: 'lastSeenAt', label: 'Thấy lần cuối', render: r => Kit.dateTime(r.lastSeenAt) },
      ],
    });
    h.appendChild(el('div', 'muted small', `Tổng hợp lúc ${Kit.dateTime(d.generatedAt)}.`));
  },
};

Admin.register({
  id: 'stats', title: 'Số liệu học tập', icon: '📈', group: 'Quản lý', order: 9,
  render: main => LearningStats.render(main),
});
