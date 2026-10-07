// ===== 危机整改事项（Crisis Rectifications） =====
// 内部为未结案危机建立整改事项并分派外部协作方 → 协作方在门户持续报送整改进度 → 值班员分派跟进
// → 协作方申请验收 → 管理员验收通过/驳回（驳回退回继续整改，可再次报送申请）；
// 全程联动：通知编排（分派/进度/申请验收/驳回/通过）、协同工单日志、危机统一时间线（ref_type='rect' 锚点）、
// 复盘报告同源快照与统一结案守卫（待分派/整改中/待验收/已驳回 全部阻断，已取消不阻断）。
import { db } from './db.js'
import { now, addTimeline } from './pipeline.js'
import { logWorkOrder } from './dispatch.js'

const PARTNER_KIND = { brand: '品牌方', regulator: '监管方', media: '媒体' }

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 常量与口径 =====
export const RECT_STATUS = {
  pending: '待分派', rectifying: '整改中', reviewing: '待验收',
  accepted: '已通过', rejected: '已驳回', cancelled: '已取消'
}
export const RECT_PRIORITY = { urgent: '紧急', high: '高', normal: '普通' }
// 未办结（结案守卫硬阻断）：待分派/整改中/待验收/已驳回（退回继续整改）
export const RECT_OPEN_STATUSES = ['pending', 'rectifying', 'reviewing', 'rejected']
const TERMINAL_STATUSES = ['accepted', 'cancelled']

function safeParse(s, dft) { try { return JSON.parse(s || '') ?? dft } catch { return dft } }

function addLog(rectId, action, detail, operator = '系统', side = 'system') {
  run('INSERT INTO rect_logs (rect_id,action,detail,operator,operator_side,time) VALUES (?,?,?,?,?,?)',
    rectId, action, detail || '', operator || '系统', side, now())
}

// 门户编号：REC + 4 位顺序号（与 EXT 编号同风格，演示稳定可读）
function nextCode() {
  const row = q1("SELECT code FROM rectifications WHERE code LIKE 'REC-%' ORDER BY CAST(SUBSTR(code,5) AS INTEGER) DESC LIMIT 1")
  let n = 1000
  if (row) {
    const m = String(row.code).match(/REC-(\d+)/)
    if (m) n = Math.max(n, parseInt(m[1], 10))
  }
  return `REC-${n + 1}`
}

// 通知联动在 index.js 注入（避免 notify ↔ rectifications 循环依赖）
let notifyHooks = { notifyOnRectEvent: null }
export function bindRectNotify(h) { notifyHooks = { ...notifyHooks, ...h } }
function fire(rectId, event, extra = {}) {
  if (!notifyHooks.notifyOnRectEvent) return
  try { notifyHooks.notifyOnRectEvent(rectId, event, extra) } catch (e) { console.error('[RECT] 通知生成失败：', e.message) }
}

// 带整改锚点的危机时间线写入（ref_type='rect'，看板时间线可点击直达整改事项）
function addRectTimeline(crisisId, action, note, rectId, timeStr) {
  addTimeline(crisisId, action, note, timeStr)
  run('UPDATE crisis_timeline SET ref_type=?, ref_id=? WHERE id=(SELECT MAX(id) FROM crisis_timeline WHERE crisis_id=?)',
    'rect', rectId, crisisId)
}

// 回写关联协同工单日志（不改工单状态；整改进度/验收结论作为处置依据挂接工单）
function logToWorkOrder(workOrderId, action, detail, operator = '系统', role = '', timeStr) {
  if (!workOrderId) return
  logWorkOrder(workOrderId, action, detail, { user: operator, role }, { time: timeStr })
}

// ===== 查询 =====
function decorate(r) {
  if (!r) return r
  return {
    ...r,
    statusText: RECT_STATUS[r.status] || r.status,
    priorityText: RECT_PRIORITY[r.priority] || r.priority,
    kindText: PARTNER_KIND[r.kind] || r.kind,
    overdue: ['pending', 'rectifying', 'reviewing', 'rejected'].includes(r.status) && r.due_at != null && r.due_at < Date.now() ? 1 : 0
  }
}

const JOIN_FROM = `FROM rectifications rc
  LEFT JOIN crisis c ON c.id=rc.crisis_id
  LEFT JOIN ext_partners p ON p.id=rc.partner_id
  LEFT JOIN work_orders wo ON wo.id=rc.work_order_id`

