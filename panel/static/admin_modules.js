/* Các mục quản lý chuyển từ tinytalk-admin: Thông báo, Phần thưởng, Thành tựu,
   Gói trả phí, Game, Nhiệm vụ, Bảng xếp hạng, Cộng đồng.

   Mỗi mục đọc một hàm tt_admin_<mục>_snapshot rồi chia tab; thêm / sửa / xoá /
   bật tắt đi qua các hàm tt_admin_* tương ứng (giữ nguyên quy tắc của bản cũ).
   Riêng nhóm game và Cộng đồng — bản cũ chỉ sửa trên giao diện, không lưu —
   ở đây ghi thẳng vào bảng (có nhật ký). */

const ENUM = {
  notifType: ['system', 'task', 'achievement', 'reward', 'event', 'promotion', 'reminder'],
  priority: ['low', 'normal', 'high', 'critical'],
  channel: ['in_app', 'push', 'email'],
  refType: ['task', 'game', 'unit', 'topic', 'learning_path', 'achievement', 'event', 'subscription', 'purchase', 'lesson', 'profile', 'admin', 'other', 'vocabulary', 'grammar', 'onboarding', 'on_the_go_free_talk'],
  rarity: ['common', 'rare', 'epic', 'legendary'],
  metricUnit: ['exp', 'score', 'count', 'accuracy', 'combo', 'streak', 'step', 'level', 'minute'],
  timeUnit: ['second', 'minute', 'hour', 'day', 'session'],
  featureType: ['grant', 'toggle', 'limit', 'consumable'],
  accessType: ['enabled', 'disabled', 'limited'],
  grantCycle: ['daily', 'weekly', 'monthly', 'yearly', 'once'],
  grantTiming: ['on_purchase', 'on_period_start', 'on_trial_start'],
  planType: ['recurring', 'one_time', 'custom', 'free'],
  currency: ['VND', 'USD'],
  billing: ['daily', 'weekly', 'monthly', 'yearly', 'custom'],
  tier: ['free', 'common', 'pro', 'ultra'],
  difficulty: ['easy', 'medium', 'hard'],
  gameCond: ['score', 'score_greater_than', 'score_less_than', 'perfect_score', 'win', 'lose', 'play_count', 'streak', 'time_spent', 'accuracy', 'combo', 'correct_answers', 'wrong_answers', 'first_time', 'daily_play'],
  gameResult: ['completed', 'quit', 'failed', 'timeout'],
  taskType: ['daily', 'weekly', 'monthly', 'special', 'event'],
  resetType: ['daily', 'weekly', 'monthly', 'special', 'event', 'none'],
  taskCond: ['count', 'sum', 'max', 'min', 'streak', 'boolean', 'threshold'],
  aggregation: ['accumulate', 'overwrite', 'max'],
  targetType: ['game', 'task', 'achievement', 'unit', 'topic', 'learning_path', 'vocabulary', 'grammar', 'lesson', 'review', 'comment', 'profile', 'event', 'any', 'subscription_plan', 'app'],
  lbType: ['daily', 'weekly', 'monthly', 'all_time', 'event', 'yearly'],
  metricKey: ['exp_total', 'exp_earned_sum', 'coin_balance', 'coin_earned_sum', 'coin_spent_sum', 'game_play_count', 'game_score_sum', 'game_best_score', 'game_avg_score', 'game_time_spent_sum', 'game_win_count', 'game_lose_count', 'task_completed_count', 'task_claimed_count', 'unit_completed_count', 'topic_completed_count', 'learning_path_completed_count', 'vocabulary_learned_count', 'vocabulary_reviewed_count', 'vocabulary_mastered_count', 'grammar_learned_count', 'grammar_reviewed_count', 'grammar_mastered_count', 'streak_days', 'community_post_count', 'community_comment_count', 'community_like_received_count'],
  fbType: ['bug', 'suggestion', 'content', 'game', 'ui', 'performance', 'any'],
  fbStatus: ['new', 'reviewed', 'in_progress', 'resolved', 'closed'],
};

const yes = v => (v ? '✓' : '—');
const active = r => !r.deletedAt && r.isActive !== false;
const byId = (rows, id) => rows.find(r => String(r.id) === String(id));
const nameOf = (rows, id, f = r => r.title || r.name || r.codename) => { const r = byId(rows, id); return r ? `${f(r)} (#${id})` : `#${id}`; };

/** Khung chung: tải snapshot → KPI + tab. build(ctx) trả {kpis, tabs}. */
function snapshotPage(main, { title, desc, fn, build }) {
  const bar = pageHead(main, title, desc);
  const reload = el('button', '', '↻  Tải lại');
  bar.appendChild(reload);
  const host = el('div');
  main.appendChild(host);
  let tabsCtl = null;
  let current = null;
  const load = async () => {
    host.innerHTML = '';
    host.appendChild(el('div', 'aempty', 'Đang tải…'));
    try {
      const snap = await rpc(fn);
      host.innerHTML = '';
      const page = build(snap || {}, load);
      if (page.kpis) Kit.kpis(host, page.kpis);
      tabsCtl = Kit.tabs(host, page.tabs.map(t => ({ ...t, render: b => { current = t.id; return t.render(b); } })), current);
    } catch (e) {
      host.innerHTML = '';
      host.appendChild(el('div', 'aempty err', e.message));
    }
  };
  reload.onclick = load;
  load();
}

