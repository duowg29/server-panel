/* Số liệu học tập (Dashboard P2): phiên chơi, điểm phát âm theo từng từ,
   thiết bị đang hoạt động. Số liệu tổng hợp ở backend: /api/admin/stats/learning. */

/** Ô điểm có thanh màu (đỏ < 50 ≤ vàng < 80 ≤ xanh). */
function scoreCell(v, sub) {
  if (v == null) return '—';
  const d = el('div', 'kscore ' + (v < 50 ? 'low' : v < 80 ? 'mid' : 'hi'));
  d.innerHTML = `<span class="b"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></span><b>${v}</b>` +
    (sub ? `<span class="muted small">${esc(sub)}</span>` : '');
  return d;
}

/** Phút → "1 giờ 05" / "12 phút". */
function fmtMin(m) {
  if (m == null) return '—';
  if (m < 60) return `${m} phút`;
  return `${Math.floor(m / 60)} giờ ${String(m % 60).padStart(2, '0')}`;
}

/** "English Vocabulary in Use - Elementary" → "Elementary". */
function shortPath(t) {
  return String(t || '—').replace(/^English Vocabulary in Use\s*[-–]\s*/i, '');
}

function h3(parent, text) {
  parent.appendChild(el('h3', 'kh3', text));
}

const LearningStats = {
  days: 30,
  minAttempts: 3,
  tab: 'overview',

  /** Thanh chọn kỳ dùng chung cho mọi màn của trang này. */
  periodBar(bar, onChange) {
    const days = el('select', 'ainput');
    days.innerHTML = [7, 30, 90, 180, 365].map(d => `<option value="${d}">${d} ngày</option>`).join('');
    days.value = String(this.days);
    const reload = el('button', '', '↻  Tải lại');
    bar.append(days, reload);
    days.onchange = () => { this.days = Number(days.value); onChange(); };
    reload.onclick = onChange;
  },

  async loading(host, f) {
    host.innerHTML = '';
    host.appendChild(el('div', 'aempty', 'Đang tổng hợp số liệu…'));
    try {
      const out = await f();
      host.innerHTML = '';
      return out;
    } catch (e) {
      host.innerHTML = '';
      host.appendChild(el('div', 'aempty err', e.message));
      return null;
    }
  },

  render(main, args = []) {
    if (args[0] === 'learner' && args[1]) return this.renderLearner(main, Number(args[1]));
    if (args[0] === 'unit' && args[1]) return this.renderUnit(main, Number(args[1]));
    const bar = pageHead(main, 'Số liệu học tập',
      'Phiên chơi, điểm phát âm theo từng từ và theo từng học sinh, thiết bị đang hoạt động. Giờ Việt Nam.');
    const host = el('div');
    main.appendChild(host);
    const draw = () => {
      host.innerHTML = '';
      Kit.tabs(host, [
        { id: 'overview', label: 'Tổng quan', render: b => { this.tab = 'overview'; return this.loadOverview(b); } },
        { id: 'learners', label: 'Học sinh', render: b => { this.tab = 'learners'; return this.loadLearners(b); } },
        { id: 'lessons', label: 'Bài học', render: b => { this.tab = 'lessons'; return this.loadLessons(b); } },
      ], this.tab);
    };
    this.periodBar(bar, draw);
    draw();
  },

  async loadOverview(host) {
    const got = await this.loading(host, () => Promise.all([
      api(`/api/admin/stats/learning?days=${this.days}&min_attempts=${this.minAttempts}`),
      rpc('tt_admin_user_analytics_snapshot').catch(() => null),
    ]));
    if (got) this.draw(host, got[0], got[1] || {}, () => this.loadOverview(host));
  },

  // ── danh sách học sinh ────────────────────────────────────────────
  async loadLearners(host) {
    const d = await this.loading(host, () => api(`/api/admin/stats/learners?days=${this.days}`));
    if (!d) return;
    const L = d.learners;
    const sum = k => L.reduce((a, r) => a + (r[k] || 0), 0);
    Kit.kpis(host, [
      { label: `Học sinh hoạt động · ${d.days} ngày`, value: fmtNum(L.length) },
      { label: 'Tổng phiên chơi', value: fmtNum(sum('sessions')) },
      { label: 'Tổng thời gian chơi', value: fmtMin(sum('playMinutes')) },
      { label: 'Tổng thời gian mở app', value: fmtMin(sum('onlineMinutes')), sub: 'theo heartbeat mỗi phút' },
      { label: 'Free Talk', value: `${fmtNum(sum('talks'))} phiên`, sub: fmtMin(sum('talkMinutes')) },
    ]);
    Kit.table(host, {
      rows: L, pageSize: 25, csvName: `hoc-sinh-${d.days}-ngay`, empty: 'Không có học sinh nào hoạt động trong kỳ.',
      onRow: r => { location.hash = `#/stats/learner/${r.profileId}`; },
      rowClass: () => 'clickable',
      columns: [
        { key: 'name', label: 'Học sinh', value: r => r.name || `#${r.profileId}`,
          render: r => {
            const row = el('div', 'kuser-row');
            const n = el('div');
            n.innerHTML = `<b>${esc(r.name || '—')}</b> <span class="muted small">#${r.profileId}</span>`;
            row.append(Kit.avatar(r.avatar, r.name, 28), n);
            return row;
          } },
        { key: 'daysActive', label: 'Số ngày học', render: r => fmtNum(r.daysActive) },
        { key: 'sessions', label: 'Phiên', render: r => fmtNum(r.sessions) },
        { key: 'playMinutes', label: 'Thời gian chơi', render: r => fmtMin(r.playMinutes) },
        { key: 'onlineMinutes', label: 'Mở app', render: r => fmtMin(r.onlineMinutes) },
        { key: 'flashAccuracy', label: 'Flashcard đúng', render: r => scoreCell(r.flashAccuracy, r.flashAnswered ? `${r.flashAnswered} thẻ` : '') },
        { key: 'pronAvg', label: 'Điểm phát âm', render: r => scoreCell(r.pronAvg, r.pronCount ? `${r.pronCount} lượt` : '') },
        { key: 'talks', label: 'Free Talk', render: r => (r.talks ? `${r.talks} · ${fmtMin(r.talkMinutes)}` : '—') },
        { key: '_g', label: 'Chơi nhiều', sort: false, value: r => r.topGames.map(g => `${g.title} ${g.count}`).join(' · '),
          render: r => r.topGames.map(g => `${g.title} ${g.count}`).join(' · ') || '—' },
        { key: 'lastActive', label: 'Hoạt động gần nhất', render: r => Kit.dateTime(r.lastActive) },
      ],
    });
    host.appendChild(el('div', 'muted small', 'Bấm vào một dòng để xem chi tiết từng từ, từng phiên của học sinh đó.'));
  },

  // ── theo bài học ──────────────────────────────────────────────────
  pathFilter: '',
  activeOnly: true,

  async loadLessons(host) {
    const d = await this.loading(host, () => api('/api/admin/stats/lessons'));
    if (!d) return;
    const T = d.totals;
    host.appendChild(el('div', 'muted small kstats-note', 'Tính từ trước tới nay (tiến độ học là luỹ kế) — không theo kỳ ngày ở trên.'));
    Kit.kpis(host, [
      { label: 'Unit có người học', value: `${fmtNum(T.activeUnits)} / ${fmtNum(T.units)}` },
      { label: 'Lượt hoàn thành unit', value: fmtNum(T.completions), sub: 'học sinh xong mọi nội dung bắt buộc' },
      { label: 'Phiên chơi trong unit', value: fmtNum(T.sessionsInUnits) },
      { label: 'Phiên ngoài lộ trình', value: fmtNum(T.sessionsNoUnit), sub: 'TinyFarm, game tự do, ôn từ yếu…' },
    ]);

    h3(host, 'Theo lộ trình');
    Kit.table(host, {
      rows: d.paths, pageSize: 10,
      onRow: r => { this.pathFilter = String(r.pathId); this.loadLessonsKeep(host, d); }, rowClass: () => 'clickable',
      columns: [
        { key: 'path', label: 'Lộ trình', render: r => shortPath(r.path) },
        { key: 'topics', label: 'Chủ đề', render: r => fmtNum(r.topics) },
        { key: 'activeUnits', label: 'Unit có người học', render: r => `${fmtNum(r.activeUnits)} / ${fmtNum(r.units)}` },
        { key: 'learners', label: 'Học sinh', render: r => fmtNum(r.learners) },
        { key: 'sessions', label: 'Phiên', render: r => fmtNum(r.sessions) },
        { key: 'completions', label: 'Hoàn thành unit', render: r => fmtNum(r.completions) },
        { key: 'flashAccuracy', label: 'Flashcard đúng', render: r => scoreCell(r.flashAccuracy) },
        { key: 'pronAvg', label: 'Điểm phát âm', render: r => scoreCell(r.pronAvg) },
      ],
    });

    const detail = el('div');
    host.appendChild(detail);
    this._lessons = { host: detail, data: d };
    this.drawLessonTables();
  },

  /** Bấm một lộ trình → lọc hai bảng dưới theo lộ trình đó, không tải lại. */
  loadLessonsKeep() {
    this.drawLessonTables();
    this._lessons.host.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  drawLessonTables() {
    const { host, data: d } = this._lessons;
    host.innerHTML = '';
    const pathSel = el('select', 'ainput');
    pathSel.innerHTML = '<option value="">Mọi lộ trình</option>' +
      d.paths.map(p => `<option value="${p.pathId}">${esc(shortPath(p.path))}</option>`).join('');
    pathSel.value = this.pathFilter;
    pathSel.onchange = () => { this.pathFilter = pathSel.value; this.drawLessonTables(); };
    const only = el('label', 'kcheck');
    only.innerHTML = `<input type="checkbox" ${this.activeOnly ? 'checked' : ''}> chỉ phần đã có người học`;
    only.querySelector('input').onchange = e => { this.activeOnly = e.target.checked; this.drawLessonTables(); };
    const bar = el('div', 'kcard__h kfilter');
    bar.append(el('span', 'muted small', 'Lọc:'), pathSel, only);
    host.appendChild(bar);

    const inPath = r => !this.pathFilter || String(r.pathId) === this.pathFilter;
    const topics = d.topics.filter(inPath).filter(r => !this.activeOnly || r.activeUnits);
    const units = d.units.filter(inPath).filter(r => !this.activeOnly || r.learners || r.sessions);

    h3(host, `Theo chủ đề · ${fmtNum(topics.length)}`);
    Kit.table(host, {
      rows: topics, pageSize: 10, csvName: 'chu-de', empty: 'Không có chủ đề nào khớp bộ lọc.',
      columns: [
        { key: 'topic', label: 'Chủ đề', render: r => { const n = el('div'); n.innerHTML = `<b>${esc(r.topic)}</b> <span class="muted small">${esc(shortPath(r.path))}</span>`; return n; }, value: r => r.topic },
        { key: 'level', label: 'Cấp', render: r => Kit.badge(r.level || '—') },
        { key: 'activeUnits', label: 'Unit có người học', render: r => `${fmtNum(r.activeUnits)} / ${fmtNum(r.units)}` },
        { key: 'learners', label: 'Học sinh', render: r => fmtNum(r.learners) },
        { key: 'sessions', label: 'Phiên', render: r => fmtNum(r.sessions) },
        { key: 'completions', label: 'Hoàn thành unit', render: r => fmtNum(r.completions) },
        { key: 'flashAccuracy', label: 'Flashcard đúng', render: r => scoreCell(r.flashAccuracy) },
        { key: 'pronAvg', label: 'Điểm phát âm', render: r => scoreCell(r.pronAvg) },
      ],
    });

    h3(host, `Theo unit · ${fmtNum(units.length)}`);
    Kit.table(host, {
      rows: units, pageSize: 15, csvName: 'unit', empty: 'Không có unit nào khớp bộ lọc.',
      onRow: r => { location.hash = `#/stats/unit/${r.unitId}`; }, rowClass: () => 'clickable',
      columns: [
        { key: 'unit', label: 'Unit', value: r => r.unit,
          render: r => { const n = el('div'); n.innerHTML = `<b>${esc(r.unit || '#' + r.unitId)}</b> <span class="muted small">${esc(r.topic || '')}</span>`; return n; } },
        { key: 'learners', label: 'Bắt đầu', render: r => fmtNum(r.learners) },
        { key: 'completed', label: 'Hoàn thành', render: r => fmtNum(r.completed) },
        { key: 'avgScore', label: 'Điểm bài TB', render: r => scoreCell(r.avgScore) },
        { key: 'sessions', label: 'Phiên', render: r => fmtNum(r.sessions) },
        { key: 'flashAccuracy', label: 'Flashcard đúng', render: r => scoreCell(r.flashAccuracy, r.flashAnswered ? `${r.flashAnswered} thẻ` : '') },
        { key: 'pronAvg', label: 'Điểm phát âm', render: r => scoreCell(r.pronAvg, r.words ? `${r.pronWords}/${r.words} từ` : '') },
        { key: 'last', label: 'Lần cuối', render: r => Kit.date(r.last) },
      ],
    });
    host.appendChild(el('div', 'muted small', 'Bấm một unit để xem từng nội dung, từng từ và tiến độ từng học sinh. Điểm phát âm là điểm chung của mọi người (vocabulary_global_stats) cho các từ thuộc unit.'));
  },

  renderUnit(main, uid) {
    const bar = pageHead(main, 'Unit', '');
    const back = el('button', 'ghost', '←  Bài học');
    back.onclick = () => { this.tab = 'lessons'; location.hash = '#/stats'; };
    bar.appendChild(back);
    const host = el('div');
    main.appendChild(host);
    const load = async () => {
      const d = await this.loading(host, () => api(`/api/admin/stats/lessons/units/${uid}`));
      if (!d) return;
      const u = d.unit;
      main.querySelector('.apage__head h2').textContent = u.unit || `Unit #${uid}`;
      const p = main.querySelector('.apage__head p') || el('p');
      p.textContent = `${shortPath(u.path)} › ${u.topic || '—'} · unit #${uid}`;
      if (!p.parentNode) main.querySelector('.apage__head h2').after(p);
      this.drawUnit(host, d);
    };
    const reload = el('button', '', '↻  Tải lại');
    reload.onclick = load;
    bar.appendChild(reload);
    load();
  },

  drawUnit(h, d) {
    const u = d.unit;
    Kit.kpis(h, [
      { label: 'Học sinh bắt đầu', value: fmtNum(u.learners) },
      { label: 'Hoàn thành', value: fmtNum(u.completed), sub: u.learners ? `${Math.round(u.completed * 100 / u.learners)}% số bắt đầu` : '' },
      { label: 'Điểm bài TB', value: u.avgScore == null ? '—' : String(u.avgScore) },
      { label: 'Phiên chơi', value: fmtNum(u.sessions), sub: `${fmtNum(u.players)} người` },
      { label: 'Flashcard đúng', value: u.flashAccuracy == null ? '—' : `${u.flashAccuracy}%`, sub: `${fmtNum(u.flashAnswered)} thẻ` },
      { label: 'Điểm phát âm TB', value: u.pronAvg == null ? '—' : String(u.pronAvg), sub: `${u.pronWords}/${u.words} từ đã được chấm` },
    ]);

    const g = el('div', 'kstats2');
    const c1 = el('div', 'kcard');
    c1.appendChild(el('h4', 'ksub', `Nội dung · ${d.contents.length}`));
    Kit.table(c1, {
      rows: d.contents, pageSize: 10, empty: 'Unit chưa có nội dung.',
      columns: [
        { key: 'order', label: '#', render: r => Kit.text(r.order) },
        { key: 'label', label: 'Nội dung', render: r => { const n = el('div'); n.innerHTML = `${esc(r.label)}${r.required ? '' : ' <span class="muted small">không bắt buộc</span>'}`; return n; } },
        { key: 'started', label: 'Bắt đầu', render: r => fmtNum(r.started) },
        { key: 'completed', label: 'Xong', render: r => fmtNum(r.completed) },
        { key: 'avgScore', label: 'Điểm TB', render: r => scoreCell(r.avgScore) },
      ],
    });
    const c2 = el('div', 'kcard');
    c2.appendChild(el('h4', 'ksub', `Học sinh · ${d.learners.length}`));
    Kit.table(c2, {
      rows: d.learners, pageSize: 10, empty: 'Chưa ai học unit này.',
      onRow: r => { location.hash = `#/stats/learner/${r.profileId}`; }, rowClass: () => 'clickable',
      columns: [
        { key: 'name', label: 'Học sinh', value: r => r.name || `#${r.profileId}`,
          render: r => { const row = el('div', 'kuser-row'); row.append(Kit.avatar(r.avatar, r.name, 24), el('span', null, r.name || `#${r.profileId}`)); return row; } },
        { key: 'done', label: 'Tiến độ', value: r => (r.total ? r.done / r.total : 0),
          render: r => scoreCell(r.total ? Math.round(r.done * 100 / r.total) : null, `${r.done}/${r.total}`) },
        { key: 'avgScore', label: 'Điểm TB', render: r => Kit.text(r.avgScore) },
        { key: 'last', label: 'Lần cuối', render: r => Kit.date(r.last) },
      ],
    });
    g.append(c1, c2);
    h.appendChild(g);

    h3(h, `Từ trong unit · ${fmtNum(d.words.length)}`);
    Kit.table(h, {
      rows: d.words, pageSize: 15, csvName: `unit-${u.unitId}-tu`, empty: 'Unit chưa gắn từ vựng.',
      columns: [
        { key: 'word', label: 'Từ', value: r => r.word || `#${r.vocabularyId}`, render: r => r.word || `#${r.vocabularyId}` },
        { key: 'level', label: 'Cấp', render: r => Kit.badge(r.level || '—') },
        { key: 'pronAvg', label: 'Điểm phát âm (mọi người)', render: r => scoreCell(r.pronAvg, r.pronAttempts ? `${r.pronAttempts} lượt` : '') },
        { key: 'accuracy', label: 'Flashcard đúng (trong unit)', render: r => scoreCell(r.accuracy, r.correct + r.wrong ? `${r.correct}/${r.correct + r.wrong}` : '') },
      ],
    });
    h.appendChild(el('div', 'muted small', `Tổng hợp lúc ${Kit.dateTime(d.generatedAt)}. Từ khó nhất xếp lên đầu.`));
  },

  // ── chi tiết một học sinh ─────────────────────────────────────────
  renderLearner(main, pid) {
    const bar = pageHead(main, 'Học sinh', '');
    const back = el('button', 'ghost', '←  Danh sách học sinh');
    back.onclick = () => { this.tab = 'learners'; location.hash = '#/stats'; };
    bar.appendChild(back);
    const host = el('div');
    main.appendChild(host);
    const load = async () => {
      const d = await this.loading(host, () => api(`/api/admin/stats/learners/${pid}?days=${this.days}`));
      if (!d) return;
      const h2 = main.querySelector('.apage__head h2');
      h2.textContent = d.profile.name || `Profile #${pid}`;
      h2.classList.add('kuser-row');
      h2.prepend(Kit.avatar(d.profile.avatar, d.profile.name, 36));
      const p = main.querySelector('.apage__head p') || el('p');
      p.textContent = `#${pid} · tạo ${Kit.date(d.profile.createdAt)} · số liệu ${d.days} ngày gần nhất`;
      if (!p.parentNode) main.querySelector('.apage__head h2').after(p);
      this.drawLearner(host, d);
    };
    this.periodBar(bar, load);
    load();
  },

  drawLearner(h, d) {
    const s = d.summary;
    if (!s) {
      h.appendChild(el('div', 'aempty', `Học sinh này không có hoạt động nào trong ${d.days} ngày qua — thử chọn kỳ dài hơn.`));
      return;
    }
    Kit.kpis(h, [
      { label: 'Số ngày học', value: fmtNum(s.daysActive) },
      { label: 'Phiên chơi', value: fmtNum(s.sessions), sub: fmtMin(s.playMinutes) },
      { label: 'Mở app', value: fmtMin(s.onlineMinutes) },
      { label: 'Flashcard đúng', value: s.flashAccuracy == null ? '—' : `${s.flashAccuracy}%`, sub: `${fmtNum(s.flashAnswered)} thẻ` },
      { label: 'Điểm phát âm TB', value: s.pronAvg == null ? '—' : `${s.pronAvg}`, sub: `${fmtNum(s.pronCount)} lượt chấm` },
      { label: 'Free Talk', value: `${fmtNum(s.talks)} phiên`, sub: fmtMin(s.talkMinutes) },
      { label: 'Hoạt động gần nhất', value: Kit.date(s.lastActive),
        sub: s.lastActive ? new Date(s.lastActive).toLocaleTimeString('vi-VN') : '' },
    ]);

    const g = el('div', 'kstats2');
    const left = el('div', 'kcard');
    left.appendChild(el('h4', 'ksub', 'Thời gian mở app mỗi ngày'));
    columnChart(left, d.byDay.map(x => ({ label: x.day.slice(5).split('-').reverse().join('/'), value: x.minutes, sub: `${x.sessions} phiên` })), { unit: ' phút' });
    const right = el('div', 'kcard');
    right.appendChild(el('h4', 'ksub', 'Theo game'));
    Kit.table(right, {
      rows: d.games, pageSize: 8, empty: 'Chưa chơi game nào trong kỳ.',
      columns: [
        { key: 'title', label: 'Game' }, { key: 'count', label: 'Phiên', render: r => fmtNum(r.count) },
        { key: 'minutes', label: 'Thời gian', render: r => fmtMin(r.minutes) },
        { key: 'avgScore', label: 'Điểm TB', render: r => (r.avgScore == null ? '—' : String(r.avgScore)) },
      ],
    });
    g.append(left, right);
    h.appendChild(g);

    h.appendChild(el('h3', 'kh3', `Từ đã luyện · ${fmtNum(d.words.length)} từ`));
    Kit.table(h, {
      rows: d.words, pageSize: 15, csvName: `tu-cua-${d.profile.id}`,
      empty: 'Chưa có từ nào — flashcard và chấm phát âm của học sinh sẽ hiện ở đây.',
      columns: [
        { key: 'word', label: 'Từ', value: r => r.word || `#${r.vocabularyId}`, render: r => r.word || `#${r.vocabularyId}` },
        { key: 'level', label: 'Cấp', render: r => Kit.badge(r.level || '—') },
        { key: 'accuracy', label: 'Flashcard đúng', render: r => scoreCell(r.accuracy, r.correct + r.wrong ? `${r.correct}/${r.correct + r.wrong}` : '') },
        { key: 'pronAvg', label: 'Điểm phát âm', render: r => scoreCell(r.pronAvg, r.pronCount ? `${r.pronCount} lượt` : '') },
        { key: 'wrong', label: 'Sai', render: r => fmtNum(r.wrong) },
        { key: 'last', label: 'Lần cuối', render: r => Kit.dateTime(r.last) },
      ],
    });

    const g2 = el('div', 'kstats2');
    const rs = el('div', 'kcard');
    rs.appendChild(el('h4', 'ksub', 'Phiên chơi gần đây'));
    Kit.table(rs, {
      rows: d.recent, pageSize: 10, empty: 'Chưa có phiên nào.',
      columns: [
        { key: 'startedAt', label: 'Lúc', render: r => Kit.dateTime(r.startedAt) },
        { key: 'game', label: 'Game' },
        { key: 'minutes', label: 'Phút', render: r => (r.minutes ? String(r.minutes) : '—') },
        { key: 'score', label: 'Điểm', render: r => Kit.text(r.score) },
        { key: 'result', label: 'Kết quả', render: r => Kit.badge(r.result || '—', r.result === 'completed' ? 'ok' : '') },
        { key: 'correct', label: 'Đúng / sai', render: r => (r.correct + r.wrong ? `${r.correct} / ${r.wrong}` : '—') },
      ],
    });
    const ft = el('div', 'kcard');
    ft.appendChild(el('h4', 'ksub', 'Free Talk / Story'));
    Kit.table(ft, {
      rows: d.talks, pageSize: 10, empty: 'Chưa có phiên Free Talk nào.',
      columns: [
        { key: 'startedAt', label: 'Lúc', render: r => Kit.dateTime(r.startedAt) },
        { key: 'activity', label: 'Loại', render: r => (r.activity === 'story' ? 'Story' : 'Free Talk') },
        { key: 'minutes', label: 'Phút', render: r => String(r.minutes) },
        { key: 'turns', label: 'Lượt nói', render: r => Kit.text(r.turns) },
      ],
    });
    g2.append(rs, ft);
    h.appendChild(g2);
    h.appendChild(el('div', 'muted small', `Tổng hợp lúc ${Kit.dateTime(d.generatedAt)}. Flashcard đúng/sai lấy từ phiên chơi; điểm phát âm từ sự kiện vocabulary-learned.`));
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
      { label: 'Free Talk / Story', value: `${fmtNum(d.freeTalk.sessions)} phiên`,
        sub: d.freeTalk.sessions ? `TB ${d.freeTalk.avgMinutes} phút · ${d.freeTalk.avgTurns} lượt nói` : `${d.freeTalk.players} người` },
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
      { key: 'avgScore100', label: 'Điểm TB', render: r => scoreCell(r.avgScore100) },
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
  render: (main, args) => LearningStats.render(main, args),
});