function listQuery(where, args = []) {
  return q(`SELECT rc.*, p.name partner_name, p.contact partner_contact, p.access_code partner_code,
      c.title crisis_title, c.status crisis_status, c.level crisis_level, c.topic crisis_topic,
      wo.title wo_title, wo.status wo_status
    ${JOIN_FROM} ${where} ORDER BY (rc.status IN ('accepted','cancelled')) ASC, rc.due_at IS NULL, rc.due_at, rc.id DESC LIMIT 300`, ...args)
    .map(decorate)
}

// 内部看板：状态/危机/协作方/协作方类型过滤
export function listRectifications({ status = '', crisisId = null, kind = '', partnerId = null, mine = false } = {}) {
  let where = 'WHERE 1=1'
  const args = []
  if (status) { where += ' AND rc.status=?'; args.push(status) }
  if (crisisId) { where += ' AND rc.crisis_id=?'; args.push(crisisId) }
  if (kind) { where += ' AND rc.kind=?'; args.push(kind) }
  if (partnerId) { where += ' AND rc.partner_id=?'; args.push(partnerId) }
  return listQuery(where, args)
}

// 门户：某协作方自己的整改事项（不泄露其他方内容；待分派事项不展示给任何协作方）
export function listPartnerRectifications(partnerId) {
  return listQuery('WHERE rc.partner_id=?', [partnerId])
}

export function getRectification(id) {
  const r = q1(`SELECT rc.*, p.name partner_name, p.kind partner_kind_raw, p.contact partner_contact,
      p.phone partner_phone, p.email partner_email, p.access_code partner_code, p.enabled partner_enabled,
      c.title crisis_title, c.status crisis_status, c.level crisis_level, c.topic crisis_topic,
      wo.title wo_title, wo.status wo_status,
      es.code source_code, es.title source_title
    ${JOIN_FROM}
    LEFT JOIN ext_submissions es ON es.id=rc.source_submission_id
    WHERE rc.id=?`, id)
  if (!r) return null
  const d = decorate(r)
  d.progress = q('SELECT * FROM rect_progress WHERE rect_id=? ORDER BY id ASC', id).map((p) => ({
    ...p, attachments: safeParse(p.attachments, []) || []
  }))
  d.logs = q('SELECT * FROM rect_logs WHERE rect_id=? ORDER BY id ASC', id)
  return d
}

// 门户查看：口令必须属于事项分派方本人；待分派（无协作方）任何外部方均不可见
export function getRectificationForPartner(id, partnerId) {
  const r = q1('SELECT * FROM rectifications WHERE id=? AND partner_id=?', id, partnerId)
  return r ? getRectification(id) : null
}

// 看板汇总（内部角标/总览统计）
export function rectSummary() {
  const rows = q('SELECT status, COUNT(*) c FROM rectifications GROUP BY status')
  const counts = { pending: 0, rectifying: 0, reviewing: 0, accepted: 0, rejected: 0, cancelled: 0 }
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + r.c
  const nowMs = Date.now()
  const overdue = q1(`SELECT COUNT(*) c FROM rectifications
    WHERE status IN ('pending','rectifying','reviewing','rejected') AND due_at IS NOT NULL AND due_at<?`, nowMs).c
  return {
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    pending: counts.pending, rectifying: counts.rectifying, reviewing: counts.reviewing, rejected: counts.rejected,
    open: RECT_OPEN_STATUSES.reduce((a, k) => a + counts[k], 0),
    // 分派给外部方、等待外部报送（整改中 + 已驳回）
    waiting: counts.rectifying + counts.rejected,
    overdue
  }
}

// 危机卡片角标：该事件未办结整改事项（待验收数 + 临期/逾期数 + 已通过数）
export function crisisRectBrief(crisisId) {
  const row = q1(`SELECT
      (SELECT COUNT(*) FROM rectifications WHERE crisis_id=? AND status IN ('pending','rectifying','reviewing','rejected')) open,
      (SELECT COUNT(*) FROM rectifications WHERE crisis_id=? AND status='reviewing') reviewing,
      (SELECT COUNT(*) FROM rectifications WHERE crisis_id=? AND status='accepted') accepted,
      (SELECT COUNT(*) FROM rectifications WHERE crisis_id=? AND status IN ('pending','rectifying','reviewing','rejected')
        AND due_at IS NOT NULL AND due_at<?) overdue`,
    crisisId, crisisId, crisisId, crisisId, Date.now())
  return row && (row.open || row.accepted)
    ? { open: row.open, reviewing: row.reviewing, accepted: row.accepted, overdue: row.overdue }
    : null
}