// ════════ Thông báo ════════════════════════════════════════════════════
Admin.register({
  id: 'notifications', title: 'Thông báo', icon: '🔔', group: 'Quản lý', order: 12,
  render: main => snapshotPage(main, {
    title: 'Quản lý thông báo', fn: 'tt_admin_notification_snapshot',
    desc: 'Mẫu thông báo, gửi thông báo tới mọi người dùng hoặc một nhóm, tuỳ chọn nhận thông báo của từng người.',
    build: (s, reload) => {
      const T = s.templates || [], N = s.notifications || [], PN = s.profileNotifications || [], P = s.preferences || [];
      const tplFields = [
        { key: 'codename', label: 'Mã (codename, không trùng)', type: 'text', required: true },
        { key: 'notificationType', label: 'Loại', type: 'select', options: ENUM.notifType },
        { key: 'titleTemplate', label: 'Tiêu đề', type: 'text', required: true, full: true },
        { key: 'contentTemplate', label: 'Nội dung', type: 'textarea', rows: 3 },
        { key: 'priority', label: 'Ưu tiên', type: 'select', options: ENUM.priority },
        { key: 'defaultChannel', label: 'Kênh', type: 'select', options: ENUM.channel },
        { key: 'isActive', label: 'Đang dùng', type: 'bool' },
      ];
      const tplParams = v => ({
        p_codename: v.codename, p_title_template: v.titleTemplate, p_content_template: v.contentTemplate,
        p_notification_type: v.notificationType, p_priority: v.priority || 'normal', p_default_channel: v.defaultChannel || 'in_app',
        p_is_active: v.isActive !== false,
      });
      const count = k => PN.filter(x => x[k]).length;
      return {
        kpis: [
          { label: 'Mẫu', value: fmtNum(T.length), sub: `${T.filter(active).length} đang dùng` },
          { label: 'Đã gửi', value: fmtNum(N.length) },
          { label: 'Tới người dùng', value: fmtNum(PN.length) },
          { label: 'Đã đọc', value: fmtNum(count('readAt') || count('isRead')) },
          { label: 'Đã bấm', value: fmtNum(count('clickedAt')) },
        ],
        tabs: [
          { id: 'tpl', label: `Mẫu (${T.length})`, render: b => Kit.section(b, {
            title: 'Mẫu thông báo', rows: T, onChange: reload, csvName: 'notification_template',
            columns: [
              { key: 'id', label: 'ID' }, { key: 'codename', label: 'Mã' }, { key: 'titleTemplate', label: 'Tiêu đề' },
              { key: 'notificationType', label: 'Loại' }, { key: 'priority', label: 'Ưu tiên' }, { key: 'defaultChannel', label: 'Kênh' },
            ],
            create: { label: '＋  Thêm mẫu', fields: tplFields, values: () => ({ priority: 'normal', defaultChannel: 'in_app', isActive: true, notificationType: 'system' }), fn: 'tt_admin_notification_template_create', params: tplParams },
            edit: { fields: tplFields, fn: 'tt_admin_notification_template_update', params: (v, r) => ({ ...tplParams(v), p_template_id: r.id }) },
            toggles: [{ label: 'Dùng', get: r => r.isActive, fn: 'tt_admin_notification_template_set_active', params: (r, on) => ({ p_template_id: r.id, p_is_active: on }) }],
            del: { fn: 'tt_admin_notification_template_delete', params: r => ({ p_template_id: r.id }), label: r => r.codename, note: 'Xoá mềm.' },
          }) },
          { id: 'sent', label: `Đã gửi (${N.length})`, render: b => {
            const send = Admin.writeOnly(el('button', 'go', '✉  Gửi thông báo'));
            send.onclick = () => Kit.formModal({
              title: 'Gửi thông báo', okLabel: 'Gửi', wide: '48rem',
              note: 'Tạo thông báo từ một mẫu và phát tới người dùng (profile_notification). Nhóm: lọc theo vai trò / trạng thái / danh sách profile id.',
              values: { scope: 'all' },
              fields: [
                { key: 'template', label: 'Mẫu', type: 'select', required: true, options: Kit.opts(T.filter(active), 'id', r => r.codename) },
                { key: 'scope', label: 'Gửi tới', type: 'select', required: true, options: [['all', 'Mọi người dùng'], ['segment', 'Một nhóm']] },
                { key: 'role', label: 'Nhóm: vai trò', type: 'select', options: USER_ROLES },
                { key: 'status', label: 'Nhóm: trạng thái', type: 'select', options: USER_STATUS },
                { key: 'profileIds', label: 'Nhóm: profile id (cách nhau dấu phẩy)', type: 'text', full: true },
                { key: 'scheduledAt', label: 'Hẹn giờ gửi', type: 'datetime' },
                { key: 'referenceType', label: 'Liên quan tới (loại)', type: 'select', options: ENUM.refType },
                { key: 'referenceId', label: 'Liên quan tới (id)', type: 'int' },
                { key: 'payload', label: 'Payload (JSON)', type: 'json', rows: 3 },
              ],
              onSubmit: async v => {
                let seg = null;
                if (v.scope === 'segment') {
                  seg = {};
                  if (v.role) seg.role = v.role;
                  if (v.status) seg.status = v.status;
                  if (v.profileIds) seg.profileIds = v.profileIds.split(',').map(x => x.trim()).filter(Boolean);
                  if (!Object.keys(seg).length) throw new Error('Chọn ít nhất một điều kiện cho nhóm');
                }
                await Kit.mustWrite('tt_admin_notification_create', {
                  p_template_id: Number(v.template), p_reference_type: v.referenceType, p_reference_id: v.referenceId,
                  p_payload: v.payload, p_scheduled_at: v.scheduledAt, p_target_scope: v.scope, p_segment_filter: seg,
                }, { confirm: v.scope === 'all' ? 'Gửi thông báo tới <b>mọi người dùng</b>?' : 'Gửi thông báo tới nhóm đã chọn?', ok: 'Đã gửi' });
                reload();
              },
            });
            b.appendChild(send);
            const cnt = id => PN.filter(x => String(x.notificationId) === String(id)).length;
            Kit.section(b, {
              title: 'Thông báo đã tạo', rows: N, onChange: reload, csvName: 'notification',
              columns: [
                { key: 'id', label: 'ID' }, { key: 'templateId', label: 'Mẫu', render: r => nameOf(T, r.templateId, x => x.codename) },
                { key: 'referenceType', label: 'Liên quan' }, { key: 'scheduledAt', label: 'Hẹn', render: r => Kit.dateTime(r.scheduledAt) },
                { key: '_n', label: 'Người nhận', render: r => fmtNum(cnt(r.id)) },
                { key: 'createdAt', label: 'Tạo lúc', render: r => Kit.dateTime(r.createdAt) },
              ],
              del: { fn: 'tt_admin_notification_delete', params: r => ({ p_notification_id: r.id }), label: r => `thông báo #${r.id}` },
            });
          } },
          { id: 'pref', label: `Tuỳ chọn nhận (${P.length})`, render: b => Kit.section(b, {
            title: 'Tuỳ chọn nhận thông báo của người dùng', rows: P, onChange: reload,
            columns: [
              { key: 'profileId', label: 'Profile' }, { key: 'notificationType', label: 'Loại' },
              { key: 'channel', label: 'Kênh' }, { key: 'isEnabled', label: 'Bật', render: r => yes(r.isEnabled) },
            ],
            create: {
              label: '＋  Đặt tuỳ chọn',
              fields: [
                { key: 'profileId', label: 'Profile id', type: 'int', required: true },
                { key: 'type', label: 'Loại thông báo', type: 'select', required: true, options: ENUM.notifType },
                { key: 'channel', label: 'Kênh', type: 'select', required: true, options: ENUM.channel },
                { key: 'enabled', label: 'Nhận', type: 'bool' },
              ],
              values: () => ({ enabled: true }),
              fn: 'tt_admin_profile_notification_preference_upsert',
              params: v => ({ p_profile_id: v.profileId, p_notification_type: v.type, p_channel: v.channel, p_is_enabled: v.enabled !== false }),
            },
          }) },
        ],
      };
    },
  }),
});

// ════════ Phần thưởng ══════════════════════════════════════════════════
const rewardFields = items => [
  { key: 'title', label: 'Tên phần thưởng', type: 'text', required: true, full: true },
  { key: 'rewardExp', label: 'EXP', type: 'int', min: 0 },
  { key: 'rewardCoin', label: 'Xu', type: 'int', min: 0 },
  { key: 'rewardItemId', label: 'Vật phẩm', type: 'select', options: Kit.opts(items) },
  { key: 'rewardItemQuantity', label: 'Số lượng vật phẩm', type: 'int', min: 0 },
  { key: 'iconURL', label: 'Icon (URL)', type: 'text', full: true },
];
const rewardParams = v => ({
  p_title: v.title, p_reward_exp: v.rewardExp || 0, p_reward_coin: v.rewardCoin || 0,
  p_reward_item_id: v.rewardItemId ? Number(v.rewardItemId) : null, p_reward_item_quantity: v.rewardItemQuantity, p_icon_url: v.iconURL,
});

