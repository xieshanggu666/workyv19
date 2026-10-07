// ===== 危机整改事项（Rectification Items） =====
// 管理员为未结案危机制定整改事项并指派外部协作方（品牌方/监管方/媒体）落实；
// 外部协作方通过外部门户分批提交整改进度/报验，值班员分派跟进人并催办，管理员验收（通过/驳回）。
// 联动：复用通知编排（rect_event）、回写协同工单日志、写危机统一时间线（ref_type='rect' 锚点）、
// 复盘报告聚合「整改事项」章节；未达验收终态的整改事项纳入统一结案守卫（硬阻断）。
import { db } from './db.js'
import { now, addTimeline } from './pipeline.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 常量与口径 =====
export const RECT_STATUS = {
  todo: '待分派',
  progress: '整改中',
  review: '待验收',
  accepted: '已验收',
  rejected: '已驳回',
  cancelled: '已取消'
}
export const RECT_PRIORITY = { urgent: '紧急', high: '高', normal: '普通' }
// 未办结（结案守卫阻断）：待分派/整改中/待验收/已驳回（驳回后仍须重新报验）
export const RECT_OPEN_STATUSES = ['todo', 'progress', 'review', 'rejected']
export const RECT_TERMINAL_STATUSES = ['accepted', 'cancelled']

function safeParse(s, dft) { try { return JSON.parse(s || '') ?? dft } catch { return dft } }

