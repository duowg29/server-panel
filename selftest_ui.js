/* Self-test cho frontend:  node selftest_ui.js

   Bất biến cần khoá: syncCard() phải cho ra ĐÚNG cái mà dựng lại từ đầu cho ra.
   Card giờ chỉ dựng một lần rồi cập nhật tại chỗ (để bảng "⋯ Thêm" đang mở
   không bị sập mỗi 2 giây); cái giá của cách đó là card có thể "kẹt" ở trạng
   thái cũ khi quên xoá một nhánh. Test này so hai đường với nhau nên phát hiện
   ngay, kể cả nội dung cũ còn sót trong node đã ẩn.

   KHÔNG dùng jsdom: server-panel không có build step và không có dependency
   npm nào — shim ở dưới vừa đủ những gì app.js đụng tới. Chạy được với node
   trần, không cần cài gì. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── DOM tối thiểu ────────────────────────────────────────────────────
class ClassList {
  constructor(el) { this.el = el; }
  get _set() { return new Set((this.el.className || '').split(/\s+/).filter(Boolean)); }
  _write(s) { this.el.className = [...s].join(' '); }
  add(c) { const s = this._set; s.add(c); this._write(s); }
  remove(c) { const s = this._set; s.delete(c); this._write(s); }
  contains(c) { return this._set.has(c); }
  toggle(c, on) { on === undefined ? (this.contains(c) ? this.remove(c) : this.add(c))
    : (on ? this.add(c) : this.remove(c)); }
}

class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.className = ''; this._text = '';
    this.style = {}; this.dataset = {}; this.hidden = false; this.title = '';
    this.disabled = false; this.classList = new ClassList(this); this.parentNode = null;
    this.value = '';
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach(c => this.appendChild(c)); }
  removeChild(c) { this.children = this.children.filter(x => x !== c); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.children[0]; }
  set textContent(v) { this._text = v == null ? '' : String(v); this.children = []; }
  get textContent() {
    return this.children.length ? this.children.map(c => c.textContent).join('') : this._text;
  }
  set innerHTML(v) { this._html = v; this.children = []; this._text = ''; }
  get innerHTML() { return this._html || ''; }
  removeAttribute(k) { delete this[k]; }
  querySelector() { return null; }
  querySelectorAll(sel) {
    // đủ cho applyFilter(): '#groups .sec' và '.card'
    const out = [];
    const want = sel.trim().split(/\s+/).pop().replace('.', '');
    const walk = n => n.children.forEach(c => {
      if ((c.className || '').split(/\s+/).includes(want)) out.push(c);
      walk(c);
    });
    walk(this);
    return out;
  }
  addEventListener() {}
  /** ảnh chụp có thể so sánh: đủ mọi thứ hiển thị ra được */
  snap() {
    return {
      tag: this.tagName, cls: this.className, text: this._text,
      hidden: this.hidden, title: this.title, disabled: this.disabled,
      style: Object.fromEntries(Object.entries(this.style).filter(([, v]) => v !== '')),
      html: this._html || '', href: this.href || '',
      kids: this.children.map(c => c.snap()),
    };
  }
}

const byId = {};
const doc = {
  createElement: t => new El(t),
  querySelectorAll: sel => (byId['#groups'] ? byId['#groups'].querySelectorAll(sel) : []),
  querySelector: sel => byId[sel] || (byId[sel] = new El('div')),
  getElementById: id => byId['#' + id] || (byId['#' + id] = new El('div')),
  addEventListener() {},
  body: new El('body'),
};

const sandbox = {
  document: doc,
  window: { addEventListener() {}, innerWidth: 1200 },
  location: { host: '127.0.0.1:9199' },
  WebSocket: function () { return { close() {}, send() {} }; },
  fetch: () => new Promise(() => {}),
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  requestAnimationFrame: () => 0,
  Notification: function () {},
  console,
  JSON, Math, Date, Set, Map, Array, Object, String, Number, RegExp, Promise, isFinite,
};
sandbox.globalThis = sandbox;

const read = f => fs.readFileSync(path.join(__dirname, 'panel', 'static', f), 'utf8');
vm.createContext(sandbox);
// charts.js nạp trước, đúng thứ tự như index.html
vm.runInContext(read('charts.js') +
  '\n;globalThis.__c = { stateTimeline, scatterPoints, stackedArea, lineMulti, _tLabel, esc };',
  sandbox);
// `const State` không thành thuộc tính của global trong vm — xuất ra tường minh
vm.runInContext(read('app.js') +
  '\n;globalThis.__x = { State, $, renderGroups, syncAll, applyFilter };', sandbox);
const X = sandbox.__x;
const C = sandbox.__c;

// ── dữ liệu giả ──────────────────────────────────────────────────────
const CFG = {
  readonly: false,
  groups: [{ id: 'core', label: 'CORE', hidden: false }],
  services: [
    { id: 'speech', name: 'TinySpeech', group: 'core', kind: 'process', port: 8000,
      log: '/tmp/a.log', can_start: true, can_stop: true, actions: [],
      depends_on: [], conflicts_with: [], note: 'ghi chú tĩnh' },
    { id: 'hybrid', name: 'Hybrid stack', group: 'core', kind: 'composite',
      can_start: true, can_stop: true, actions: [], depends_on: [],
      conflicts_with: [], members: ['speech'] },
  ],
};