Admin.register({
  id: 'rewards', title: 'Phần thưởng', icon: '🎁', group: 'Quản lý', order: 13,
  render: main => {
    let items = [], achs = [], levels = [], games = [], tasks = [];
    snapshotPage(main, {
      title: 'Quản lý phần thưởng', fn: 'tt_admin_reward_snapshot',
      desc: 'Phần thưởng (EXP / xu / vật phẩm) và nơi trao: cấp thành tựu, kết quả game, nhiệm vụ. Tặng hàng loạt cho nhiều người dùng.',
      build: (s, reload) => {
        const R = s.rewards || [];
        // danh sách chọn (tải một lần, không chặn trang)
        if (!items.length) {
          Promise.all([allRows('item').catch(() => []), allRows('achievement').catch(() => []), allRows('achievement_level').catch(() => []),
            allRows('game').catch(() => []), allRows('task').catch(() => [])])
            .then(([i, a, l, g, t]) => { items = i; achs = a; levels = l; games = g; tasks = t; });
        }
        const levelName = id => { const l = byId(levels, id); if (!l) return `#${id}`; const a = byId(achs, l.achievementId); return `${a ? a.title : '#' + l.achievementId} · cấp ${l.level} (#${id})`; };
        return {
          kpis: [
            { label: 'Phần thưởng', value: fmtNum(R.length) },
            { label: 'Đã trao (log)', value: fmtNum((s.profileRewardLogs || []).length) },
            { label: 'Xu đã cộng', value: fmtNum((s.profileCoinLedgers || []).filter(x => x.delta > 0).reduce((a, x) => a + x.delta, 0)) },
            { label: 'Giao dịch', value: fmtNum((s.paymentTransactions || []).length) },
          ],
          tabs: [
            { id: 'rw', label: `Phần thưởng (${R.length})`, render: b => {
              const grant = Admin.writeOnly(el('button', '', '🎁  Tặng hàng loạt'));
              grant.onclick = () => Kit.formModal({
                title: 'Tặng phần thưởng hàng loạt', okLabel: 'Tặng',
                note: 'Ghi profile_reward_log và sổ xu cho từng người.',
                fields: [
                  { key: 'reward', label: 'Phần thưởng', type: 'select', required: true, options: Kit.opts(R) },
                  { key: 'ids', label: 'Profile id (cách nhau dấu phẩy / xuống dòng)', type: 'textarea', required: true, rows: 3 },
                  { key: 'source', label: 'Nguồn', type: 'text', placeholder: 'admin' },
                ],
                onSubmit: async v => {
                  const ids = v.ids.split(/[\s,]+/).filter(Boolean).map(Number);
                  if (ids.some(x => !Number.isInteger(x))) throw new Error('Profile id phải là số');
                  await Kit.mustWrite('tt_admin_reward_bulk_grant', { p_reward_id: Number(v.reward), p_profile_ids: ids, p_source_type: v.source || 'admin' },
                    { confirm: `Tặng cho <b>${ids.length}</b> người dùng?`, ok: `Đã tặng cho ${ids.length} người` });
                  reload();
                },
              });
              b.appendChild(grant);
              Kit.section(b, {
                title: 'Phần thưởng', rows: R, onChange: reload, csvName: 'reward',
                columns: [
                  { key: 'id', label: 'ID' }, { key: 'title', label: 'Tên' }, { key: 'rewardExp', label: 'EXP' }, { key: 'rewardCoin', label: 'Xu' },
                  { key: 'rewardItemId', label: 'Vật phẩm', render: r => (r.rewardItemId ? `${nameOf(items, r.rewardItemId, x => x.name || x.title || x.codename)} ×${r.rewardItemQuantity || 1}` : '—') },
                ],
                create: { label: '＋  Thêm phần thưởng', fields: rewardFields(items), fn: 'tt_admin_reward_create', params: rewardParams },
                edit: { fields: rewardFields(items), fn: 'tt_admin_reward_update', params: (v, r) => ({ ...rewardParams(v), p_reward_id: r.id }) },
                del: { fn: 'tt_admin_reward_delete', params: r => ({ p_reward_id: r.id }), note: 'Xoá hẳn, kèm các liên kết tới phần thưởng này.' },
              });
            } },
            { id: 'ach', label: 'Theo thành tựu', render: b => Kit.section(b, {
              title: 'Phần thưởng của cấp thành tựu', rows: s.achievementRewards || [], onChange: reload,
              columns: [
                { key: 'achievementLevelId', label: 'Cấp thành tựu', render: r => levelName(r.achievementLevelId) },
                { key: 'rewardId', label: 'Phần thưởng', render: r => nameOf(R, r.rewardId) },
              ],
              create: { label: '＋  Gắn', fields: [
                { key: 'level', label: 'Cấp thành tựu', type: 'select', required: true, options: levels.map(l => [l.id, levelName(l.id)]) },
                { key: 'reward', label: 'Phần thưởng', type: 'select', required: true, options: Kit.opts(R) },
              ], fn: 'tt_admin_achievement_reward_upsert', params: v => ({ p_achievement_level_id: Number(v.level), p_reward_id: Number(v.reward) }) },
              del: { fn: 'tt_admin_achievement_reward_delete', params: r => ({ p_achievement_level_id: r.achievementLevelId, p_reward_id: r.rewardId }), label: r => `liên kết cấp #${r.achievementLevelId} ↔ thưởng #${r.rewardId}` },
            }) },
            { id: 'game', label: 'Theo game', render: b => gameRewardSections(b, s, R, games, reload) },
            { id: 'task', label: 'Theo nhiệm vụ', render: b => Kit.section(b, {
              title: 'Phần thưởng của nhiệm vụ', rows: s.taskRewards || [], onChange: reload,
              columns: [
                { key: 'taskId', label: 'Nhiệm vụ', render: r => nameOf(tasks, r.taskId) },
                { key: 'rewardId', label: 'Phần thưởng', render: r => nameOf(R, r.rewardId) },
              ],
              create: { label: '＋  Gắn', fields: [
                { key: 'task', label: 'Nhiệm vụ', type: 'select', required: true, options: Kit.opts(tasks) },
                { key: 'reward', label: 'Phần thưởng', type: 'select', required: true, options: Kit.opts(R) },
              ], fn: 'tt_admin_task_reward_upsert', params: v => ({ p_task_id: Number(v.task), p_reward_id: Number(v.reward) }) },
              del: { fn: 'tt_admin_task_reward_delete', params: r => ({ p_task_id: r.taskId, p_reward_id: r.rewardId }), label: r => `nhiệm vụ #${r.taskId} ↔ thưởng #${r.rewardId}` },
            }) },
            { id: 'log', label: 'Đã trao', render: b => {
              Kit.section(b, {
                title: 'Nhật ký trao thưởng (profile_reward_log)', rows: s.profileRewardLogs || [], onChange: reload, csvName: 'profile_reward_log',
                columns: [
                  { key: 'createdAt', label: 'Lúc', render: r => Kit.dateTime(r.createdAt) }, { key: 'profileId', label: 'Profile' },
                  { key: 'rewardId', label: 'Phần thưởng', render: r => nameOf(R, r.rewardId) }, { key: 'sourceType', label: 'Nguồn' },
                ],
                del: { fn: 'tt_admin_profile_reward_log_delete', params: r => ({ p_log_id: r.id }), label: r => `dòng #${r.id}` },
              });
              Kit.section(b, {
                title: 'Sổ xu (profile_coin_ledger)', rows: s.profileCoinLedgers || [], csvName: 'profile_coin_ledger',
                columns: [
                  { key: 'createdAt', label: 'Lúc', render: r => Kit.dateTime(r.createdAt) }, { key: 'profileId', label: 'Profile' },
                  { key: 'delta', label: 'Thay đổi', render: r => (r.delta > 0 ? '+' : '') + fmtNum(r.delta) }, { key: 'reason', label: 'Lý do' },
                ],
              });
              Kit.section(b, {
                title: 'Giao dịch (payment_transaction)', rows: s.paymentTransactions || [], csvName: 'payment_transaction',
                columns: [
                  { key: 'createdAt', label: 'Lúc', render: r => Kit.dateTime(r.createdAt) }, { key: 'profileId', label: 'Profile' },
                  { key: 'subscriptionPlanId', label: 'Gói' }, { key: 'provider', label: 'Cổng' },
                  { key: 'amount', label: 'Số tiền', render: r => `${fmtNum(r.amount)} ${r.currency || ''}` }, { key: 'status', label: 'Trạng thái' },
                ],
              });
            } },
          ],
        };
      },
    });
  },
});

/** Phần thưởng theo kết quả game (game_reward) + gắn phần thưởng (game_reward_map). Dùng ở Phần thưởng và Game. */
function gameRewardSections(b, s, R, games, reload) {
  const GR = s.gameRewards || [];
  Kit.section(b, {
    title: 'Điều kiện thưởng của game (game_reward)', rows: GR, onChange: reload,
    columns: [
      { key: 'id', label: 'ID' }, { key: 'gameId', label: 'Game', render: r => nameOf(games, r.gameId) },
      { key: 'conditionType', label: 'Điều kiện' }, { key: 'conditionValue', label: 'Giá trị' },
      { key: 'resultStatus', label: 'Kết quả' }, { key: 'chance', label: 'Tỉ lệ %' },
    ],
    create: { label: '＋  Thêm điều kiện', fields: [
      { key: 'game', label: 'Game', type: 'select', required: true, options: Kit.opts(games) },
      { key: 'conditionType', label: 'Điều kiện', type: 'select', options: ENUM.gameCond },
      { key: 'conditionValue', label: 'Giá trị', type: 'int' },
      { key: 'resultStatus', label: 'Kết quả ván', type: 'select', options: ENUM.gameResult },
      { key: 'chance', label: 'Tỉ lệ (%)', type: 'int', min: 0, max: 100 },
    ], values: () => ({ chance: 100 }), fn: 'tt_admin_game_reward_create',
    params: v => ({ p_game_id: Number(v.game), p_condition_type: v.conditionType, p_condition_value: v.conditionValue, p_result_status: v.resultStatus, p_chance: v.chance ?? 100 }) },
    del: { fn: 'tt_admin_game_reward_delete', params: r => ({ p_game_reward_id: r.id }), label: r => `điều kiện #${r.id}`, note: 'Xoá hẳn, kèm các liên kết phần thưởng.' },
  });
  Kit.section(b, {
    title: 'Phần thưởng gắn với điều kiện (game_reward_map)', rows: s.gameRewardMaps || [], onChange: reload,
    columns: [
      { key: 'gameRewardId', label: 'Điều kiện', render: r => { const g = byId(GR, r.gameRewardId); return g ? `#${g.id} ${nameOf(games, g.gameId)} · ${g.conditionType || ''} ${g.conditionValue ?? ''}` : `#${r.gameRewardId}`; } },
      { key: 'rewardId', label: 'Phần thưởng', render: r => nameOf(R, r.rewardId) },
    ],
    create: { label: '＋  Gắn', fields: [
      { key: 'gr', label: 'Điều kiện', type: 'select', required: true, options: GR.map(g => [g.id, `#${g.id} ${nameOf(games, g.gameId)} · ${g.conditionType || ''}`]) },
      { key: 'reward', label: 'Phần thưởng', type: 'select', required: true, options: Kit.opts(R) },
    ], fn: 'tt_admin_game_reward_map_upsert', params: v => ({ p_game_reward_id: Number(v.gr), p_reward_id: Number(v.reward) }) },
    del: { fn: 'tt_admin_game_reward_map_delete', params: r => ({ p_game_reward_id: r.gameRewardId, p_reward_id: r.rewardId }), label: r => `điều kiện #${r.gameRewardId} ↔ thưởng #${r.rewardId}` },
  });
}