function addLog(rectId, action, content, operator = '系统', side = 'system', extra = {}) {
  run(`INSERT INTO rect_progress (rect_id,action,content,attachments,source_url,contact_info,is_urgent,operator,operator_side,time)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
    rectId, action, content || '',
    JSON.stringify(extra.attachments || []), String(extra.sourceUrl || ''), String(extra.contactInfo || ''),
    extra.isUrgent ? 1 : 0, operator || '系统', side, now())
}

// 整改编号：RECT + 4 位顺序号
function nextCode() {
  const row = q1("SELECT code FROM rect_items WHERE code LIKE 'RECT-%' ORDER BY CAST(SUBSTR(code,6) AS INTEGER) DESC LIMIT 1")
  let n = 2000
  if (row) {
    const m = String(row.code).match(/RECT-(\d+)/)
    if (m) n = Math.max(n, parseInt(m[1], 10))
  }
  return `RECT-${n + 1}`
}

// 通知联动在 index.js 注入（避免 notify ↔ rectify 循环依赖）
// notifyOnRect(rectId, rectEvent, opts)：按整改事件订阅生成通知任务
let notifyHooks = { notifyOnRect: null, deleteNotifyOfRects: null }
export function bindRectifyNotify(h) { notifyHooks = { ...notifyHooks, ...h } }
function fireNotify(rectId, event, opts) {
  if (!notifyHooks.notifyOnRect) return
  try { notifyHooks.notifyOnRect(rectId, event, opts || {}) } catch (e) { console.error('[RECT] 通知生成失败：', e.message) }
}

// 带整改锚点的危机时间线写入（ref_type='rect'，看板时间线可点击直达整改事项）
function addRectTimeline(crisisId, action, note, rectId, timeStr) {
  addTimeline(crisisId, action, note, timeStr)
  run("UPDATE crisis_timeline SET ref_type='rect', ref_id=? WHERE id=(SELECT MAX(id) FROM crisis_timeline WHERE crisis_id=?)",
    rectId, crisisId)
}

// 回写协同工单日志（action='rect'，不改工单状态）
function logWorkOrder(workOrderId, rect, detail, operator, timeStr) {
  if (!workOrderId) return
  run('INSERT INTO work_order_logs (wo_id,action,detail,operator,operator_role,time) VALUES (?,?,?,?,?,?)',
    workOrderId, 'rect', detail, operator, '', timeStr || now())
}

function parseAttachments(list) {
  if (!Array.isArray(list)) return []
  return list.slice(0, 10).map((a) => ({
    name: String(a?.name || '附件').slice(0, 120),
    size: Math.max(0, Math.min(50 * 1024 * 1024, +a?.size || 0)),
    type: String(a?.type || '').slice(0, 80)
  })).filter((a) => a.name)
}

// ===== 查询 =====
const JOIN_FROM = `FROM rect_items r
  LEFT JOIN crisis c ON c.id=r.crisis_id
  LEFT JOIN ext_partners p ON p.id=r.partner_id
  LEFT JOIN work_orders wo ON wo.id=r.work_order_id
  LEFT JOIN ext_submissions es ON es.id=r.source_submission_id`

function decorate(row) {
  return {
    ...row,
    statusText: RECT_STATUS[row.status] || row.status,
    priorityText: RECT_PRIORITY[row.priority] || row.priority,
    partner_kind: row.partner_kind || '',
    partner_kindText: { brand: '品牌方', regulator: '监管方', media: '媒体' }[row.partner_kind] || '',
    progress_count: row.progress_count || 0,
    latest_progress: row.latest_progress ? safeParse(row.latest_progress, null) : null
  }
}

function listQuery(where, args = []) {
  return q(`SELECT r.*,
      c.title crisis_title, c.status crisis_status, c.level crisis_level, c.topic crisis_topic,
      p.name partner_name, p.kind partner_kind, p.contact partner_contact,
      wo.title wo_title,
      (SELECT COUNT(*) FROM rect_progress rp WHERE rp.rect_id=r.id) progress_count,
      (SELECT json_object('id',id,'action',action,'content',content,'time',time,'operator',operator,'operator_side',operator_side,'is_urgent',is_urgent)
         FROM rect_progress WHERE rect_id=r.id ORDER BY id DESC LIMIT 1) latest_progress
    ${JOIN_FROM} ${where} ORDER BY
      CASE r.status WHEN 'review' THEN 0 WHEN 'todo' THEN 1 WHEN 'rejected' THEN 2 WHEN 'progress' THEN 3 ELSE 9 END,
      r.priority='urgent' DESC, r.id DESC LIMIT 300`, ...args).map(decorate)
}

// 内部看板：状态/危机/协作方过滤
export function listRectItems({ status = '', crisisId = null, partnerId = null } = {}) {
  let where = 'WHERE 1=1'
  const args = []
  if (status) { where += ' AND r.status=?'; args.push(status) }
  if (crisisId) { where += ' AND r.crisis_id=?'; args.push(crisisId) }
  if (partnerId) { where += ' AND r.partner_id=?'; args.push(partnerId) }
  return listQuery(where, args)
}

// 门户：仅返回指派给该协作方的整改事项（数据严格隔离）
export function listPartnerRectItems(partnerId) {
  return listQuery('WHERE r.partner_id=?', [partnerId])
}

export function getRectItem(id) {
  const r = q1(`SELECT r.*,
      c.title crisis_title, c.status crisis_status, c.level crisis_level, c.topic crisis_topic,
      p.name partner_name, p.kind partner_kind, p.contact partner_contact, p.access_code partner_code,
      wo.title wo_title, es.code source_submission_code
    ${JOIN_FROM} WHERE r.id=?`, id)
  if (!r) return null
  const d = decorate(r)
  d.progress = q('SELECT * FROM rect_progress WHERE rect_id=? ORDER BY id ASC', id)
    .map((p) => ({ ...p, attachments: safeParse(p.attachments, []) || [] }))
  return d
}

// 门户查看：口令必须属于被指派协作方本人
export function getRectItemForPartner(id, partnerId) {
  const r = q1('SELECT id FROM rect_items WHERE id=? AND partner_id=?', id, partnerId)
  return r ? getRectItem(id) : null
}

// 看板汇总（内部角标/总览统计/复盘快照同源）
export function rectSummary() {
  const rows = q('SELECT status, COUNT(*) c FROM rect_items GROUP BY status')
  const counts = { todo: 0, progress: 0, review: 0, accepted: 0, rejected: 0, cancelled: 0 }
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + r.c
  const urgentOpen = q1(`SELECT COUNT(*) c FROM rect_items WHERE priority='urgent' AND status IN ('todo','progress','review','rejected')`).c
  return {
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    todo: counts.todo,
    progress: counts.progress,
    review: counts.review,
    rejected: counts.rejected,
    open: counts.todo + counts.progress + counts.review + counts.rejected,
    accepted: counts.accepted,
    urgentOpen
  }
}

// 危机卡片角标：该事件整改事项在办/待验收数
export function crisisRectBrief(crisisId) {
  const row = q1(`SELECT
      (SELECT COUNT(*) FROM rect_items WHERE crisis_id=? AND status IN ('todo','progress','review','rejected')) open,
      (SELECT COUNT(*) FROM rect_items WHERE crisis_id=? AND status='review') review,
      (SELECT COUNT(*) FROM rect_items WHERE crisis_id=? AND priority='urgent' AND status IN ('todo','progress','review','rejected')) urgent,
      (SELECT COUNT(*) FROM rect_items WHERE crisis_id=? AND status='accepted') accepted,
      (SELECT COUNT(*) FROM rect_items WHERE crisis_id=?) total`,
    crisisId, crisisId, crisisId, crisisId, crisisId)
  return row && row.total ? { open: row.open, review: row.review, urgent: row.urgent, accepted: row.accepted, total: row.total } : null
}

// 门户首页附加：指派给该协作方的整改事项
export function partnerRectBootstrap(partnerId) {
  return listPartnerRectItems(partnerId)
}

// ===== 新建整改事项（admin；必须挂接未结案危机；协作方创建时可留空待值班员分派） =====
export function createRectItem(body, actor) {
  const b = body || {}
  const crisisId = +b.crisis_id || null
  if (!crisisId) return { error: '整改事项必须挂接危机事件' }
  const c = q1('SELECT id,status,title FROM crisis WHERE id=?', crisisId)
  if (!c) return { error: '关联危机事件不存在' }
  if (c.status === 'closed') return { error: '已结案事件不能新增整改事项（如需请先回滚结案）' }
  const title = String(b.title || '').trim()
  if (!title) return { error: '整改事项标题必填' }
  const requirement = String(b.requirement || '').trim()
  if (!requirement) return { error: '请填写整改要求/验收标准' }

  let partnerId = null
  if (b.partner_id) {
    const p = q1('SELECT id,enabled FROM ext_partners WHERE id=?', +b.partner_id)
    if (!p) return { error: '指派协作方不存在' }
    if (!p.enabled) return { error: '该协作方已停用，不能指派（可先在外部协作页启用）' }
    partnerId = p.id
  }
  let workOrderId = null
  if (b.work_order_id) {
    const wo = q1('SELECT id,crisis_id,status FROM work_orders WHERE id=?', +b.work_order_id)
    if (!wo) return { error: '关联工单不存在' }
    if (wo.crisis_id !== crisisId) return { error: '关联工单不属于该危机事件' }
    if (['done', 'cancelled'].includes(wo.status)) return { error: '关联工单已完结/取消，不能回写（可先在工单页回退重做）' }
    workOrderId = wo.id
  }
  let sourceSubmissionId = null
  if (b.source_submission_id) {
    const s = q1('SELECT id,crisis_id,status FROM ext_submissions WHERE id=?', +b.source_submission_id)
    if (!s) return { error: '来源外部提交不存在' }
    if (s.crisis_id && s.crisis_id !== crisisId) return { error: '来源外部提交不属于该危机事件' }
    sourceSubmissionId = s.id
  }
  const priority = RECT_PRIORITY[b.priority] ? b.priority : 'normal'
  const ts = now()
  const code = nextCode()
  const initial = partnerId ? 'progress' : 'todo'
  const r = run(`INSERT INTO rect_items
    (code,crisis_id,partner_id,work_order_id,source_submission_id,title,requirement,due_at,priority,status,
     follower,follower_role,assigned_by,assigned_at,created_by,created_at,review_round,updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
    code, crisisId, partnerId, workOrderId, sourceSubmissionId, title, requirement,
    String(b.due_at || '').trim().slice(0, 60), priority, initial,
    partnerId ? actor.user : '', partnerId ? actor.role : '', partnerId ? actor.user : '', partnerId ? ts : null,
    actor.user, ts, ts)
  const id = Number(r.lastInsertRowid)
  addLog(id, 'create', `管理员 ${actor.user} 新建整改事项「${title}」（${RECT_PRIORITY[priority]}）` +
    (partnerId ? '，创建即指派协作方落实' : '，待值班员分派跟进') +
    (sourceSubmissionId ? `；来源外部提交 #${sourceSubmissionId}` : ''), actor.user, 'internal')
  addRectTimeline(crisisId, '整改新建',
    `新建危机整改事项「${title}」（${code}，${RECT_PRIORITY[priority]}）` +
      (partnerId ? `，已指派协作方落实` : '，待分派跟进') +
      (b.due_at ? `，期限 ${String(b.due_at).trim()}` : ''), id, ts)
  logWorkOrder(workOrderId, `新建危机整改事项「${title}」（${code}）`, actor.user, ts)
  if (partnerId) {
    addLog(id, 'assign', `创建时即指派协作方 #${partnerId} 落实（跟进人暂缺，值班员可补分派跟进）`, actor.user, 'internal')
    fireNotify(id, 'assigned', { by: 'create' })
  }
  return { ok: true, id, code, status: initial }
}

// ===== 值班员分派跟进（ops+：指定/改派协作方与内部跟进人；todo/progress/rejected/review 均可分派） =====
export function assignRectItem(id, body, actor) {
  const r = q1('SELECT * FROM rect_items WHERE id=?', id)
  if (!r) return null
  if (['accepted', 'cancelled'].includes(r.status)) {
    return { error: `已${r.status === 'accepted' ? '验收' : '取消'}的整改事项不能再分派（当前：${RECT_STATUS[r.status]}）` }
  }
  const b = body || {}
  const partnerId = +b.partner_id || null
  if (!partnerId) return { error: '请选择负责落实的外部协作方' }
  const p = q1('SELECT id,name,kind,enabled FROM ext_partners WHERE id=?', partnerId)
  if (!p) return { error: '协作方不存在' }
  if (!p.enabled) return { error: '该协作方已停用，不能指派' }
  const follower = String(b.follower || '').trim() || actor.user
  const followerRole = String(b.follower_role || '').trim() || actor.role || 'ops'
  const note = String(b.note || '').trim()
  const ts = now()
  const partnerChanged = r.partner_id !== partnerId
  const nextStatus = r.status === 'todo' ? 'progress' : r.status
  const r2 = run(`UPDATE rect_items SET partner_id=?, follower=?, follower_role=?, assigned_by=?, assigned_at=?,
    status=CASE WHEN status='todo' THEN 'progress' ELSE status END, reject_reason='', updated=? WHERE id=?`,
    partnerId, follower, followerRole, actor.user, ts, ts, id)
  if (!Number(r2.changes)) return { error: '整改事项状态已变化，请刷新' }
  const kindLabel = { brand: '品牌方', regulator: '监管方', media: '媒体' }[p.kind] || '协作方'
  addLog(id, 'assign',
    (r.partner_id ? `改派：${kindLabel}（${p.name}）` : `分派给${kindLabel}（${p.name}）落实`) +
      `，内部跟进人：${follower}（${followerRole}）` + (note ? `；分派说明：${note}` : ''),
    actor.user, 'internal')
  const c = q1('SELECT status FROM crisis WHERE id=?', r.crisis_id)
  if (c && c.status !== 'closed') {
    addRectTimeline(r.crisis_id, r.partner_id ? '整改改派' : '整改分派',
      `整改事项 ${r.code}「${r.title}」${r.partner_id ? '改派' : '分派'}给${kindLabel}（${p.name}），跟进人：${follower}` +
        (note ? `；${note.slice(0, 120)}` : ''), id, ts)
  }
  logWorkOrder(r.work_order_id, null,
    `整改事项 ${r.code}「${r.title}」${r.partner_id ? '改派' : '分派'}给${kindLabel}（${p.name}），跟进人：${follower}`, actor.user, ts)
  // 通知：首次分派与改派均触发（按「分派轮次×协作方」幂等）
  fireNotify(id, 'assigned', { by: partnerChanged && r.partner_id ? 'reassign' : 'assign' })
  return { ok: true, status: nextStatus, partnerId }
}

// ===== 值班员催办（ops+：整改中/待验收/已驳回可催办；每次催办生成通知，按次数幂等） =====
export function remindRectItem(id, body, actor) {
  const r = q1('SELECT * FROM rect_items WHERE id=?', id)
  if (!r) return null
  if (!RECT_OPEN_STATUSES.includes(r.status)) return { error: `当前状态（${RECT_STATUS[r.status] || r.status}）不能催办` }
  if (!r.partner_id) return { error: '尚未分派协作方，请先分派后再催办' }
  const content = String(body?.content || '').trim() || '请加快整改进度并按时提交报验。'
  const ts = now()
  run('UPDATE rect_items SET updated=? WHERE id=?', ts, id)
  const remindCount = q1("SELECT COUNT(*) c FROM rect_progress WHERE rect_id=? AND action='remind'", id).c
  addLog(id, 'remind', content, actor.user, 'internal')
  const c = q1('SELECT status FROM crisis WHERE id=?', r.crisis_id)
  if (c && c.status !== 'closed') {
    addRectTimeline(r.crisis_id, '整改催办',
      `值班员 ${actor.user} 催办整改事项 ${r.code}「${r.title}」（第 ${remindCount + 1} 次）：${content.slice(0, 120)}`, id, ts)
  }
  logWorkOrder(r.work_order_id, null, `整改事项 ${r.code} 第 ${remindCount + 1} 次催办：${content.slice(0, 100)}`, actor.user, ts)
  fireNotify(id, 'remind', { seq: remindCount + 1, content })
  return { ok: true, seq: remindCount + 1 }
}

// ===== 外部协作方提交进度/报验（门户口令鉴权） =====
// submit=false（默认）仅追加进度：todo→progress；submit=true 报验：progress/rejected/todo→review，触发验收通知（紧急报验升级）
export function submitRectProgress(id, body, partner) {
  const r = q1('SELECT * FROM rect_items WHERE id=? AND partner_id=?', id, partner.id)
  if (!r) return null
  if (['accepted', 'cancelled'].includes(r.status)) {
    return { error: `整改事项已${r.status === 'accepted' ? '验收通过' : '取消'}，不能再提交进度` }
  }
  const b = body || {}
  const content = String(b.content || '').trim()
  if (!content) return { error: '请填写整改进度说明' }
  const submit = !!b.submit
  if (submit && r.status === 'review') return { error: '该事项已提交报验，正在等待管理员验收' }
  const attachments = parseAttachments(b.attachments)
  const sourceUrl = String(b.source_url || '').trim().slice(0, 500)
  const contactInfo = String(b.contact_info || '').trim().slice(0, 200)
  const isUrgent = !!b.is_urgent
  const ts = now()
  const round = submit ? (r.review_round || 0) + 1 : (r.review_round || 0)
  const nextStatus = submit ? 'review' : (r.status === 'todo' ? 'progress' : r.status)
  const extra = { attachments, sourceUrl: sourceUrl, contactInfo: contactInfo || partner.contact || '', isUrgent }
  db.exec('BEGIN')
  try {
    run(`UPDATE rect_items SET status=?, submitted_by=?, submitted_at=?, review_round=?, reject_reason='', updated=? WHERE id=?`,
      nextStatus, partner.contact || partner.name, ts, round, ts, id)
    addLog(id, submit ? 'submit' : 'progress', content, partner.contact || partner.name, 'external', extra)
    const c = q1('SELECT status,title FROM crisis WHERE id=?', r.crisis_id)
    if (c && c.status !== 'closed') {
      if (submit) {
        addRectTimeline(r.crisis_id, isUrgent ? '整改报验升级' : '整改报验',
          `${{ brand: '品牌方', regulator: '监管方', media: '媒体' }[partner.kind] || '协作方'}（${partner.name}）提交整改报验「${r.title}」（${r.code}，第 ${round} 轮）` +
            (isUrgent ? '，标记紧急请立即验收' : '，等待管理员验收') + `：${content.slice(0, 100)}`, id, ts)
      } else {
        addRectTimeline(r.crisis_id, '整改进度',
          `${{ brand: '品牌方', regulator: '监管方', media: '媒体' }[partner.kind] || '协作方'}（${partner.name}）提交整改进度「${r.title}」（${r.code}）：${content.slice(0, 100)}`, id, ts)
      }
    }
    logWorkOrder(r.work_order_id, null,
      submit
        ? `整改事项 ${r.code}「${r.title}」协作方提交报验（第 ${round} 轮${isUrgent ? '，紧急' : ''}）：${content.slice(0, 100)}`
        : `整改事项 ${r.code}「${r.title}」协作方提交整改进度：${content.slice(0, 100)}`,
      partner.contact || partner.name, ts)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  if (submit) fireNotify(id, 'review', { round, urgent: isUrgent })
  else fireNotify(id, 'submitted', {})
  return { ok: true, status: nextStatus, round: round }
}

// ===== 管理员验收通过（仅 admin；review/rejected/progress 均可验收，以报验为准） =====
export function acceptRectItem(id, body, actor) {
  const r = q1('SELECT * FROM rect_items WHERE id=?', id)
  if (!r) return null
  if (['accepted', 'cancelled'].includes(r.status)) {
    return { error: `整改事项已${r.status === 'accepted' ? '验收通过' : '取消'}（当前：${RECT_STATUS[r.status]}）` }
  }
  if (r.status === 'todo') return { error: '整改事项尚未分派，不能验收' }
  const note = String(body?.note || '').trim()
  const resolveAlerts = body?.resolve_alerts ? 1 : 0
  const ts = now()
  let resolved = 0
  const ruleNames = []
  db.exec('BEGIN')
  try {
    run(`UPDATE rect_items SET status='accepted', accepted_by=?, accepted_at=?, accepted_note=?, reject_reason='', updated=? WHERE id=?`,
      actor.user, ts, note, ts, id)
    addLog(id, 'accept', `管理员 ${actor.user} 验收通过` + (note ? `：${note}` : ''), actor.user, 'internal')
    // 联动解除该危机全部未解除预警（resolve_kind=rect，状态守卫幂等；与工单/门户采纳同口径）
    if (resolveAlerts) {
      const opens = q("SELECT * FROM alert_events WHERE crisis_id=? AND status='open'", r.crisis_id)
      for (const ev of opens) {
        run("UPDATE alert_events SET status='resolved', resolved=?, resolve_kind='rect' WHERE id=? AND status='open'", ts, ev.id)
      }
      resolved = opens.length
      for (const rid of [...new Set(opens.map((e) => e.alert_id))]) {
        const al = q1('SELECT title FROM alerts WHERE id=?', rid)
        ruleNames.push(al ? `「${al.title}」` : '已删除规则')
      }
    }
    const c = q1('SELECT status FROM crisis WHERE id=?', r.crisis_id)
    if (c && c.status !== 'closed') {
      const bits = [`整改事项 ${r.code}「${r.title}」验收通过（验收人：${actor.user}）`]
      if (note) bits.push(`验收意见：${note}`)
      if (resolved) bits.push(`同步解除 ${resolved} 条未解除预警${ruleNames.length ? '：' + ruleNames.join('、') : ''}`)
      addRectTimeline(r.crisis_id, '整改验收', bits.join('；'), id, ts)
    }
    logWorkOrder(r.work_order_id, null,
      `整改事项 ${r.code}「${r.title}」验收通过（验收人：${actor.user}）` + (resolved ? `，联动解除 ${resolved} 条预警` : ''),
      actor.user, ts)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  fireNotify(id, 'accepted', {})
  return { ok: true, resolved }
}

// ===== 管理员验收驳回（仅 admin；退回协作方重新整改，门户可见驳回原因） =====
export function rejectRectItem(id, body, actor) {
  const r = q1('SELECT * FROM rect_items WHERE id=?', id)
  if (!r) return null
  if (['accepted', 'cancelled'].includes(r.status)) {
    return { error: `整改事项已${r.status === 'accepted' ? '验收通过' : '取消'}，不能驳回` }
  }
  if (r.status === 'todo') return { error: '整改事项尚未分派，不能驳回' }
  const reason = String(body?.reason || '').trim()
  if (!reason) return { error: '请填写驳回原因（协作方将在门户看到）' }
  const ts = now()
  // 报验轮次只随「提交报验」递增；驳回保留当前轮次口径（第 N 轮报验被驳回，补充后重新报验为第 N+1 轮）
  run(`UPDATE rect_items SET status='rejected', rejected_by=?, rejected_at=?, reject_reason=?, updated=? WHERE id=?`,
    actor.user, ts, reason, ts, id)
  addLog(id, 'reject', `管理员 ${actor.user} 验收驳回（第 ${r.review_round || 0} 轮报验）：${reason}`, actor.user, 'internal')
  const c = q1('SELECT status FROM crisis WHERE id=?', r.crisis_id)
  if (c && c.status !== 'closed') {
    addRectTimeline(r.crisis_id, '整改驳回',
      `整改事项 ${r.code}「${r.title}」第 ${r.review_round || 0} 轮报验验收驳回（验收人：${actor.user}）：${reason.slice(0, 120)}；协作方可补充进度后重新报验`, id, ts)
  }
  logWorkOrder(r.work_order_id, null, `整改事项 ${r.code}「${r.title}」第 ${r.review_round || 0} 轮报验验收驳回：${reason.slice(0, 100)}`, actor.user, ts)
  fireNotify(id, 'rejected', { round: r.review_round || 0, reason })
  return { ok: true }
}

// ===== 取消整改事项（admin：建错/重复/监管撤销要求等；已结案事件的整改档案不可改） =====
export function cancelRectItem(id, body, actor) {
  const r = q1('SELECT * FROM rect_items WHERE id=?', id)
  if (!r) return null
  if (r.status === 'cancelled') return { error: '整改事项已取消' }
  if (r.status === 'accepted') return { error: '已验收通过的整改事项不能取消（处置档案）' }
  const reason = String(body?.reason || '').trim()
  const ts = now()
  run("UPDATE rect_items SET status='cancelled', cancel_by=?, cancel_at=?, updated=? WHERE id=?",
    actor.user, ts, ts, id)
  addLog(id, 'cancel', (reason ? `取消整改事项：${reason}` : '整改事项已取消'), actor.user, 'internal')
  const c = q1('SELECT status FROM crisis WHERE id=?', r.crisis_id)
  if (c && c.status !== 'closed') {
    addRectTimeline(r.crisis_id, '整改取消',
      `整改事项 ${r.code}「${r.title}」已取消（操作人：${actor.user}）` + (reason ? `：${reason.slice(0, 120)}` : ''), id, ts)
  }
  logWorkOrder(r.work_order_id, null, `整改事项 ${r.code}「${r.title}」已取消：${reason.slice(0, 100)}`, actor.user, ts)
  return { ok: true }
}

// ===== 删除危机时：整改事项随事件级联删除（内部处置档案；进度留痕与整改类通知任务一并清理） =====
// 通知任务删除钩子由 index.js 注入（避免 notify ↔ rectify 循环依赖），含回执超时升级链后代
export function deleteRectsOfCrisis(crisisId) {
  const ids = q('SELECT id FROM rect_items WHERE crisis_id=?', crisisId).map((r) => r.id)
  if (ids.length && notifyHooks.deleteNotifyOfRects) {
    try { notifyHooks.deleteNotifyOfRects(ids) } catch (e) { console.error('[RECT] 通知任务级联删除失败：', e.message) }
  }
  for (const id of ids) run('DELETE FROM rect_progress WHERE rect_id=?', id)
  run('DELETE FROM rect_items WHERE crisis_id=?', crisisId)
  return ids.length
}

// ===== 复盘报告聚合：整改事项章节（与结案守卫同口径） =====
export function rectSnapshot(crisisId) {
  const rows = q(`SELECT r.*, p.name partner_name, p.kind partner_kind
    FROM rect_items r LEFT JOIN ext_partners p ON p.id=r.partner_id
    WHERE r.crisis_id=? ORDER BY r.id ASC`, crisisId)
  const progressOf = (id) => q('SELECT action,content,operator,operator_side,time,is_urgent,source_url FROM rect_progress WHERE rect_id=? ORDER BY id ASC', id)
  return {
    total: rows.length,
    open: rows.filter((r) => RECT_OPEN_STATUSES.includes(r.status)).length,
    todo: rows.filter((r) => r.status === 'todo').length,
    progress: rows.filter((r) => r.status === 'progress').length,
    review: rows.filter((r) => r.status === 'review').length,
    rejected: rows.filter((r) => r.status === 'rejected').length,
    accepted: rows.filter((r) => r.status === 'accepted').length,
    cancelled: rows.filter((r) => r.status === 'cancelled').length,
    rounds: rows.reduce((a, r) => a + (r.review_round || 0), 0),
    items: rows.map((r) => ({
      id: r.id, code: r.code, title: r.title, requirement: r.requirement, due_at: r.due_at,
      priority: r.priority, status: r.status,
      partner_id: r.partner_id, partner_name: r.partner_name, partner_kind: r.partner_kind,
      follower: r.follower, work_order_id: r.work_order_id, source_submission_id: r.source_submission_id,
      review_round: r.review_round, accepted_by: r.accepted_by, accepted_at: r.accepted_at, accepted_note: r.accepted_note,
      rejected_by: r.rejected_by, reject_reason: r.reject_reason, cancel_by: r.cancel_by,
      created_by: r.created_by, created_at: r.created_at, progressCount: progressOf(r.id).length,
      progress: progressOf(r.id)
    }))
  }
}