// 门户首页：协作方待报送/待验收整改事项速览
export function partnerRectBrief(partnerId) {
  const rows = q('SELECT status, COUNT(*) c FROM rectifications WHERE partner_id=? GROUP BY status', partnerId)
  const counts = { pending: 0, rectifying: 0, reviewing: 0, accepted: 0, rejected: 0, cancelled: 0 }
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + r.c
  return {
    rectifying: counts.rectifying + counts.rejected,
    reviewing: counts.reviewing, accepted: counts.accepted,
    total: Object.values(counts).reduce((a, b) => a + b, 0)
  }
}

// ===== 建档（ops+；整改事项必须挂未结案危机；可直接分派协作方，也可先建档待分派） =====
export function createRectification(body, actor) {
  const b = body || {}
  const crisisId = +b.crisis_id
  const c = q1('SELECT id,title,status FROM crisis WHERE id=?', crisisId)
  if (!c) return { error: '所属危机事件不存在' }
  if (c.status === 'closed') return { error: '该事件已结案，不能再新增整改事项（如需请先回滚结案）' }
  const title = String(b.title || '').trim()
  if (!title) return { error: '整改事项标题必填' }
  const requirement = String(b.requirement || '').trim()
  const priority = RECT_PRIORITY[b.priority] ? b.priority : 'high'
  const ts = now()

  let partnerId = null
  let kind = 'brand'
  if (b.partner_id) {
    const p = q1('SELECT * FROM ext_partners WHERE id=? AND enabled=1', +b.partner_id)
    if (!p) return { error: '分派协作方不存在或已停用' }
    partnerId = p.id
    kind = p.kind
  }
  let workOrderId = null
  if (b.work_order_id) {
    const wo = q1('SELECT id,crisis_id,status FROM work_orders WHERE id=?', +b.work_order_id)
    if (!wo) return { error: '关联跟进工单不存在' }
    if (wo.crisis_id !== crisisId) return { error: '关联工单不属于该危机事件' }
    if (['done', 'cancelled'].includes(wo.status)) return { error: '关联工单已完结/取消，不能挂接整改事项（可先在工单页回退重做）' }
    workOrderId = wo.id
  }
  let sourceSubmissionId = null
  if (b.source_submission_id) {
    const es = q1('SELECT id,crisis_id,status FROM ext_submissions WHERE id=?', +b.source_submission_id)
    if (!es) return { error: '来源外部协作提交不存在' }
    if (es.crisis_id && es.crisis_id !== crisisId) return { error: '来源外部提交不属于该危机事件' }
    sourceSubmissionId = es.id
  }
  const dueAt = b.due_at ? Math.max(Date.now(), +b.due_at || 0) : null
  const status = partnerId ? 'rectifying' : 'pending'
  const code = nextCode()

  const r = run(`INSERT INTO rectifications
    (code,crisis_id,partner_id,kind,work_order_id,source_submission_id,title,requirement,priority,status,due_at,
     dispatched_by,dispatched_at,review_round,progress_count,created_by,created,updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?)`,
    code, crisisId, partnerId, kind, workOrderId, sourceSubmissionId, title, requirement, priority, status,
    dueAt, partnerId ? actor.user : '', partnerId ? ts : null, actor.user, ts, ts)
  const id = Number(r.lastInsertRowid)
  const partner = partnerId ? q1('SELECT name FROM ext_partners WHERE id=?', partnerId) : null

  addLog(id, 'create', `${actor.user} 建立整改事项「${title}」（${RECT_PRIORITY[priority]}）` +
    (sourceSubmissionId ? '，来源外部协作提交' : '') + (workOrderId ? '，关联跟进工单' : ''), actor.user, 'internal')
  if (partnerId) {
    addLog(id, 'dispatch', `建档同时分派给${PARTNER_KIND[kind]}（${partner.name}）跟进整改` +
      (dueAt ? `，整改期限 ${new Date(dueAt).toLocaleString('zh-CN')}` : ''), actor.user, 'internal')
  }
  addRectTimeline(crisisId, '整改事项建档',
    `建立整改事项「${title}」（${code}）` + (partnerId ? `并分派${PARTNER_KIND[kind]}（${partner.name}）跟进` : '，暂待分派协作方'), id, ts)
  if (workOrderId) {
    logToWorkOrder(workOrderId, 'rect', `危机整改事项 ${code}「${title}」建立${partnerId ? `并分派协作方跟进` : '（待分派）'}`, actor.user, actor.role, ts)
  }
  if (partnerId) fire(id, 'assigned', { dispatchSeq: 0, to: partnerId, operator: actor.user })
  return { ok: true, id, code, status }
}