// ════════ Thành tựu ════════════════════════════════════════════════════
Admin.register({
  id: 'achievements', title: 'Thành tựu', icon: '🏆', group: 'Quản lý', order: 14,
  render: main => snapshotPage(main, {
    title: 'Quản lý thành tựu', fn: 'tt_admin_achievement_snapshot',
    desc: 'Thành tựu → các cấp (điều kiện đạt) → sự kiện kích hoạt và phần thưởng; nhóm thành tựu.',
    build: (s, reload) => {
      const A = s.achievements || [], L = s.achievementLevels || [], C = s.achievementCategories || [], E = s.eventTypes || [], R = s.rewards || [];
      const levelName = id => { const l = byId(L, id); return l ? `${nameOf(A, l.achievementId)} · cấp ${l.level}` : `#${id}`; };
      const achFields = [
        { key: 'title', label: 'Tên', type: 'text', required: true },
        { key: 'rarity', label: 'Độ hiếm', type: 'select', required: true, options: ENUM.rarity },
        { key: 'description', label: 'Mô tả', type: 'textarea', required: true, rows: 2 },
        { key: 'template', label: 'Template', type: 'text' },
        { key: 'actionKey', label: 'Hành động khi bấm (actionKey)', type: 'text', placeholder: 'open_home' },
        { key: 'iconURL', label: 'Icon (URL)', type: 'text', full: true },
      ];
      const achParams = v => ({ p_title: v.title, p_description: v.description, p_rarity: v.rarity, p_template: v.template, p_action_key: v.actionKey || 'open_home', p_icon_url: v.iconURL });
      const lvlFields = [
        { key: 'achievementId', label: 'Thành tựu', type: 'select', required: true, options: Kit.opts(A) },
        { key: 'level', label: 'Cấp', type: 'int', required: true, min: 1 },
        { key: 'conditionValue', label: 'Giá trị cần đạt', type: 'int', required: true, min: 0 },
        { key: 'metricType', label: 'Chỉ số (metricType)', type: 'text', required: true },
        { key: 'metricUnit', label: 'Đơn vị', type: 'select', options: ENUM.metricUnit },
        { key: 'timeUnit', label: 'Khung thời gian', type: 'select', options: ENUM.timeUnit },
      ];
      const lvlParams = v => ({ p_condition_value: v.conditionValue, p_level: v.level, p_metric_type: v.metricType, p_metric_unit: v.metricUnit, p_time_unit: v.timeUnit });
      const catFields = [
        { key: 'name', label: 'Tên', type: 'text', required: true }, { key: 'codename', label: 'Mã', type: 'text', required: true },
        { key: 'description', label: 'Mô tả', type: 'textarea', rows: 2 }, { key: 'iconURL', label: 'Icon (URL)', type: 'text' },
        { key: 'displayOrder', label: 'Thứ tự', type: 'int' },
      ];
      const catParams = v => ({ p_name: v.name, p_codename: v.codename, p_description: v.description, p_icon_url: v.iconURL, p_display_order: v.displayOrder || 0 });
      return {
        kpis: [
          { label: 'Thành tựu', value: fmtNum(A.length), sub: `${A.filter(active).length} đang bật` },
          { label: 'Cấp', value: fmtNum(L.length) }, { label: 'Nhóm', value: fmtNum(C.length) },
          { label: 'Người đã đạt', value: fmtNum((s.profileAchievements || []).length) },
        ],
        tabs: [
          { id: 'a', label: `Thành tựu (${A.length})`, render: b => Kit.section(b, {
            title: 'Thành tựu', rows: A, onChange: reload, csvName: 'achievement',
            columns: [{ key: 'id', label: 'ID' }, { key: 'title', label: 'Tên' }, { key: 'rarity', label: 'Độ hiếm' }, { key: 'actionKey', label: 'Hành động' },
              { key: '_l', label: 'Số cấp', render: r => fmtNum(L.filter(l => l.achievementId === r.id).length) }],
            create: { label: '＋  Thêm thành tựu', fields: achFields, values: () => ({ rarity: 'common', actionKey: 'open_home' }), fn: 'tt_admin_achievement_create', params: achParams },
            edit: { fields: achFields, fn: 'tt_admin_achievement_update', params: (v, r) => ({ ...achParams(v), p_achievement_id: r.id }) },
            toggles: [{ label: 'Bật', get: r => !r.deletedAt, fn: 'tt_admin_achievement_set_active', params: (r, on) => ({ p_achievement_id: r.id, p_is_active: on }) }],
            del: { fn: 'tt_admin_achievement_delete', params: r => ({ p_achievement_id: r.id }), note: 'Xoá hẳn, kèm cấp, nhóm, phần thưởng và tiến độ người dùng.' },
          }) },
          { id: 'l', label: `Cấp (${L.length})`, render: b => Kit.section(b, {
            title: 'Cấp thành tựu', rows: L, onChange: reload,
            columns: [{ key: 'id', label: 'ID' }, { key: 'achievementId', label: 'Thành tựu', render: r => nameOf(A, r.achievementId) }, { key: 'level', label: 'Cấp' },
              { key: 'conditionValue', label: 'Cần đạt' }, { key: 'metricType', label: 'Chỉ số' }, { key: 'metricUnit', label: 'Đơn vị' }, { key: 'timeUnit', label: 'Khung' }],
            create: { label: '＋  Thêm cấp', fields: lvlFields, values: () => ({ level: 1 }), fn: 'tt_admin_achievement_level_create', params: v => ({ ...lvlParams(v), p_achievement_id: Number(v.achievementId) }) },
            edit: { fields: lvlFields.filter(f => f.key !== 'achievementId'), fn: 'tt_admin_achievement_level_update', params: (v, r) => ({ ...lvlParams(v), p_achievement_level_id: r.id }) },
            del: { fn: 'tt_admin_achievement_level_delete', params: r => ({ p_achievement_level_id: r.id }), label: r => levelName(r.id) },
          }) },
          { id: 'ev', label: 'Sự kiện kích hoạt', render: b => Kit.section(b, {
            title: 'Cấp thành tựu ↔ loại sự kiện', rows: s.achievementEventMaps || [], onChange: reload,
            columns: [{ key: 'achievementLevelId', label: 'Cấp thành tựu', render: r => levelName(r.achievementLevelId) },
              { key: 'eventTypeId', label: 'Sự kiện', render: r => nameOf(E, r.eventTypeId, x => x.codename) }],
            create: { label: '＋  Gắn', fields: [
              { key: 'lvl', label: 'Cấp thành tựu', type: 'select', required: true, options: L.map(l => [l.id, levelName(l.id)]) },
              { key: 'ev', label: 'Sự kiện', type: 'select', required: true, options: Kit.opts(E, 'id', x => x.codename) },
            ], fn: 'tt_admin_achievement_event_map_upsert', params: v => ({ p_achievement_level_id: Number(v.lvl), p_event_type_id: Number(v.ev) }) },
            del: { fn: 'tt_admin_achievement_event_map_delete', params: r => ({ p_achievement_level_id: r.achievementLevelId, p_event_type_id: r.eventTypeId }), label: r => `cấp #${r.achievementLevelId} ↔ sự kiện #${r.eventTypeId}` },
          }) },
          { id: 'rw', label: 'Phần thưởng', render: b => Kit.section(b, {
            title: 'Cấp thành tựu ↔ phần thưởng', rows: s.achievementRewards || [], onChange: reload,
            columns: [{ key: 'achievementLevelId', label: 'Cấp thành tựu', render: r => levelName(r.achievementLevelId) }, { key: 'rewardId', label: 'Phần thưởng', render: r => nameOf(R, r.rewardId) }],
            create: { label: '＋  Gắn', fields: [
              { key: 'lvl', label: 'Cấp thành tựu', type: 'select', required: true, options: L.map(l => [l.id, levelName(l.id)]) },
              { key: 'reward', label: 'Phần thưởng', type: 'select', required: true, options: Kit.opts(R) },
            ], fn: 'tt_admin_achievement_reward_upsert', params: v => ({ p_achievement_level_id: Number(v.lvl), p_reward_id: Number(v.reward) }) },
            del: { fn: 'tt_admin_achievement_reward_delete', params: r => ({ p_achievement_level_id: r.achievementLevelId, p_reward_id: r.rewardId }), label: r => `cấp #${r.achievementLevelId} ↔ thưởng #${r.rewardId}` },
          }) },
          { id: 'cat', label: `Nhóm (${C.length})`, render: b => {
            Kit.section(b, {
              title: 'Nhóm thành tựu', rows: C, onChange: reload,
              columns: [{ key: 'id', label: 'ID' }, { key: 'name', label: 'Tên' }, { key: 'codename', label: 'Mã' }, { key: 'displayOrder', label: 'Thứ tự' }],
              create: { label: '＋  Thêm nhóm', fields: catFields, fn: 'tt_admin_achievement_category_create', params: catParams },
              edit: { fields: catFields, fn: 'tt_admin_achievement_category_update', params: (v, r) => ({ ...catParams(v), p_category_id: r.id }) },
              toggles: [{ label: 'Bật', get: r => r.isActive !== false && !r.deletedAt, fn: 'tt_admin_achievement_category_set_active', params: (r, on) => ({ p_category_id: r.id, p_is_active: on }) }],
              del: { fn: 'tt_admin_achievement_category_delete', params: r => ({ p_category_id: r.id }) },
            });
            Kit.section(b, {
              title: 'Thành tựu trong nhóm', rows: s.achievementCategoryMaps || [], onChange: reload,
              columns: [{ key: 'categoryId', label: 'Nhóm', render: r => nameOf(C, r.categoryId) }, { key: 'achievementId', label: 'Thành tựu', render: r => nameOf(A, r.achievementId) }],
              create: { label: '＋  Gắn', fields: [
                { key: 'cat', label: 'Nhóm', type: 'select', required: true, options: Kit.opts(C) },
                { key: 'ach', label: 'Thành tựu', type: 'select', required: true, options: Kit.opts(A) },
              ], fn: 'tt_admin_achievement_category_map_upsert', params: v => ({ p_achievement_id: Number(v.ach), p_category_id: Number(v.cat) }) },
              del: { fn: 'tt_admin_achievement_category_map_delete', params: r => ({ p_achievement_id: r.achievementId, p_category_id: r.categoryId }), label: r => `nhóm #${r.categoryId} ↔ thành tựu #${r.achievementId}` },
            });
          } },
          { id: 'prof', label: 'Người dùng', render: b => {
            Kit.section(b, { title: 'Thành tựu người dùng đã đạt', rows: s.profileAchievements || [], csvName: 'profile_achievement',
              columns: [{ key: 'profileId', label: 'Profile' }, { key: 'achievementId', label: 'Thành tựu', render: r => nameOf(A, r.achievementId) }, { key: 'level', label: 'Cấp' }, { key: 'equippedSlot', label: 'Ô đeo' }, { key: 'createdAt', label: 'Lúc', render: r => Kit.dateTime(r.createdAt) }] });
            Kit.section(b, { title: 'Tiến độ', rows: s.profileAchievementProgress || [], csvName: 'profile_achievement_progress',
              columns: [{ key: 'profileId', label: 'Profile' }, { key: 'achievementId', label: 'Thành tựu', render: r => nameOf(A, r.achievementId) }, { key: 'progressValue', label: 'Tiến độ' }, { key: 'updatedAt', label: 'Cập nhật', render: r => Kit.dateTime(r.updatedAt) }] });
          } },
        ],
      };
    },
  }),
});