const SCENARIOS = [
  { name: 'tất cả OFFLINE', status: {
    speech: { state: 'OFFLINE' }, hybrid: { state: 'OFFLINE' } } },
  { name: 'speech ONLINE có pid/uptime/latency', status: {
    speech: { state: 'ONLINE', pid: 123, uptime_s: 3725, latency_ms: 12,
              detail: ['whisper large-v3'] },
    hybrid: { state: 'STARTING', progress: { pct: 50, done: 1, total: 2,
              current: 'cpu_inf', label: '47%|####7' } } } },
  { name: 'NO_ENV thiếu file', status: {
    speech: { state: 'NO_ENV', missing: ['venv', 'model.bin'] },
    hybrid: { state: 'NO_ENV', missing: ['venv'] } } },
  { name: 'DEGRADED + public_url + blocked_by', status: {
    speech: { state: 'DEGRADED', pid: 9, public_url: 'https://x.ngrok.app',
              blocked_by: ['vllm_chat'] },
    hybrid: { state: 'ONLINE', progress: { pct: 100, done: 2, total: 2 } } } },
  { name: 'OFFLINE kèm error', status: {
    speech: { state: 'OFFLINE', error: 'ConnectError' }, hybrid: { state: 'OFFLINE' } } },
  { name: 'quay lại ONLINE (xoá hết phần thừa)', status: {
    speech: { state: 'ONLINE', pid: 5, uptime_s: 30 }, hybrid: { state: 'ONLINE' } } },
];

let fails = 0;
const check = (name, ok, extra = '') => {
  console.log((ok ? '  ok  ' : 'FAIL  ') + name + (extra ? '  — ' + extra : ''));
  if (!ok) fails++;
};

const S = X.State;
S.cfg = CFG;

// Đường A: dựng lại từ đầu cho mỗi kịch bản (hành vi cũ)
const fresh = SCENARIOS.map(sc => {
  S.status = sc.status;
  X.renderGroups();
  return X.$('#groups').snap();
});

// Đường B: dựng MỘT lần rồi chỉ sync qua từng kịch bản (hành vi mới)
S.status = SCENARIOS[0].status;
X.renderGroups();
const incr = SCENARIOS.map(sc => {
  S.status = sc.status;
  X.syncAll();
  return X.$('#groups').snap();
});

SCENARIOS.forEach((sc, i) => {
  const a = JSON.stringify(fresh[i]);
  const b = JSON.stringify(incr[i]);
  check(`sync == dựng lại · ${sc.name}`, a === b,
    a === b ? '' : 'khác nhau ở DOM');
  if (a !== b) {
    const walk = (x, y, p) => {
      if (JSON.stringify(x) === JSON.stringify(y)) return;
      const keys = ['tag','cls','text','hidden','title','disabled','html'];
      for (const k of keys) if (JSON.stringify(x[k]) !== JSON.stringify(y[k]))
        console.log(`   ${p}.${k}: dựng lại=${JSON.stringify(x[k])}  sync=${JSON.stringify(y[k])}`);
      if (JSON.stringify(x.style) !== JSON.stringify(y.style))
        console.log(`   ${p}.style: ${JSON.stringify(x.style)} vs ${JSON.stringify(y.style)}`);
      const n = Math.max(x.kids.length, y.kids.length);
      if (x.kids.length !== y.kids.length)
        console.log(`   ${p}: số con ${x.kids.length} vs ${y.kids.length}`);
      for (let i = 0; i < n; i++) {
        if (!x.kids[i]) { console.log(`   ${p}[${i}] chỉ có ở sync: ${JSON.stringify(y.kids[i]).slice(0,120)}`); continue; }
        if (!y.kids[i]) { console.log(`   ${p}[${i}] chỉ có ở dựng lại: ${JSON.stringify(x.kids[i]).slice(0,120)}`); continue; }
        walk(x.kids[i], y.kids[i], `${p}[${i}]`);
      }
    };
    walk(fresh[i], incr[i], 'root');
  }
});

// Bảng "⋯ Thêm" đang mở phải CÒN mở sau khi sync — chính là lỗi cần sửa
const card = X.$('#groups').children[0].children[1].children[0];
const more = card.children.find(c => c.className === 'btns more');
check('card có bảng "Thêm"', !!more);
if (more) {
  more.style.display = 'flex';                 // người dùng bấm mở
  S.status = SCENARIOS[1].status;
  X.syncAll();
  check('bảng "Thêm" vẫn mở sau syncAll', more.style.display === 'flex',
    `display=${more.style.display}`);
  X.renderGroups();                      // reload config thì dựng lại là đúng
  const card2 = X.$('#groups').children[0].children[1].children[0];
  const more2 = card2.children.find(c => c.className === 'btns more');
  check('renderGroups vẫn dựng lại (dùng khi config đổi)', more2 !== more);
}