// ===== 分派/改派协作方（ops+；待分派→整改中，整改中可改派，驳回后可改派） =====
export function dispatchRectification(id, body, actor) {
  const rc = q1('SELECT * FROM rectifications WHERE id=?', id)
  if (!rc) return null
  if (TERMINAL_STATUSES.includes(rc.status)) return { error: `整改事项已办结（${RECT_STATUS[rc.status]}），不能再分派` }
  if (rc.status === 'reviewing') return { error: '事项已报送验收，请先由管理员验收或驳回后再改派' }
  const b = body || {}
  const p = q1('SELECT * FROM ext_partners WHERE id=? AND enabled=1', +b.partner_id)
  if (!p) return { error: '请选择有效的协作方（协作方不存在或已停用）' }
  let workOrderId = rc.work_order_id
  if (b.work_order_id) {
    const wo = q1('SELECT id,crisis_id,status FROM work_orders WHERE id=?', +b.work_order_id)
    if (!wo) return { error: '关联跟进工单不存在' }
    if (wo.crisis_id !== rc.crisis_id) return { error: '关联工单不属于该危机事件' }
    if (['done', 'cancelled'].includes(wo.status)) return { error: '关联工单已完结/取消，不能挂接' }
    workOrderId = wo.id
  }
  const dueAt = b.due_at !== undefined
    ? (b.due_at ? Math.max(0, +b.due_at) : null)
    : rc.due_at
  const ts = now()
  const isFirst = !rc.partner_id
  const oldPartner = rc.partner_id ? q1('SELECT name FROM ext_partners WHERE id=?', rc.partner_id) : null
  // 分派轮次以分派日志计数（建档同时分派也记一条 dispatch，首轮通知 seq=0 由建档处发出，此处从 1 起）
  const dispatchSeq = q("SELECT COUNT(*) c FROM rect_logs WHERE rect_id=? AND action='dispatch'", id)[0]?.c ?? 0
  run(`UPDATE rectifications SET partner_id=?, kind=?, work_order_id=?, status='rectifying', due_at=?,
    dispatched_by=?, dispatched_at=?, updated=? WHERE id=?`,
    p.id, p.kind, workOrderId, dueAt, actor.user, ts, ts, id)
  addLog(id, 'dispatch',
    (isFirst
      ? `分派给${PARTNER_KIND[p.kind]}（${p.name}）跟进整改`
      : `改派：${oldPartner ? oldPartner.name : '原协作方'} → ${PARTNER_KIND[p.kind]}（${p.name}）`) +
    (dueAt ? `，整改期限 ${new Date(dueAt).toLocaleString('zh-CN')}` : ''), actor.user, 'internal')
  addRectTimeline(rc.crisis_id, isFirst ? '整改事项分派' : '整改事项改派',
    `整改事项 ${rc.code}「${rc.title}」${isFirst ? '分派给' : '改派至'}${PARTNER_KIND[p.kind]}（${p.name}）跟进` +
    (dueAt ? `，期限 ${new Date(dueAt).toLocaleString('zh-CN')}` : ''), id, ts)
  if (workOrderId) {
    logToWorkOrder(workOrderId, 'rect',
      `整改事项 ${rc.code}${isFirst ? '分派' : '改派'}给${PARTNER_KIND[p.kind]}（${p.name}）跟进`, actor.user, actor.role, ts)
  }
  fire(id, 'assigned', { dispatchSeq: dispatchSeq + 1, to: p.name, operator: actor.user })
  return { ok: true, rectification: getRectification(id) }
}