// ════════ Gói trả phí ══════════════════════════════════════════════════
Admin.register({
  id: 'subscriptions', title: 'Gói trả phí', icon: '💳', group: 'Quản lý', order: 15,
  render: main => snapshotPage(main, {
    title: 'Quản lý gói trả phí', fn: 'tt_admin_subscription_snapshot',
    desc: 'Gói (giá, chu kỳ, dùng thử), tính năng của app, quyền theo gói; giao dịch và gói người dùng đang có.',
    build: (s, reload) => {
      const P = s.subscriptionPlans || [], F = s.appFeatures || [], T = s.paymentTransactions || [];
      const planFields = [
        { key: 'codename', label: 'Mã (không trùng)', type: 'text', required: true }, { key: 'title', label: 'Tên gói', type: 'text', required: true },
        { key: 'tier', label: 'Hạng', type: 'select', required: true, options: ENUM.tier }, { key: 'planType', label: 'Kiểu', type: 'select', options: ENUM.planType },
        { key: 'price', label: 'Giá', type: 'int', min: 0 }, { key: 'originalPrice', label: 'Giá gốc', type: 'int', min: 0 },
        { key: 'currency', label: 'Tiền tệ', type: 'select', options: ENUM.currency }, { key: 'billingCycle', label: 'Chu kỳ', type: 'select', options: ENUM.billing },
        { key: 'durationDays', label: 'Số ngày', type: 'int', min: 0 }, { key: 'trialDays', label: 'Ngày dùng thử', type: 'int', min: 0 },
        { key: 'promotionEndAt', label: 'Hết khuyến mãi', type: 'datetime' }, { key: 'displayOrder', label: 'Thứ tự', type: 'int' },
        { key: 'isHighlight', label: 'Nổi bật', type: 'bool' }, { key: 'isActive', label: 'Đang bán', type: 'bool' },
        { key: 'description', label: 'Mô tả', type: 'textarea', rows: 2 },
      ];
      const planParams = v => ({
        p_codename: v.codename, p_title: v.title, p_tier: v.tier, p_description: v.description, p_plan_type: v.planType || 'recurring',
        p_price: v.price || 0, p_original_price: v.originalPrice, p_currency: v.currency || 'VND', p_billing_cycle: v.billingCycle || 'monthly',
        p_duration_days: v.durationDays, p_trial_days: v.trialDays || 0, p_promotion_end_at: v.promotionEndAt, p_display_order: v.displayOrder || 0,
        p_is_highlight: !!v.isHighlight, p_is_active: v.isActive !== false,
      });
      const featFields = [
        { key: 'codename', label: 'Mã', type: 'text', required: true }, { key: 'featureType', label: 'Kiểu', type: 'select', required: true, options: ENUM.featureType },
        { key: 'consumable', label: 'Dùng hết được', type: 'bool' }, { key: 'description', label: 'Mô tả', type: 'textarea', rows: 2 },
      ];
      const featParams = v => ({ p_codename: v.codename, p_feature_type: v.featureType, p_consumable: !!v.consumable, p_description: v.description });
      const paid = T.filter(x => x.status === 'paid' || x.status === 'success' || x.paidAt);
      return {
        kpis: [
          { label: 'Gói', value: fmtNum(P.length), sub: `${P.filter(active).length} đang bán` },
          { label: 'Tính năng', value: fmtNum(F.length) },
          { label: 'Giao dịch', value: fmtNum(T.length), sub: `${paid.length} đã trả` },
          { label: 'Doanh thu (đã trả)', value: fmtNum(paid.reduce((a, x) => a + (Number(x.amount) || 0), 0)) },
          { label: 'Gói người dùng', value: fmtNum((s.profileSubscriptions || []).length) },
        ],
        tabs: [
          { id: 'p', label: `Gói (${P.length})`, render: b => Kit.section(b, {
            title: 'Gói trả phí', rows: P, onChange: reload, csvName: 'subscription_plan',
            columns: [{ key: 'id', label: 'ID' }, { key: 'codename', label: 'Mã' }, { key: 'title', label: 'Tên' }, { key: 'tier', label: 'Hạng' },
              { key: 'price', label: 'Giá', render: r => `${fmtNum(r.price)} ${r.currency || ''}` }, { key: 'billingCycle', label: 'Chu kỳ' },
              { key: 'trialDays', label: 'Dùng thử' }, { key: 'isHighlight', label: 'Nổi bật', render: r => yes(r.isHighlight) }],
            create: { label: '＋  Thêm gói', fields: planFields, values: () => ({ tier: 'pro', planType: 'recurring', currency: 'VND', billingCycle: 'monthly', isActive: true }), fn: 'tt_admin_subscription_plan_create', params: planParams },
            edit: { fields: planFields, fn: 'tt_admin_subscription_plan_update', params: (v, r) => ({ ...planParams(v), p_plan_id: r.id }) },
            toggles: [{ label: 'Bán', get: r => r.isActive !== false && !r.deletedAt, fn: 'tt_admin_subscription_plan_set_active', params: (r, on) => ({ p_plan_id: r.id, p_is_active: on }) }],
            del: { fn: 'tt_admin_subscription_plan_delete', params: r => ({ p_plan_id: r.id }), label: r => r.codename },
          }) },
          { id: 'f', label: `Tính năng (${F.length})`, render: b => Kit.section(b, {
            title: 'Tính năng của app', rows: F, onChange: reload,
            columns: [{ key: 'id', label: 'ID' }, { key: 'codename', label: 'Mã' }, { key: 'featureType', label: 'Kiểu' }, { key: 'consumable', label: 'Dùng hết', render: r => yes(r.consumable) }, { key: 'description', label: 'Mô tả' }],
            create: { label: '＋  Thêm tính năng', fields: featFields, values: () => ({ featureType: 'toggle' }), fn: 'tt_admin_app_feature_create', params: featParams },
            edit: { fields: featFields, fn: 'tt_admin_app_feature_update', params: (v, r) => ({ ...featParams(v), p_feature_id: r.id }) },
            del: { fn: 'tt_admin_app_feature_delete', params: r => ({ p_feature_id: r.id }), label: r => r.codename },
          }) },
          { id: 'a', label: 'Quyền theo gói', render: b => {
            const accFields = [
              { key: 'plan', label: 'Gói', type: 'select', required: true, options: Kit.opts(P, 'id', x => x.codename) },
              { key: 'feature', label: 'Tính năng', type: 'select', required: true, options: Kit.opts(F, 'id', x => x.codename) },
              { key: 'accessType', label: 'Quyền', type: 'select', required: true, options: ENUM.accessType },
              { key: 'grantAmount', label: 'Số lượng cấp', type: 'int', min: 0 },
              { key: 'grantCycle', label: 'Chu kỳ cấp', type: 'select', options: ENUM.grantCycle },
              { key: 'grantTiming', label: 'Thời điểm cấp', type: 'select', options: ENUM.grantTiming },
              { key: 'isStackable', label: 'Cộng dồn', type: 'bool' },
            ];
            const accParams = v => ({ p_subscription_plan_id: Number(v.plan), p_app_feature_id: Number(v.feature), p_access_type: v.accessType, p_grant_amount: v.grantAmount, p_grant_cycle: v.grantCycle, p_grant_timing: v.grantTiming, p_is_stackable: !!v.isStackable });
            Kit.section(b, {
              title: 'Gói ↔ tính năng', rows: s.planFeatureAccesses || [], onChange: reload,
              columns: [{ key: 'subscriptionPlanId', label: 'Gói', render: r => nameOf(P, r.subscriptionPlanId, x => x.codename) },
                { key: 'appFeatureId', label: 'Tính năng', render: r => nameOf(F, r.appFeatureId, x => x.codename) },
                { key: 'accessType', label: 'Quyền' }, { key: 'grantAmount', label: 'Cấp' }, { key: 'grantCycle', label: 'Chu kỳ' }, { key: 'grantTiming', label: 'Lúc cấp' },
                { key: 'isStackable', label: 'Cộng dồn', render: r => yes(r.isStackable) }],
              create: { label: '＋  Đặt quyền', fields: accFields, values: () => ({ accessType: 'enabled' }), fn: 'tt_admin_plan_feature_access_upsert', params: accParams },
              edit: { fields: accFields, values: r => ({ ...r, plan: r.subscriptionPlanId, feature: r.appFeatureId }), fn: 'tt_admin_plan_feature_access_upsert', params: accParams },
              del: { fn: 'tt_admin_plan_feature_access_delete', params: r => ({ p_subscription_plan_id: r.subscriptionPlanId, p_app_feature_id: r.appFeatureId }), label: r => `gói #${r.subscriptionPlanId} ↔ tính năng #${r.appFeatureId}` },
            });
          } },
          { id: 't', label: `Giao dịch (${T.length})`, render: b => {
            Kit.section(b, { title: 'Giao dịch', rows: T, csvName: 'payment_transaction',
              columns: [{ key: 'createdAt', label: 'Lúc', render: r => Kit.dateTime(r.createdAt) }, { key: 'profileId', label: 'Profile' },
                { key: 'subscriptionPlanId', label: 'Gói', render: r => nameOf(P, r.subscriptionPlanId, x => x.codename) }, { key: 'provider', label: 'Cổng' },
                { key: 'providerTransactionId', label: 'Mã giao dịch' }, { key: 'amount', label: 'Số tiền', render: r => `${fmtNum(r.amount)} ${r.currency || ''}` },
                { key: 'status', label: 'Trạng thái' }, { key: 'paidAt', label: 'Trả lúc', render: r => Kit.dateTime(r.paidAt) }] });
            Kit.section(b, { title: 'Gói của người dùng', rows: s.profileSubscriptions || [], csvName: 'profile_subscription',
              columns: [{ key: 'profileId', label: 'Profile' }, { key: 'subscriptionPlanId', label: 'Gói', render: r => nameOf(P, r.subscriptionPlanId, x => x.codename) },
                { key: 'status', label: 'Trạng thái' }, { key: 'currentPeriodStart', label: 'Kỳ từ', render: r => Kit.date(r.currentPeriodStart) },
                { key: 'currentPeriodEnd', label: 'Kỳ đến', render: r => Kit.date(r.currentPeriodEnd) }, { key: 'canceledAt', label: 'Huỷ', render: r => Kit.date(r.canceledAt) }] });
            Kit.section(b, { title: 'Nhật ký dùng tính năng', rows: s.profileFeatureLogs || [], csvName: 'profile_feature_log',
              columns: [{ key: 'createdAt', label: 'Lúc', render: r => Kit.dateTime(r.createdAt) }, { key: 'profileId', label: 'Profile' },
                { key: 'appFeatureId', label: 'Tính năng', render: r => nameOf(F, r.appFeatureId, x => x.codename) }, { key: 'actionType', label: 'Hành động' },
                { key: 'amount', label: 'Số lượng' }, { key: 'source', label: 'Nguồn' }] });
          } },
        ],
      };
    },
  }),
});

