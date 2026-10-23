/* Tổng quan + Nhật ký + chỗ cho các mục đang chuyển từ tinytalk-admin. */

const ADMIN_SECTIONS = [
  // id, tiêu đề, biểu tượng, mô tả (đúng các mục của tinytalk-admin)
  ['users', 'Tài khoản', '👤', 'Tài khoản đăng nhập + hồ sơ: tìm, xem tiến độ / xu / lịch sử, khoá, cộng xu / EXP / vật phẩm, reset, xoá.'],
  ['lessons', 'Nội dung học', '📚', 'Lộ trình → topic → unit → nội dung; từ vựng, ngữ pháp, game; nhập hàng loạt, quét tài liệu.'],
  ['notifications', 'Thông báo', '🔔', 'Mẫu thông báo, gửi theo nhóm người dùng, số liệu đã gửi / đã đọc.'],
  ['rewards', 'Phần thưởng', '🎁', 'Phần thưởng và gắn với thành tựu / game / nhiệm vụ; tặng hàng loạt.'],
  ['achievements', 'Thành tựu', '🏆', 'Thành tựu, cấp, nhóm, sự kiện kích hoạt.'],
  ['subscriptions', 'Gói trả phí', '💳', 'Gói, tính năng, quyền theo gói, giao dịch.'],
  ['games', 'Game', '🎮', 'Danh sách game, cho chơi / premium, phần thưởng game, lượt chơi.'],
  ['tasks', 'Nhiệm vụ', '✅', 'Nhiệm vụ, sự kiện, phần thưởng.'],
  ['leaderboard', 'Bảng xếp hạng', '📊', 'Bảng xếp hạng và chỉ số.'],
  ['community', 'Cộng đồng', '💬', 'Góp ý, bình chọn, bình luận.'],
  ['tinyfarm', 'TinyFarm', '🌾', 'Danh mục (giá, nhiệm vụ, công trình, mã quà) và bản lưu từng người chơi.'],
];

Admin.register({
  id: 'home', title: 'Tổng quan', icon: '◈', order: 0,
  render(main) {
    pageHead(main, 'Tổng quan', 'Quản lý dữ liệu TinyTalk trên Supabase. Mặc định <b>chỉ xem</b> — bật "Cho phép ghi" khi cần sửa.');
    const s = Admin.status || {};
    const box = el('div', 'acards');
    main.appendChild(box);

    const conn = el('div', 'acard');
    if (!s.configured) {
      conn.innerHTML = `<h3>Chưa cấu hình</h3>
        <p>Điền <code>SUPABASE_URL</code> và <code>SUPABASE_SERVICE_ROLE_KEY</code> vào:</p>
        <pre>${esc(s.env_file || 'server-panel/.env.admin')}</pre>
        <p class="muted">Lưu file xong bấm "↻ Tải lại" — không cần khởi động lại panel.</p>`;
    } else if (!s.ok) {
      conn.innerHTML = `<h3 class="err">Không kết nối được</h3><pre>${esc(s.error)}</pre>`;
    } else {
      const miss = s.rpcs_missing || [];
      conn.innerHTML = `<h3>Supabase · ${esc(s.project)}</h3>
        <p>${fmtNum(s.tables)} bảng · ${s.rpcs_total - miss.length}/${s.rpcs_total} hàm admin (tt_admin_*)</p>` +
        (miss.length ? `<details><summary class="err">Thiếu ${miss.length} hàm trên Supabase</summary><pre>${esc(miss.join('\n'))}</pre>
          <p class="muted">Áp các file trong tinytalk-admin/supabase/rpc-migrations/ để các mục dùng hàm đó chạy được.</p></details>` : '');
    }
    box.appendChild(conn);

    for (const [id, title, icon, desc] of ADMIN_SECTIONS) {
      const mod = Admin.modules.find(m => m.id === id);
      const c = el('a', 'acard link');
      c.href = `#/${id}`;
      c.innerHTML = `<h3>${icon} ${esc(title)}${mod && mod.wip ? ' <span class="anav__wip">sắp có</span>' : ''}</h3><p>${esc(desc)}</p>`;
      box.appendChild(c);
    }
    const tb = el('a', 'acard link');
    tb.href = '#/tables';
    tb.innerHTML = '<h3>▦ Bảng dữ liệu</h3><p>Xem / lọc / sửa trực tiếp mọi bảng trên Supabase (kể cả bảng không có mục riêng).</p>';
    box.appendChild(tb);
  },
});

// Các mục chưa chuyển xong: hiện trong menu để thấy toàn cảnh, mở ra là trang
// chờ. Đăng ký lúc khởi động — khi mọi file module thật đã nạp xong.
Admin.beforeStart.push(() => {
  ADMIN_SECTIONS.forEach(([id, title, icon, desc], i) => {
    if (Admin.modules.some(m => m.id === id)) return;   // module thật đã có
    Admin.register({
      id, title, icon, group: 'Quản lý', order: 10 + i, wip: true,
      render: wipPage(title, desc + ' — Mục này đang được chuyển từ tinytalk-admin sang. Trong lúc chờ, dùng "Bảng dữ liệu".'),
    });
  });
});

Admin.register({
  id: 'audit', title: 'Nhật ký thay đổi', icon: '☰', group: 'Công cụ', order: 95,
  async render(main) {
    pageHead(main, 'Nhật ký thay đổi', 'Mọi lệnh ghi từ trang admin (cả lệnh lỗi), kèm giá trị cũ / mới. Lưu trên máy này: server-panel/data/admin_audit.db.');
    const list = el('div', 'audit');
    main.appendChild(list);
    try {
      const items = await api('/api/admin/audit?limit=300');
      if (!items.length) { list.appendChild(el('div', 'aempty', 'Chưa có thay đổi nào.')); return; }
      const tbl = el('table', 'dgrid');
      tbl.innerHTML = '<thead><tr><th>Lúc</th><th>Loại</th><th>Đích</th><th>Kết quả</th><th>Chi tiết</th></tr></thead>';
      const tb = el('tbody');
      for (const it of items) {
        const tr = el('tr');
        const summary = JSON.stringify(it.detail.pk || it.detail.params || it.detail.row || it.detail);
        tr.innerHTML = `<td>${esc(fmtTime(it.ts))}</td><td>${esc(it.kind)}</td><td>${esc(it.target)}</td>
          <td class="${it.ok ? 'ok' : 'err'}">${it.ok ? 'ok' : esc(it.error || 'lỗi')}</td><td>${esc(summary.slice(0, 90))}</td>`;
        tr.onclick = () => modal({ title: `#${it.id} ${it.kind} ${it.target}`, bodyHTML: `<pre>${esc(JSON.stringify(it, null, 2))}</pre>`, wide: true });
        tb.appendChild(tr);
      }
      tbl.appendChild(tb);
      list.appendChild(tbl);
    } catch (e) { list.appendChild(el('div', 'aempty err', e.message)); }
  },
});