// ── charts.js ────────────────────────────────────────────────────────
console.log();
const box = () => new El('div');
const T0 = 1750000000;   // mốc cố định: test không được phụ thuộc giờ chạy

// Timeline trạng thái: thang màu phải theo config.SEVERITY ở backend
{
  const el2 = box();
  C.stateTimeline(el2, {
    t0: T0, bucket_s: 30, incidents: [{ t: T0 + 60, kind: 'down', name: 'TinySpeech' }],
    series: [
      { label: 'speech', data: [0, 0, 4, 4, 0] },      // ONLINE → OFFLINE → ONLINE
      { label: 'intent', data: [null, null, 0, 0, 0] }, // chưa có mẫu rồi mới lên
    ],
  });
  const h = el2.innerHTML;
  check('timeline vẽ ra svg', h.includes('<svg'));
  check('timeline có nhãn service', h.includes('speech') && h.includes('intent'));
  check('timeline tô đỏ đoạn OFFLINE', h.includes('var(--red)'));
  check('timeline tô xanh đoạn ONLINE', h.includes('var(--green)'));
  check('timeline có vạch sự cố', h.includes('stroke-dasharray="3 3"'));
  // hai ô OFFLINE liền nhau phải gộp thành MỘT rect, không vẽ từng ô
  const reds = (h.match(/fill="var\(--red\)"/g) || []).length;
  check('gộp ô liền nhau cùng trạng thái', reds === 1, `${reds} rect đỏ`);
  // null = không có mẫu → KHÔNG được tô như ONLINE
  const greens = (h.match(/fill="var\(--green\)"/g) || []).length;
  check('null để trống, không bịa là ONLINE', greens === 3, `${greens} rect xanh`);

  C.stateTimeline(el2, { t0: T0, bucket_s: 30, series: [] });
  check('timeline không có dữ liệu thì báo rõ', el2.innerHTML.includes('nodata'));
}

// Nhãn trục thời gian: mốc rộng phải là giờ đồng hồ, không phải "-1440p"
{
  check('dưới 1 giờ: nhãn tương đối', C._tLabel(90, 300, T0) === '-2p', C._tLabel(90, 300, T0));
  check('mép phải: "bây giờ"', C._tLabel(0, 300, T0) === 'bây giờ');
  const lbl = C._tLabel(86400, 86400, T0);
  check('24 giờ: nhãn là giờ đồng hồ HH:MM', /^\d{2}:\d{2}$/.test(lbl), lbl);
}

// Nhãn request qua ngrok do NGƯỜI NGOÀI sinh ra — phải escape
{
  const el2 = box();
  C.scatterPoints(el2, [{ t: T0, y: 5, status: 200, label: '<img src=x onerror=alert(1)>' }],
    { t0: T0, t1: T0 + 60 });
  check('nhãn scatter được escape', !el2.innerHTML.includes('<img'),
    el2.innerHTML.includes('&lt;img') ? 'đã thành &lt;img' : 'KHÔNG escape');
}

// Vùng chồng: cả cửa sổ không có mẫu thì phải ĐỨT, không tụt về 0
{
  const el2 = box();
  C.stackedArea(el2, {
    t0: T0, bucket_s: 30, unit: 'MB',
    series: [{ label: 'a', data: [10, 20, null, null, 30, 40] }],
  });
  const paths = (el2.innerHTML.match(/<path d="M/g) || []).length;
  // 2 đoạn dữ liệu × (nền + viền) = 4 path, thay vì 2 path liền một mạch qua khoảng trống
  check('vùng chồng đứt ở chỗ không có mẫu', paths === 4, `${paths} path`);
}

// ── Lọc service ──────────────────────────────────────────────────────
{
  S.status = SCENARIOS[1].status;
  X.renderGroups();
  const filt = X.$('#svc-filter');
  const cards = () => X.$('#groups').querySelectorAll('.card');
  const visible = () => cards().filter(c => !c.hidden).length;

  check('chưa lọc thì hiện hết', visible() === 2, `${visible()}/2`);

  filt.value = 'speech'; X.applyFilter();
  check('lọc theo tên hiện đúng 1', visible() === 1, `${visible()} card`);

  filt.value = 'ONLINE'; X.applyFilter();
  check('lọc theo trạng thái được', visible() >= 1, `${visible()} card`);

  filt.value = 'khongcogi'; X.applyFilter();
  check('không khớp gì thì ẩn hết', visible() === 0, `${visible()} card`);

  filt.value = ''; X.applyFilter();
  check('xoá ô lọc thì hiện lại hết', visible() === 2, `${visible()}/2`);

  // Lọc KHÔNG được xoá node — nếu xoá thì bảng "Thêm" đang mở sẽ mất
  const card0 = cards()[0];
  const more0 = card0.children.find(c => c.className === 'btns more');
  more0.style.display = 'flex';
  filt.value = 'speech'; X.applyFilter();
  filt.value = ''; X.applyFilter();
  check('lọc xong bảng "Thêm" vẫn mở', more0.style.display === 'flex',
    `display=${more0.style.display}`);
}

console.log(fails ? `\n${fails} test HỎNG` : '\ntất cả test DOM pass');
process.exit(fails ? 1 : 0);