// ════════ Game ═════════════════════════════════════════════════════════
Admin.register({
  id: 'games', title: 'Game', icon: '🎮', group: 'Quản lý', order: 16,
  render: main => {
    let R = [];
    snapshotPage(main, {
      title: 'Quản lý game', fn: 'tt_admin_game_snapshot',
      desc: 'Danh sách game (cho chơi / premium), nhóm game, điều kiện thưởng, lượt chơi và đánh giá.',
      build: (s, reload) => {
        const G = s.games || [], C = s.categories || [], S = s.sessions || [];
        if (!R.length) rpc('tt_admin_reward_snapshot').then(x => { R = (x && x.rewards) || []; }).catch(() => {});
        const gameFields = [
          { key: 'title', label: 'Tên game', type: 'text', required: true }, { key: 'gameDifficulty', label: 'Độ khó', type: 'select', options: ENUM.difficulty },
          { key: 'description', label: 'Mô tả', type: 'textarea', rows: 2 },
          { key: 'gameURL', label: 'Đường dẫn game', type: 'text', full: true }, { key: 'thumbnailURL', label: 'Ảnh bìa (URL)', type: 'text', full: true },
          { key: 'logoURL', label: 'Logo (URL)', type: 'text', full: true }, { key: 'videoDemoURL', label: 'Video demo (URL)', type: 'text', full: true },
          { key: 'screenshotURL', label: 'Ảnh chụp (JSON)', type: 'json', rows: 2 },
          { key: 'isPlayable', label: 'Cho chơi', type: 'bool' }, { key: 'isPremium', label: 'Premium', type: 'bool' },
          { key: 'playCount', label: 'Lượt chơi', type: 'int', min: 0 }, { key: 'ratingAverage', label: 'Điểm đánh giá', type: 'number', min: 0, max: 5 },
          { key: 'ratingCount', label: 'Số đánh giá', type: 'int', min: 0 },
        ];
        const gameParams = v => ({
          p_title: v.title, p_description: v.description, p_thumbnail_url: v.thumbnailURL, p_game_url: v.gameURL, p_game_difficulty: v.gameDifficulty,
          p_play_count: v.playCount || 0, p_rating_average: v.ratingAverage || 0, p_rating_count: v.ratingCount || 0, p_is_playable: v.isPlayable !== false,
          p_logo_url: v.logoURL, p_video_demo_url: v.videoDemoURL, p_screenshot_url: v.screenshotURL, p_is_premium: !!v.isPremium,
        });
        const plays = id => S.filter(x => x.gameId === id).length;
        return {
          kpis: [
            { label: 'Game', value: fmtNum(G.length), sub: `${G.filter(x => x.isPlayable).length} cho chơi` },
            { label: 'Premium', value: fmtNum(G.filter(x => x.isPremium).length) },
            { label: 'Lượt chơi (gần đây)', value: fmtNum(S.length) },
            { label: 'Nhóm', value: fmtNum(C.length) },
          ],
          tabs: [
            { id: 'g', label: `Game (${G.length})`, render: b => Kit.section(b, {
              title: 'Game', rows: G, onChange: reload, csvName: 'game',
              columns: [{ key: 'id', label: 'ID' }, { key: 'title', label: 'Tên' }, { key: 'gameDifficulty', label: 'Độ khó' },
                { key: 'playCount', label: 'Lượt chơi' }, { key: 'ratingAverage', label: 'Đánh giá', render: r => `${Number(r.ratingAverage || 0).toFixed(1)} (${r.ratingCount || 0})` },
                { key: '_s', label: 'Phiên gần đây', render: r => fmtNum(plays(r.id)) }],
              create: { label: '＋  Thêm game', fields: gameFields, values: () => ({ isPlayable: true, isPremium: false, gameDifficulty: 'easy' }), fn: 'tt_admin_game_create', params: gameParams },
              edit: { fields: gameFields, fn: 'tt_admin_game_update', params: (v, r) => ({ ...gameParams(v), p_game_id: r.id }) },
              toggles: [
                { label: 'Cho chơi', get: r => r.isPlayable, fn: 'tt_admin_game_set_playable', params: (r, on) => ({ p_game_id: r.id, p_is_playable: on }) },
                { label: 'Premium', get: r => r.isPremium, fn: 'tt_admin_game_set_premium', params: (r, on) => ({ p_game_id: r.id, p_is_premium: on }) },
              ],
              del: { fn: 'tt_admin_game_delete', params: r => ({ p_game_id: r.id }), note: 'Xoá hẳn, kèm lượt chơi, đánh giá, phần thưởng và nhóm của game.' },
            }) },
            { id: 'c', label: `Nhóm (${C.length})`, render: b => gameCategories(b, s, G, reload) },
            { id: 'r', label: 'Thưởng theo game', render: b => gameRewardSections(b, s, R, G, reload) },
            { id: 's', label: `Lượt chơi (${S.length})`, render: b => Kit.section(b, {
              title: 'Phiên chơi gần đây', rows: S, csvName: 'game_session', pageSize: 50,
              columns: [{ key: 'startedAt', label: 'Bắt đầu', render: r => Kit.dateTime(r.startedAt || r.createdAt) }, { key: 'profileId', label: 'Profile' },
                { key: 'gameId', label: 'Game', render: r => nameOf(G, r.gameId) }, { key: 'score', label: 'Điểm' }, { key: 'resultStatus', label: 'Kết quả' },
                { key: 'endedAt', label: 'Kết thúc', render: r => Kit.dateTime(r.endedAt) }],
            }) },
            { id: 'rt', label: `Đánh giá (${(s.ratings || []).length})`, render: b => Kit.section(b, {
              title: 'Đánh giá game', rows: s.ratings || [], csvName: 'game_rating',
              columns: Object.keys((s.ratings || [])[0] || { profileId: 0, gameId: 0, rating: 0 }).map(k => ({ key: k, label: k, render: r => Kit.json(r[k]) })),
            }) },
          ],
        };
      },
    });
  },
});