// 为整改事项拆分/关联跟进工单（ops+）：新建一张同危机的协同工单并挂接，同时回写整改日志与时间线
export function openFollowWorkOrder(id, body, actor, createWo) {
  const rc = q1('SELECT * FROM rectifications WHERE id=?', id)
  if (!rc) return null
  if (TERMINAL_STATUSES.includes(rc.status)) return { error: `整改事项已办结（${RECT_STATUS[rc.status]}），不能再开跟进工单` }
  const b = body || {}
  const title = String(b.title || '').trim() || `整改跟进：${rc.title}`
  const created = createWo({
    crisis_id: rc.crisis_id,
    title,
    detail: String(b.detail || '').trim() || `跟进整改事项 ${rc.code}「${rc.title}」：督促协作方按期报送进度并配合验收。`,
    category: WO_CATEGORY_SAFE(b.category),
    priority: b.priority && RECT_PRIORITY[b.priority] ? b.priority : rc.priority,
    sla_min: Math.max(0, Math.min(10080, +b.sla_min || 0)),
    assignee: String(b.assignee || '').trim(),
    assignee_role: String(b.assignee_role || '').trim()
  }, actor)
  if (created.error) return { error: created.error }
  const ts = now()
  run('UPDATE rectifications SET work_order_id=?, updated=? WHERE id=?', created.id, ts, id)
  addLog(id, 'dispatch', `拆分跟进协同工单 #${created.id}「${title}」`, actor.user, 'internal')
  addRectTimeline(rc.crisis_id, '整改跟进工单',
    `整改事项 ${rc.code}「${rc.title}」拆分跟进协同工单 #${created.id}`, id, ts)
  logWorkOrder(created.id, 'rect', `关联危机整改事项 ${rc.code}「${rc.title}」，作为内部跟进工单`, actor.user, actor.role || 'ops', { time: ts })
  return { ok: true, workOrderId: created.id, rectification: getRectification(id) }
}
function WO_CATEGORY_SAFE(cat) {
  return ['pr', 'legal', 'ops', 'support', 'other'].includes(cat) ? cat : 'other'
}