/** Nhóm game: bản cũ chỉ sửa trên giao diện (không lưu) — ở đây ghi thẳng vào bảng game_category / game_category_map. */
function gameCategories(b, s, G, reload) {
  const C = s.categories || [];
  const catFields = [
    { key: 'title', label: 'Tên nhóm', type: 'text', required: true }, { key: 'signatureColor', label: 'Màu (vd #22d3ee)', type: 'text' },
    { key: 'description', label: 'Mô tả', type: 'textarea', rows: 2 }, { key: 'logoURL', label: 'Logo (URL)', type: 'text', full: true },
  ];
  const tableWrite = async (method, table, body, ok) => {
    if (!(await Kit.ensureWrite())) throw new Error('Cần bật "Cho phép ghi"');
    await api(`/api/admin/tables/${table}/rows`, { method, body: JSON.stringify(body) });
    toast(ok);
    reload();
  };
  const box = el('div');
  b.appendChild(box);
  const add = Admin.writeOnly(el('button', 'go', '＋  Thêm nhóm'));
  add.onclick = () => Kit.formModal({ title: 'Thêm nhóm game', fields: catFields, okLabel: 'Thêm',
    onSubmit: v => tableWrite('POST', 'game_category', { row: v, autoId: true }, 'Đã thêm nhóm') });
  box.appendChild(add);
  Kit.table(box, {
    rows: C, csvName: 'game_category',
    columns: [{ key: 'id', label: 'ID' }, { key: 'title', label: 'Tên' }, { key: 'signatureColor', label: 'Màu' },
      { key: '_g', label: 'Game', render: r => (s.categoryMaps || []).filter(m => m.gameCategoryId === r.id).map(m => nameOf(G, m.gameId, x => x.title)).join(', ') || '—' },
      { key: '_a', label: 'Thao tác', sort: false, render: r => {
        const d = el('div', 'btns');
        const e = Admin.writeOnly(el('button', '', '✎'));
        e.onclick = () => Kit.formModal({ title: `Sửa nhóm #${r.id}`, fields: catFields, values: r, okLabel: 'Lưu',
          onSubmit: v => tableWrite('PATCH', 'game_category', { pk: { id: r.id }, changes: v }, 'Đã lưu nhóm') });
        const x = Admin.writeOnly(el('button', 'stop', '🗑'));
        x.onclick = async () => {
          if (!(await confirmModal(`Xoá nhóm <b>${esc(r.title)}</b>?`, 'Xoá', true))) return;
          try { await tableWrite('DELETE', 'game_category', { pk: { id: r.id } }, 'Đã xoá nhóm'); } catch (e2) { toast(e2.message, 'err'); }
        };
        d.append(e, x);
        return d;
      } }],
  });
  const mapBox = el('div');
  b.appendChild(mapBox);
  const addMap = Admin.writeOnly(el('button', '', '＋  Gắn game vào nhóm'));
  addMap.onclick = () => Kit.formModal({
    title: 'Gắn game vào nhóm', okLabel: 'Gắn',
    fields: [{ key: 'cat', label: 'Nhóm', type: 'select', required: true, options: Kit.opts(C) }, { key: 'game', label: 'Game', type: 'select', required: true, options: Kit.opts(G) }],
    onSubmit: v => tableWrite('POST', 'game_category_map', { row: { gameCategoryId: Number(v.cat), gameId: Number(v.game) } }, 'Đã gắn'),
  });
  mapBox.appendChild(el('h4', 'ksub', 'Game trong nhóm (game_category_map)'));
  mapBox.appendChild(addMap);
  Kit.table(mapBox, {
    rows: s.categoryMaps || [],
    columns: [{ key: 'gameCategoryId', label: 'Nhóm', render: r => nameOf(C, r.gameCategoryId) }, { key: 'gameId', label: 'Game', render: r => nameOf(G, r.gameId) },
      { key: '_x', label: '', sort: false, render: r => {
        const x = Admin.writeOnly(el('button', 'stop', '🗑'));
        x.onclick = async () => {
          if (!(await confirmModal('Gỡ game khỏi nhóm?', 'Gỡ', true))) return;
          try { await tableWrite('DELETE', 'game_category_map', { pk: { gameCategoryId: r.gameCategoryId, gameId: r.gameId } }, 'Đã gỡ'); } catch (e2) { toast(e2.message, 'err'); }
        };
        return x;
      } }],
  });
}

// ════════ Nhiệm vụ ═════════════════════════════════════════════════════
Admin.register({
  id: 'tasks', title: 'Nhiệm vụ', icon: '✅', group: 'Quản lý', order: 17,
  render: main => snapshotPage(main, {
    title: 'Quản lý nhiệm vụ', fn: 'tt_admin_task_snapshot',
    desc: 'Nhiệm vụ (ngày / tuần / tháng / sự kiện), sự kiện làm tăng tiến độ, phần thưởng; tiến độ của người dùng.',
    build: (s, reload) => {
      const T = s.tasks || [], E = s.eventTypes || [], R = s.rewards || [], PT = s.profileTaskProgress || [];
      const fields = [
        { key: 'title', label: 'Tên', type: 'text', required: true }, { key: 'taskType', label: 'Loại', type: 'select', required: true, options: ENUM.taskType },
        { key: 'description', label: 'Mô tả', type: 'textarea', rows: 2 },
        { key: 'conditionType', label: 'Điều kiện', type: 'select', options: ENUM.taskCond }, { key: 'conditionValue', label: 'Giá trị cần đạt', type: 'int', min: 0 },
        { key: 'maxProgress', label: 'Tiến độ tối đa', type: 'int', min: 0 }, { key: 'aggregationType', label: 'Cộng dồn', type: 'select', options: ENUM.aggregation },
        { key: 'resetType', label: 'Đặt lại', type: 'select', options: ENUM.resetType }, { key: 'weight', label: 'Trọng số', type: 'int' },
        { key: 'targetType', label: 'Đối tượng (loại)', type: 'select', options: ENUM.targetType }, { key: 'targetId', label: 'Đối tượng (id)', type: 'int' },
        { key: 'isActive', label: 'Đang bật', type: 'bool' },
      ];
      const params = v => ({
        p_title: v.title, p_task_type: v.taskType, p_description: v.description, p_condition_type: v.conditionType, p_condition_value: v.conditionValue,
        p_max_progress: v.maxProgress, p_aggregation_type: v.aggregationType, p_reset_type: v.resetType, p_weight: v.weight,
        p_target_type: v.targetType, p_target_id: v.targetId, p_is_active: v.isActive !== false,
      });
      const done = PT.filter(x => x.completedAt || x.status === 'completed' || x.status === 'claimed').length;
      return {
        kpis: [
          { label: 'Nhiệm vụ', value: fmtNum(T.length), sub: `${T.filter(active).length} đang bật` },
          { label: 'Tiến độ người dùng', value: fmtNum(PT.length) },
          { label: 'Đã xong', value: fmtNum(done), sub: PT.length ? `${Math.round(done * 100 / PT.length)}%` : '' },
        ],
        tabs: [
          { id: 't', label: `Nhiệm vụ (${T.length})`, render: b => Kit.section(b, {
            title: 'Nhiệm vụ', rows: T, onChange: reload, csvName: 'task',
            columns: [{ key: 'id', label: 'ID' }, { key: 'title', label: 'Tên' }, { key: 'taskType', label: 'Loại' }, { key: 'conditionType', label: 'Điều kiện' },
              { key: 'conditionValue', label: 'Cần đạt' }, { key: 'resetType', label: 'Đặt lại' }, { key: 'weight', label: 'Trọng số' }],
            create: { label: '＋  Thêm nhiệm vụ', fields, values: () => ({ taskType: 'daily', resetType: 'daily', conditionType: 'count', aggregationType: 'accumulate', isActive: true }), fn: 'tt_admin_task_create', params },
            edit: { fields, fn: 'tt_admin_task_update', params: (v, r) => ({ ...params(v), p_task_id: r.id }) },
            toggles: [{ label: 'Bật', get: r => r.isActive !== false && !r.deletedAt, fn: 'tt_admin_task_set_active', params: (r, on) => ({ p_task_id: r.id, p_is_active: on }) }],
            del: { fn: 'tt_admin_task_delete', params: r => ({ p_task_id: r.id }), note: 'Xoá hẳn, kèm tiến độ người dùng của nhiệm vụ.' },
          }) },
          { id: 'e', label: 'Sự kiện', render: b => Kit.section(b, {
            title: 'Nhiệm vụ ↔ loại sự kiện', rows: s.taskEventMaps || [], onChange: reload,
            columns: [{ key: 'taskId', label: 'Nhiệm vụ', render: r => nameOf(T, r.taskId) }, { key: 'eventTypeId', label: 'Sự kiện', render: r => nameOf(E, r.eventTypeId, x => x.codename) }],
            create: { label: '＋  Gắn', fields: [
              { key: 'task', label: 'Nhiệm vụ', type: 'select', required: true, options: Kit.opts(T) },
              { key: 'ev', label: 'Sự kiện', type: 'select', required: true, options: Kit.opts(E, 'id', x => x.codename) },
            ], fn: 'tt_admin_task_event_map_upsert', params: v => ({ p_task_id: Number(v.task), p_event_type_id: Number(v.ev) }) },
            del: { fn: 'tt_admin_task_event_map_delete', params: r => ({ p_task_id: r.taskId, p_event_type_id: r.eventTypeId }), label: r => `nhiệm vụ #${r.taskId} ↔ sự kiện #${r.eventTypeId}` },
          }) },
          { id: 'r', label: 'Phần thưởng', render: b => Kit.section(b, {
            title: 'Nhiệm vụ ↔ phần thưởng', rows: s.taskRewards || [], onChange: reload,
            columns: [{ key: 'taskId', label: 'Nhiệm vụ', render: r => nameOf(T, r.taskId) }, { key: 'rewardId', label: 'Phần thưởng', render: r => nameOf(R, r.rewardId) }],
            create: { label: '＋  Gắn', fields: [
              { key: 'task', label: 'Nhiệm vụ', type: 'select', required: true, options: Kit.opts(T) },
              { key: 'reward', label: 'Phần thưởng', type: 'select', required: true, options: Kit.opts(R) },
            ], fn: 'tt_admin_task_reward_upsert', params: v => ({ p_task_id: Number(v.task), p_reward_id: Number(v.reward) }) },
            del: { fn: 'tt_admin_task_reward_delete', params: r => ({ p_task_id: r.taskId, p_reward_id: r.rewardId }), label: r => `nhiệm vụ #${r.taskId} ↔ thưởng #${r.rewardId}` },
          }) },
          { id: 'p', label: `Tiến độ (${PT.length})`, render: b => Kit.section(b, {
            title: 'Tiến độ nhiệm vụ của người dùng', rows: PT, csvName: 'profile_task_progress', pageSize: 50,
            columns: [{ key: 'profileId', label: 'Profile' }, { key: 'taskId', label: 'Nhiệm vụ', render: r => nameOf(T, r.taskId) },
              { key: 'periodKey', label: 'Kỳ' }, { key: 'progressValue', label: 'Tiến độ' }, { key: 'status', label: 'Trạng thái' },
              { key: 'completedAt', label: 'Xong', render: r => Kit.dateTime(r.completedAt) }, { key: 'claimedAt', label: 'Nhận', render: r => Kit.dateTime(r.claimedAt) }],
          }) },
        ],
      };
    },
  }),
});

// ════════ Bảng xếp hạng ════════════════════════════════════════════════
Admin.register({
  id: 'leaderboard', title: 'Bảng xếp hạng', icon: '📊', group: 'Quản lý', order: 18,
  render: main => snapshotPage(main, {
    title: 'Quản lý bảng xếp hạng', fn: 'tt_admin_leaderboard_snapshot',
    desc: 'Bảng xếp hạng (chỉ số, kỳ). Điểm của từng người do worker tính — ở đây chỉ xem.',
    build: (s, reload) => {
      const L = s.leaderboards || [], E = s.entries || [];
      const fields = [
        { key: 'title', label: 'Tên', type: 'text', required: true },
        { key: 'leaderboardType', label: 'Kỳ', type: 'select', required: true, options: ENUM.lbType },
        { key: 'metricKey', label: 'Chỉ số', type: 'select', required: true, options: ENUM.metricKey },
        { key: 'metricUnit', label: 'Đơn vị', type: 'select', required: true, options: ENUM.metricUnit },
        { key: 'referenceType', label: 'Gắn với (loại)', type: 'select', options: ENUM.refType }, { key: 'referenceId', label: 'Gắn với (id)', type: 'int' },
        { key: 'startedAt', label: 'Bắt đầu', type: 'datetime' }, { key: 'endedAt', label: 'Kết thúc', type: 'datetime' },
        { key: 'isActive', label: 'Đang chạy', type: 'bool' },
      ];
      const params = v => ({
        p_title: v.title, p_leaderboard_type: v.leaderboardType, p_metric_key: v.metricKey, p_metric_unit: v.metricUnit,
        p_reference_type: v.referenceType, p_reference_id: v.referenceId, p_started_at: v.startedAt, p_ended_at: v.endedAt, p_is_active: v.isActive !== false,
      });
      return {
        kpis: [{ label: 'Bảng', value: fmtNum(L.length) }, { label: 'Dòng điểm', value: fmtNum(E.length) }],
        tabs: [
          { id: 'l', label: `Bảng (${L.length})`, render: b => Kit.section(b, {
            title: 'Bảng xếp hạng', rows: L, onChange: reload,
            columns: [{ key: 'id', label: 'ID' }, { key: 'title', label: 'Tên' }, { key: 'leaderboardType', label: 'Kỳ' }, { key: 'metricKey', label: 'Chỉ số' },
              { key: 'metricUnit', label: 'Đơn vị' }, { key: '_n', label: 'Người', render: r => fmtNum(E.filter(x => x.leaderboardId === r.id).length) },
              { key: 'startedAt', label: 'Từ', render: r => Kit.date(r.startedAt) }, { key: 'endedAt', label: 'Đến', render: r => Kit.date(r.endedAt) }],
            create: { label: '＋  Thêm bảng', fields, values: () => ({ leaderboardType: 'weekly', metricKey: 'exp_earned_sum', metricUnit: 'exp', isActive: true }), fn: 'tt_admin_leaderboard_create', params },
            edit: { fields, values: r => ({ ...r, isActive: !r.deletedAt }), fn: 'tt_admin_leaderboard_update', params: (v, r) => ({ ...params(v), p_id: r.id }) },
            del: { fn: 'tt_admin_leaderboard_delete', params: r => ({ p_id: r.id }), note: 'Xoá hẳn, kèm các dòng điểm.' },
          }) },
          { id: 'e', label: `Điểm (${E.length})`, render: b => Kit.section(b, {
            title: 'Điểm từng người', rows: E.slice().sort((a, x) => (x.scoreValue || 0) - (a.scoreValue || 0)), csvName: 'leaderboard_entry', pageSize: 50,
            columns: [{ key: 'leaderboardId', label: 'Bảng', render: r => nameOf(L, r.leaderboardId) }, { key: 'profileId', label: 'Profile' },
              { key: 'scoreValue', label: 'Điểm' }, { key: 'evaluatedAt', label: 'Tính lúc', render: r => Kit.dateTime(r.evaluatedAt) }],
          }) },
        ],
      };
    },
  }),
});

// ════════ Cộng đồng ════════════════════════════════════════════════════
/* Bản cũ chỉ có dữ liệu mẫu. Ở đây đọc / sửa thẳng các bảng feedback,
   feedback_comment, feedback_vote (có nhật ký). */
Admin.register({
  id: 'community', title: 'Cộng đồng', icon: '💬', group: 'Quản lý', order: 19,
  render: main => {
    pageHead(main, 'Cộng đồng — góp ý', 'Góp ý / báo lỗi của người dùng (feedback), bình luận và bình chọn. Đổi trạng thái để theo dõi xử lý.');
    Kit.tabs(main, [
      { id: 'fb', label: 'Góp ý', render: b => {
        let st = '';
        const sel = el('select', 'ainput');
        sel.innerHTML = '<option value="">mọi trạng thái</option>' + ENUM.fbStatus.map(x => `<option>${x}</option>`).join('');
        sel.onchange = () => { st = sel.value; t.reload(); };
        const t = Kit.serverTable(b, {
          table: 'feedback', toolbar: [sel], query: () => ({ f: st ? [`status|eq|${st}`] : [] }),
          onRow: r => feedbackModal(r, () => t.reload()),
          columns: [{ key: 'id', label: 'ID' }, { key: 'createdAt', label: 'Lúc', render: r => Kit.dateTime(r.createdAt) },
            { key: 'profileId', label: 'Profile' }, { key: 'feedbackType', label: 'Loại' }, { key: 'targetType', label: 'Về' },
            { key: 'title', label: 'Tiêu đề', render: r => Kit.text(r.title || r.content || r.message).slice(0, 70) },
            { key: 'status', label: 'Trạng thái', render: r => Kit.badge(r.status || '—', r.status === 'resolved' || r.status === 'closed' ? 'ok' : r.status === 'new' ? 'warn' : '') }],
        });
      } },
      { id: 'cm', label: 'Bình luận', render: b => Kit.serverTable(b, {
        table: 'feedback_comment', onRow: r => location.assign(`#/tables/feedback_comment`),
        columns: [{ key: 'id', label: 'ID' }, { key: 'feedbackId', label: 'Góp ý' }, { key: 'profileId', label: 'Profile' },
          { key: 'content', label: 'Nội dung', render: r => Kit.text(r.content || r.comment).slice(0, 90) }, { key: 'createdAt', label: 'Lúc', render: r => Kit.dateTime(r.createdAt) }],
      }) },
      { id: 'vt', label: 'Bình chọn', render: b => Kit.serverTable(b, {
        table: 'feedback_vote', order: 'createdAt',
        columns: [{ key: 'feedbackId', label: 'Góp ý' }, { key: 'profileId', label: 'Profile' }, { key: 'voteType', label: 'Bình chọn', render: r => Kit.text(r.voteType ?? r.value ?? r.vote) },
          { key: 'createdAt', label: 'Lúc', render: r => Kit.dateTime(r.createdAt) }],
      }) },
    ]);
  },
});

function feedbackModal(r, done) {
  const facts = el('div', 'kfacts');
  for (const [k, v] of Object.entries(r)) facts.insertAdjacentHTML('beforeend', `<div class="k">${esc(k)}</div><div class="v">${esc(Kit.json(v))}</div>`);
  const f = Kit.form([
    { key: 'status', label: 'Trạng thái', type: 'select', required: true, options: ENUM.fbStatus },
    { key: 'isHidden', label: 'Ẩn khỏi cộng đồng', type: 'bool' },
  ], r);
  const body = el('div');
  body.append(facts, f.node);
  modal({
    title: `Góp ý #${r.id}`, body, wide: '52rem', okLabel: 'Lưu trạng thái',
    onOk: async () => {
      const v = f.read();
      const changes = {};
      if (v.status !== r.status) changes.status = v.status;
      if (v.isHidden != null && v.isHidden !== !!r.isHidden) changes.isHidden = v.isHidden;
      if (!Object.keys(changes).length) return;
      if (!(await Kit.ensureWrite())) throw new Error('Cần bật "Cho phép ghi"');
      await api('/api/admin/tables/feedback/rows', { method: 'PATCH', body: JSON.stringify({ pk: { id: r.id }, changes }) });
      toast('Đã lưu');
      done();
    },
  });
}