// ===== 外部协作方报送整改进度（口令鉴权后由路由层传入 partner） =====
// submit_for_review=1：报送并申请验收（整改中/已驳回 → 待验收）；=0：过程进度（保持整改中/已驳回）
// 已驳回状态下报送过程进度即视为重新进入整改中；待分派（未分派给本方）不可报送。
export function submitRectProgress(id, body, partner) {
  const rc = q1('SELECT * FROM rectifications WHERE id=? AND partner_id=?', id, partner.id)
  if (!rc) return null
  if (TERMINAL_STATUSES.includes(rc.status)) return { error: `整改事项已办结（${RECT_STATUS[rc.status]}），不能再报送进度` }
  if (rc.status === 'reviewing') return { error: '事项已报送验收，等待管理员验收结果（可待驳回后补充报送）' }
  const b = body || {}
  const content = String(b.content || '').trim()
  if (!content) return { error: '请填写本期整改进度说明' }
  const submitForReview = b.submit_for_review ? 1 : 0
  let attachments = []
  if (Array.isArray(b.attachments)) {
    attachments = b.attachments.slice(0, 10).map((a) => ({
      name: String(a?.name || '附件').slice(0, 120),
      size: Math.max(0, Math.min(50 * 1024 * 1024, +a?.size || 0)),
      type: String(a?.type || '').slice(0, 80)
    })).filter((a) => a.name)
  }
  const ts = now()
  const contact = String(b.contact_info || partner.contact || '').trim().slice(0, 200)
  const pr = run(`INSERT INTO rect_progress
    (rect_id,partner_id,content,attachments,source_url,contact_info,submit_for_review,submitted_by,created)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    id, partner.id, content, JSON.stringify(attachments), String(b.source_url || '').trim().slice(0, 500),
    contact, submitForReview, contact || partner.contact || partner.name, ts)
  const progressId = Number(pr.lastInsertRowid)
  const progressCount = (rc.progress_count || 0) + 1

  db.exec('BEGIN')
  try {
    if (submitForReview) {
      const round = (rc.review_round || 0) + 1
      run(`UPDATE rectifications SET status='reviewing', progress_count=?, submitted_by=?, submitted_at=?,
        review_round=?, updated=? WHERE id=?`,
        progressCount, contact || partner.contact || partner.name, ts, round, ts, id)
    } else {
      // 过程进度：待分派不可能到这里；已驳回报送进度自动转回整改中
      run(`UPDATE rectifications SET status='rectifying', progress_count=?, updated=? WHERE id=?`,
        progressCount, ts, id)
    }
    addLog(id, submitForReview ? 'submit' : 'progress',
      (submitForReview ? `报送第 ${progressCount} 期进度并申请验收（第 ${(rc.review_round || 0) + 1} 轮）：` : `报送第 ${progressCount} 期整改进度：`) +
      content.slice(0, 160) + (attachments.length ? `（${attachments.length} 个附件）` : ''),
      contact || partner.contact || partner.name, 'external')
    const c = q1('SELECT status FROM crisis WHERE id=?', rc.crisis_id)
    if (c && c.status !== 'closed') {
      if (submitForReview) {
        addRectTimeline(rc.crisis_id, '整改报送验收',
          `${PARTNER_KIND[partner.kind]}（${partner.name}）完成整改事项 ${rc.code}「${rc.title}」第 ${(rc.review_round || 0) + 1} 轮验收报送：${content.slice(0, 100)}`, id, ts)
      } else {
        addRectTimeline(rc.crisis_id, '整改进度',
          `${PARTNER_KIND[partner.kind]}（${partner.name}）报送整改事项 ${rc.code} 第 ${progressCount} 期进度：${content.slice(0, 100)}`, id, ts)
      }
    }
    if (rc.work_order_id) {
      logToWorkOrder(rc.work_order_id, 'rect',
        `整改事项 ${rc.code}：协作方报送第 ${progressCount} 期进度` + (submitForReview ? '并申请验收' : ''), partner.name, '', ts)
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  if (submitForReview) fire(id, 'submitted', { round: (rc.review_round || 0) + 1 })
  else fire(id, 'progress', { progressId, summary: content.slice(0, 80) })
  return { ok: true, progressId, status: submitForReview ? 'reviewing' : 'rectifying', reviewRound: (rc.review_round || 0) + (submitForReview ? 1 : 0) }
}

// ===== 管理员验收通过（待验收 → 已通过；可勾选联动解除该危机全部未解除预警） =====
export function verifyRectification(id, body, actor) {
  const rc = q1('SELECT * FROM rectifications WHERE id=?', id)
  if (!rc) return null
  if (rc.status !== 'reviewing') return { error: `仅待验收的整改事项可验收（当前：${RECT_STATUS[rc.status] || rc.status}）` }
  const b = body || {}
  const note = String(b.note || '').trim()
  const resolveAlerts = b.resolve_alerts ? 1 : 0
  const ts = now()
  let resolved = 0
  const ruleNames = []
  db.exec('BEGIN')
  try {
    const r = run(`UPDATE rectifications SET status='accepted', verified_by=?, verified_at=?, verify_note=?, updated=?
      WHERE id=? AND status='reviewing'`, actor.user, ts, note, ts, id)
    if (!Number(r.changes)) { db.exec('ROLLBACK'); return { error: '整改事项状态已变化，请刷新' } }
    addLog(id, 'verify', `管理员 ${actor.user} 验收通过` + (note ? `：${note}` : '') +
      (resolveAlerts ? '，联动解除该事件全部未解除预警' : ''), actor.user, 'internal')
    if (resolveAlerts) {
      const opens = q("SELECT * FROM alert_events WHERE crisis_id=? AND status='open'", rc.crisis_id)
      for (const ev of opens) {
        run("UPDATE alert_events SET status='resolved', resolved=?, resolve_kind='rect' WHERE id=? AND status='open'", ts, ev.id)
      }
      resolved = opens.length
      for (const rid of [...new Set(opens.map((e) => e.alert_id))]) {
        const al = q1('SELECT title FROM alerts WHERE id=?', rid)
        ruleNames.push(al ? `「${al.title}」` : '已删除规则')
      }
    }
    const c = q1('SELECT status FROM crisis WHERE id=?', rc.crisis_id)
    if (c && c.status !== 'closed') {
      const bits = [`整改事项 ${rc.code}「${rc.title}」验收通过（${rc.progress_count} 期进度，验收人：${actor.user}）`]
      if (note) bits.push(`验收意见：${note}`)
      if (resolved) bits.push(`同步解除 ${resolved} 条未解除预警${ruleNames.length ? '：' + ruleNames.join('、') : ''}`)
      addRectTimeline(rc.crisis_id, '整改验收通过', bits.join('；'), id, ts)
    }
    if (rc.work_order_id) {
      logToWorkOrder(rc.work_order_id, 'rect',
        `整改事项 ${rc.code}「${rc.title}」管理员验收通过，整改闭环` + (resolved ? `，联动解除 ${resolved} 条预警` : ''), actor.user, actor.role, ts)
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
  fire(id, 'accepted', { operator: actor.user })
  return { ok: true, resolved }
}

// ===== 管理员验收驳回（待验收 → 已驳回→整改中；驳回原因门户可见，协作方可补充进度后再次申请） =====
export function rejectRectification(id, body, actor) {
  const rc = q1('SELECT * FROM rectifications WHERE id=?', id)
  if (!rc) return null
  if (rc.status !== 'reviewing') return { error: `仅待验收的整改事项可驳回（当前：${RECT_STATUS[rc.status] || rc.status}）` }
  const reason = String(body?.reason || '').trim()
  if (!reason) return { error: '请填写驳回原因（协作方将在门户看到）' }
  const ts = now()
  const r = run(`UPDATE rectifications SET status='rejected', verify_note=?, rejected_count=rejected_count+1, updated=?
    WHERE id=? AND status='reviewing'`, reason, ts, id)
  if (!Number(r.changes)) return { error: '整改事项状态已变化，请刷新' }
  addLog(id, 'reject', `验收驳回（第 ${rc.review_round || 1} 轮）：${reason}（审核人：${actor.user}），退回协作方继续整改`, actor.user, 'internal')
  const c = q1('SELECT status FROM crisis WHERE id=?', rc.crisis_id)
  if (c && c.status !== 'closed') {
    addRectTimeline(rc.crisis_id, '整改验收驳回',
      `整改事项 ${rc.code}「${rc.title}」第 ${rc.review_round || 1} 轮验收未通过：${reason}，退回协作方继续整改（审核人：${actor.user}）`, id, ts)
  }
  if (rc.work_order_id) {
    logToWorkOrder(rc.work_order_id, 'rect',
      `整改事项 ${rc.code} 第 ${rc.review_round || 1} 轮验收驳回：${reason}，退回继续整改`, actor.user, actor.role, ts)
  }
  fire(id, 'rejected', { round: Math.max(1, rc.review_round || 1), reason })
  return { ok: true }
}

// ===== 取消（ops+；未办结事项可取消，已通过不可取消） =====
export function cancelRectification(id, body, actor) {
  const rc = q1('SELECT * FROM rectifications WHERE id=?', id)
  if (!rc) return null
  if (TERMINAL_STATUSES.includes(rc.status)) return { error: `整改事项已办结（${RECT_STATUS[rc.status]}），不能取消` }
  const reason = String(body?.reason || '').trim()
  const ts = now()
  const r = run(`UPDATE rectifications SET status='cancelled', cancelled_by=?, cancelled_at=?, cancel_reason=?, updated=?
    WHERE id=? AND status NOT IN ('accepted','cancelled')`, actor.user, ts, reason, ts, id)
  if (!Number(r.changes)) return { error: '整改事项状态已变化，请刷新' }
  addLog(id, 'cancel', (reason ? `取消整改事项：${reason}` : '整改事项已取消') + `（操作人：${actor.user}）`, actor.user, 'internal')
  const c = q1('SELECT status FROM crisis WHERE id=?', rc.crisis_id)
  if (c && c.status !== 'closed') {
    addRectTimeline(rc.crisis_id, '整改事项取消',
      `整改事项 ${rc.code}「${rc.title}」已取消${reason ? `：${reason}` : ''}（操作人：${actor.user}），不再阻断结案`, id, ts)
  }
  return { ok: true }
}

// 删除危机时：整改事项保留（跨主体整改留痕不随事件删除），仅解除危机引用；
// 关联通知任务由 notify.deleteNotifyOfCrisis 按统一口径处理（rect 类任务保留、仅解除引用）。
export function detachRectificationsOfCrisis(crisisId) {
  return Number(run('UPDATE rectifications SET crisis_id=NULL WHERE crisis_id=?', crisisId).changes || 0)
}
