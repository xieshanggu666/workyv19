<template>
  <div class="rect">
    <div class="toolbar">
      <button v-if="isAdmin" class="add" @click="showForm=!showForm">＋ 新增整改事项</button>
      <span class="loop-hint">🔗 管理员建档 → 值班员分派跟进（可催办）→ 外部协作方门户提交整改进度/报验 → 管理员验收通过/驳回；联动通知、工单日志、危机时间线与复盘快照，未验收通过的整改事项阻塞危机结案</span>
    </div>

    <!-- 汇总 -->
    <div class="sum">
      <div class="sc todo"><b>{{ summary.todo || 0 }}</b><em>待分派</em></div>
      <div class="sc progress"><b>{{ summary.progress || 0 }}</b><em>整改中</em></div>
      <div class="sc review"><b>{{ summary.review || 0 }}</b><em>待验收</em></div>
      <div class="sc rejected"><b>{{ summary.rejected || 0 }}</b><em>已驳回</em></div>
      <div class="sc accepted"><b>{{ summary.accepted || 0 }}</b><em>已验收</em></div>
      <div class="sc urgent"><b>{{ summary.urgentOpen || 0 }}</b><em>紧急在办</em></div>
    </div>

    <!-- 过滤 -->
    <div class="filters">
      <select v-model="f.status" @change="reload">
        <option value="">全部状态</option>
        <option v-for="(t,k) in dict.status" :key="k" :value="k">{{ t }}</option>
      </select>
      <select v-model.number="f.crisis_id" @change="reload">
        <option :value="null">全部危机</option>
        <option v-for="c in crises" :key="c.id" :value="c.id">#{{ c.id }} {{ c.title }}</option>
      </select>
      <button class="ghost" @click="f.status='';f.crisis_id=null;reload">重置</button>
      <span v-if="f.crisis_id" class="jump-crisis" @click="store.tab='crisis'">查看危机卡片 →</span>
    </div>

    <!-- 新建表单 -->
    <form v-if="showForm" class="r-form" @submit.prevent="create">
      <div class="row">
        <select v-model.number="form.crisis_id" required>
          <option :value="null" disabled>选择危机事件（仅未结案）</option>
          <option v-for="c in options.crises" :key="c.id" :value="c.id">#{{ c.id }} {{ c.title }}</option>
        </select>
        <select v-model="form.priority">
          <option value="urgent">紧急</option>
          <option value="high">高</option>
          <option value="normal">普通</option>
        </select>
        <input v-model="form.due_at" placeholder="整改期限，如 2026-10-10 18:00" style="max-width:220px" />
      </div>
      <input v-model="form.title" placeholder="整改事项标题，如 全国门店食安专项自查与再培训" required />
      <textarea v-model="form.requirement" placeholder="整改要求 / 验收标准（每行一项）" required></textarea>
      <div class="row">
        <select v-model.number="form.partner_id">
          <option :value="null">暂不指派（待值班员分派跟进）</option>
          <option v-for="p in options.partners" :key="p.id" :value="p.id">{{ kindText(p.kind) }} · {{ p.name }}</option>
        </select>
        <select v-model.number="form.work_order_id">
          <option :value="null">不关联处置工单（可选）</option>
          <option v-for="w in woOptions" :key="w.id" :value="w.id">#{{ w.id }} {{ w.title }}</option>
        </select>
      </div>
      <details class="src-sub">
        <summary>来源外部提交（可选，将记录转化来源）</summary>
        <select v-model.number="form.source_submission_id">
          <option :value="null">无</option>
          <option v-for="s in sourceOptions" :key="s.id" :value="s.id">{{ s.code }} · {{ s.title }}</option>
        </select>
      </details>      <div class="row">
        <button class="save" type="submit">创建</button>
        <button type="button" class="ghost" @click="showForm=false">取消</button>
      </div>
    </form>

    <div v-if="!items.length" class="none">暂无整改事项</div>
    <div class="list">
      <div v-for="r in items" :key="r.id" class="r-card" :class="[r.status,{urgent:r.priority==='urgent' && openStatus.includes(r.status)}]">
        <div class="r-head">
          <span class="code">{{ r.code }}</span>
          <span class="st" :class="r.status">{{ r.statusText }}</span>
          <span v-if="r.priority==='urgent'" class="pr">⚡ 紧急</span>
          <b class="r-title">{{ r.title }}</b>
          <span class="upd">{{ r.updated }}</span>
        </div>
        <div class="r-meta">
          <span>事件 <i>#{{ r.crisis_id }} {{ r.crisis_title }}</i></span>
          <span v-if="r.partner_id">协作方 <i :class="r.partner_kind">{{ r.partner_kindText }} · {{ r.partner_name }}</i></span>
          <span v-else class="no-partner">尚未指派协作方</span>
          <span v-if="r.follower">跟进人 <i>{{ r.follower }}</i></span>
          <span v-if="r.due_at">期限 <i>{{ r.due_at }}</i></span>
          <span v-if="r.wo_title">关联工单 <i>#{{ r.work_order_id }} {{ r.wo_title }}</i></span>
        </div>
        <pre class="req">{{ r.requirement }}</pre>
        <div v-if="r.latest_progress" class="latest" :class="r.latest_progress.operator_side">
          <span class="ltag">{{ sideText(r.latest_progress.operator_side) }} · {{ actionText(r.latest_progress.action) }}</span>
          <i>{{ r.latest_progress.content.slice(0, 140) }}{{ r.latest_progress.content.length > 140 ? '…' : '' }}</i>
          <em>{{ r.latest_progress.operator }} · {{ r.latest_progress.time }}</em>
        </div>
        <div v-if="r.status==='rejected'" class="reject-box">↩ 验收驳回：{{ r.reject_reason }}（{{ r.rejected_by }}）——协作方补充进度后可重新报验</div>

        <div class="r-actions">
          <button class="op detail" @click="openDetail(r)">🧾 详情与留痕（{{ r.progress_count }}）</button>
          <template v-if="!['accepted','cancelled'].includes(r.status)">
            <button v-if="isOps && r.partner_id" class="op remind" @click="remind(r)">🔔 催办</button>
            <button v-if="isOps" class="op assign" @click="openAssign(r)">{{ r.partner_id ? '↪ 改派/换跟进人' : '📨 分派跟进' }}</button>
            <button v-if="isAdmin && r.status==='review'" class="op accept" @click="accept(r)">✔ 验收通过</button>
            <button v-if="isAdmin && ['progress','review','rejected'].includes(r.status)" class="op reject" @click="reject(r)">✕ 验收驳回</button>
            <button v-if="isAdmin && r.status!=='review'" class="op accept" @click="accept(r)">✔ 直接验收通过</button>
            <button v-if="isAdmin" class="op cancel" @click="cancel(r)">取消事项</button>
          </template>
        </div>
      </div>
    </div>

    <!-- 分派弹窗 -->
    <div v-if="assignOpen" class="modal-mask" @click.self="assignOpen=false">
      <div class="modal">
        <h3>分派整改跟进 · {{ assignTarget.code }}</h3>
        <p class="m-title">{{ assignTarget.title }}</p>
        <label>负责落实的外部协作方</label>
        <select v-model.number="assignForm.partner_id">
          <option v-for="p in options.partners" :key="p.id" :value="p.id">{{ kindText(p.kind) }} · {{ p.name }}</option>
        </select>
        <label>内部跟进人（值班员）</label>
        <input v-model="assignForm.follower" placeholder="如 李澈" />
        <label>分派说明（可留空）</label>
        <textarea v-model="assignForm.note" placeholder="分派时同步给协作方的说明/重点"></textarea>
        <div class="m-actions">
          <button class="save" @click="doAssign">确认分派</button>
          <button class="ghost" @click="assignOpen=false">取消</button>
        </div>
      </div>
    </div>

    <!-- 详情抽屉 -->
    <div v-if="detail" class="drawer-mask" @click.self="detail=null">
      <div class="drawer">
        <div class="d-head">
          <div>
            <span class="code">{{ detail.code }}</span>
            <span class="st" :class="detail.status">{{ detail.statusText }}</span>
            <b>{{ detail.title }}</b>
          </div>
          <button class="x" @click="detail=null">✕</button>
        </div>
        <div class="d-meta">
          <div>危机：#{{ detail.crisis_id }} {{ detail.crisis_title }}</div>
          <div>协作方：{{ detail.partner_id ? `${detail.partner_kindText} · ${detail.partner_name}` : '未指派' }}</div>
          <div>跟进人：{{ detail.follower || '—' }}（{{ detail.follower_role || '—' }}）</div>
          <div>期限：{{ detail.due_at || '—' }} · 优先级：{{ detail.priorityText }}</div>
          <div v-if="detail.wo_title">关联工单：#{{ detail.work_order_id }} {{ detail.wo_title }}</div>
          <div v-if="detail.source_submission_code">来源外部提交：{{ detail.source_submission_code }}</div>
          <div v-if="detail.accepted_at">验收：{{ detail.accepted_by }} · {{ detail.accepted_at }}<template v-if="detail.accepted_note"> · {{ detail.accepted_note }}</template></div>
        </div>
        <h6>整改要求 / 验收标准</h6>
        <pre class="d-req">{{ detail.requirement }}</pre>
        <h6>进度与全程留痕（{{ detail.progress.length }}）</h6>
        <div class="logs">
          <div v-for="p in [...detail.progress].reverse()" :key="p.id" class="log" :class="p.operator_side">
            <span class="lg-side">{{ sideText(p.operator_side) }}</span>
            <b>{{ actionText(p.action) }}<i v-if="p.is_urgent" class="urg"> ⚡紧急</i></b>
            <span class="lg-content">{{ p.content }}</span>
            <div v-if="p.attachments && p.attachments.length" class="lg-atts">
              📎 <span v-for="(a,i) in p.attachments" :key="i" class="att">{{ a.name }}<i v-if="a.size">（{{ fmtSize(a.size) }}）</i></span>
            </div>
            <a v-if="p.source_url" :href="p.source_url" target="_blank" rel="noopener" class="lg-url">🔗 佐证链接</a>
            <em>{{ p.operator }} · {{ p.time }}</em>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { usePubStore } from '@/store/pub'
const store = usePubStore()
const isOps = computed(() => ['admin', 'ops'].includes(store.user.role))
const isAdmin = computed(() => store.user.role === 'admin')
const openStatus = ['todo', 'progress', 'review', 'rejected']

const items = ref([])
const summary = ref({})
const dict = ref({ status: {}, priority: {} })
const crises = ref([])
const options = reactive({ partners: [], crises: [], workOrders: [], submissions: [] })
const showForm = ref(false)
const f = reactive({ status: '', crisis_id: store.rectFilterCrisis || null })
const blankForm = () => ({ crisis_id: null, title: '', requirement: '', due_at: '', priority: 'normal', partner_id: null, work_order_id: null, source_submission_id: null })
const form = ref(blankForm())
const detail = ref(null)
const assignOpen = ref(false)
const assignTarget = ref(null)
const assignForm = reactive({ partner_id: null, follower: '', note: '' })

const woOptions = computed(() =>
  form.value.crisis_id ? options.workOrders.filter((w) => w.crisis_id === form.value.crisis_id) : [])
const sourceOptions = computed(() =>
  form.value.crisis_id ? (options.submissions || []).filter((s) => !s.crisis_id || s.crisis_id === form.value.crisis_id) : [])

function kindText(k) { return { brand: '🏢 品牌方', regulator: '⚖️ 监管方', media: '📰 媒体' }[k] || k }
function sideText(s) { return { internal: '内部', external: '协作方', system: '系统' }[s] || s }
function actionText(a) {
  return { create: '新建', assign: '分派跟进', progress: '提交进度', submit: '提交报验', review: '报验登记', remind: '催办', accept: '验收通过', reject: '验收驳回', cancel: '取消' }[a] || a
}
function fmtSize(n) {
  if (!n) return ''
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB'
  return Math.max(1, Math.round(n / 1024)) + 'KB'
}

async function reload() {
  const d = await store.fetchRects({ status: f.status, crisis_id: f.crisis_id || undefined })
  items.value = d.items
  summary.value = d.summary
  dict.value = d.dict
  crises.value = store.crises
  store.rectFilterCrisis = null
}
onMounted(async () => {
  await reload()
  const op = await store.fetchRectOptions()
  options.partners = op.partners
  options.crises = op.crises
  options.workOrders = op.workOrders
  options.submissions = op.submissions
  if (store.rectOpenId) openDetailById(store.rectOpenId)
})

async function create() {
  await store.createRect({ ...form.value })
  showForm.value = false
  form.value = blankForm()
  reload()
}
async function openDetail(r) {
  store.rectOpenId = r.id
  await openDetailById(r.id)
}
async function openDetailById(id) {
  try { detail.value = await store.fetchRect(id) } catch (e) { store.msg(e.message, 'warn') }
}
function openAssign(r) {
  assignTarget.value = r
  assignForm.partner_id = r.partner_id || options.partners[0]?.id || null
  assignForm.follower = r.follower || store.user.name
  assignForm.note = ''
  assignOpen.value = true
}
async function doAssign() {
  await store.assignRect(assignTarget.value.id, { ...assignForm })
  assignOpen.value = false
  reload()
  if (detail.value && detail.value.id === assignTarget.value.id) detail.value = await store.fetchRect(detail.value.id)
}
async function remind(r) {
  const content = window.prompt('催办内容（将通知协作方）：', '请加快整改进度并按时提交报验。')
  if (content && content.trim()) {
    await store.remindRect(r.id, content.trim())
    if (detail.value?.id === r.id) detail.value = await store.fetchRect(r.id)
    reload()
  }
}
async function accept(r) {
  const note = window.prompt('验收意见（可留空）：', '整改到位，材料齐全，同意验收通过。')
  if (note === null) return
  const resolve = confirm('是否同时联动解除该危机下全部未解除预警？（确定=解除，取消=不解除）')
  try {
    await store.acceptRect(r.id, { note: note.trim(), resolve_alerts: resolve })
    reload()
    if (detail.value?.id === r.id) detail.value = await store.fetchRect(r.id)
  } catch (e) { store.msg(e.message, 'warn') }
}
async function reject(r) {
  const reason = window.prompt('驳回原因（协作方门户可见）：')
  if (!reason || !reason.trim()) return
  try {
    await store.rejectRect(r.id, reason.trim())
    reload()
    if (detail.value?.id === r.id) detail.value = await store.fetchRect(r.id)
  } catch (e) { store.msg(e.message, 'warn') }
}
async function cancel(r) {
  if (!confirm(`确定取消整改事项「${r.title}」？`)) return
  const reason = window.prompt('取消原因（可留空）：') || ''
  await store.cancelRect(r.id, reason.trim())
  reload()
}
</script>

<style scoped>
.rect{display:flex;flex-direction:column;gap:12px;}
.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.add{font-family:inherit;background:linear-gradient(135deg,#00897b,#00695c);border:none;color:#fff;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;}
.loop-hint{font-size:11px;color:#5b6f94;flex:1;min-width:260px;line-height:1.6;}
.sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;}
.sc{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:10px;padding:10px;text-align:center;display:flex;flex-direction:column;gap:2px;}
.sc b{font-size:20px;color:#fff;}
.sc em{font-style:normal;font-size:11px;color:#8ba2c8;}
.sc.todo b{color:#b0bec5;}.sc.progress b{color:#90caf9;}.sc.review b{color:#ffcc80;}.sc.rejected b{color:#ce93d8;}.sc.accepted b{color:#a5d6a7;}.sc.urgent b{color:#ef9a9a;}
.filters{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.filters select{background:#13233f;border:1px solid rgba(120,160,220,0.25);color:#dbe4f3;border-radius:8px;padding:7px 10px;font-size:12px;font-family:inherit;}
.ghost{background:#16263f;border:1px solid rgba(120,160,220,0.3);color:#aebadd;border-radius:8px;padding:7px 13px;font-size:12px;cursor:pointer;}
.jump-crisis{font-size:12px;color:#80cbc4;cursor:pointer;text-decoration:underline;}
.r-form{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:8px;}
.row{display:flex;gap:8px;flex-wrap:wrap;}
.row>*{flex:1;min-width:200px;}
.r-form input,.r-form select,.r-form textarea,.modal input,.modal select,.modal textarea{background:#13233f;border:1px solid rgba(120,160,220,0.25);color:#dbe4f3;border-radius:8px;padding:9px 11px;font-size:13px;font-family:inherit;}
.r-form textarea{min-height:70px;resize:vertical;}
.src-sub summary{font-size:12px;color:#8ba2c8;cursor:pointer;}
.src-sub select{width:100%;margin-top:6px;}
.save{background:#00796b;border:none;color:#fff;font-weight:600;cursor:pointer;border-radius:8px;padding:9px 20px;font-size:13px;}
.none{color:#5b6f94;text-align:center;padding:40px;}
.list{display:flex;flex-direction:column;gap:10px;}
.r-card{background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:13px 15px;border-left:4px solid #546e7a;}
.r-card.urgent{border-left-color:#ef5350;}
.r-card.review{border-left-color:#ffa726;}
.r-card.accepted{border-left-color:#66bb6a;}
.r-card.rejected{border-left-color:#ab47bc;}
.r-card.todo{border-left-color:#78909c;}
.r-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}
.code{font-family:monospace;background:#0a1224;border:1px solid rgba(120,160,220,0.3);border-radius:5px;padding:2px 8px;font-size:11px;color:#80cbc4;}
.st{font-size:11px;padding:2px 9px;border-radius:10px;font-weight:700;}
.st.todo{background:#37474f;color:#cfd8dc;}
.st.progress{background:#0d2b4d;color:#90caf9;}
.st.review{background:#5d3a10;color:#ffcc80;}
.st.rejected{background:#3d1a4d;color:#ce93d8;}
.st.accepted{background:#143d1c;color:#a5d6a7;}
.st.cancelled{background:#263238;color:#90a4ae;}
.pr{font-size:10px;color:#fff;background:#c62828;border-radius:9px;padding:2px 8px;font-weight:700;}
.r-title{font-size:14px;}
.upd{margin-left:auto;font-size:11px;color:#5b6f94;}
.r-meta{display:flex;gap:14px;flex-wrap:wrap;margin:8px 0;font-size:11px;color:#8ba2c8;}
.r-meta i{color:#dbe4f3;font-style:normal;}
.r-meta i.brand{color:#80cbc4;}.r-meta i.regulator{color:#ffb74d;}.r-meta i.media{color:#90caf9;}
.no-partner{color:#ffb74d;}
.req{white-space:pre-wrap;margin:0 0 8px;background:#0c1730;border-radius:8px;padding:9px 11px;font-family:inherit;font-size:12px;line-height:1.6;color:#aebadd;}
.latest{display:flex;flex-direction:column;gap:2px;background:#0c2233;border:1px solid rgba(38,166,154,.25);border-radius:8px;padding:7px 11px;font-size:12px;margin-bottom:8px;}
.latest.external{background:#10233b;border-color:rgba(144,202,249,.3);}
.latest .ltag{font-size:10px;color:#80cbc4;font-weight:700;}
.latest i{font-style:normal;color:#c6d3ea;}
.latest em{font-style:normal;font-size:10px;color:#6f84ab;}
.reject-box{background:#3d1a4d33;border:1px solid #8e24aa80;color:#ce93d8;border-radius:8px;padding:7px 11px;font-size:12px;margin-bottom:8px;}
.r-actions{display:flex;gap:7px;flex-wrap:wrap;}
.op{border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer;background:transparent;}
.op.detail{border:1px solid rgba(120,160,220,0.35);color:#aebadd;}
.op.assign{border:1px solid #26a69a;color:#80cbc4;}
.op.remind{border:1px solid #fb8c00;color:#ffcc80;}
.op.accept{border:1px solid #43a047;color:#a5d6a7;}
.op.reject{border:1px solid #ab47bc;color:#ce93d8;}
.op.cancel{border:1px solid rgba(239,83,80,.55);color:#ef9a9a;}
/* 弹窗 */
.modal-mask{position:fixed;inset:0;background:rgba(5,10,22,.65);display:grid;place-items:center;z-index:60;}
.modal{width:480px;max-width:94vw;background:#0f1d38;border:1px solid rgba(120,160,220,0.3);border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:9px;}
.modal h3{margin:0;font-size:15px;}
.m-title{font-size:12px;color:#aebadd;margin:0;}
.modal label{font-size:11px;color:#8ba2c8;}
.modal textarea{min-height:64px;}
.m-actions{display:flex;gap:8px;justify-content:flex-end;}
/* 抽屉 */
.drawer-mask{position:fixed;inset:0;background:rgba(5,10,22,.6);z-index:55;display:flex;justify-content:flex-end;}
.drawer{width:580px;max-width:96vw;height:100%;background:#0c1a30;border-left:1px solid rgba(120,160,220,0.3);padding:18px 20px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;}
.d-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}
.d-head b{font-size:14px;margin-left:8px;}
.x{background:none;border:none;color:#ef9a9a;font-size:16px;cursor:pointer;}
.d-meta{display:flex;flex-direction:column;gap:3px;font-size:12px;color:#8ba2c8;background:#0f1d38;border-radius:9px;padding:10px 12px;}
.drawer h6{margin:6px 0 0;font-size:12px;color:#ffd54f;}
.d-req{white-space:pre-wrap;margin:0;background:#0a1428;border-radius:8px;padding:10px;font-family:inherit;font-size:12px;line-height:1.7;color:#c6d3ea;}
.logs{display:flex;flex-direction:column;gap:7px;}
.log{background:#0f1d38;border-radius:9px;padding:9px 12px;display:flex;flex-direction:column;gap:3px;font-size:12px;border-left:3px solid #546e7a;}
.log.external{border-left-color:#26a69a;}
.log.internal{border-left-color:#42a5f5;}
.log.system{border-left-color:#78909c;}
.lg-side{font-size:10px;border-radius:8px;padding:0 7px;font-weight:700;align-self:flex-start;background:#0a1428;color:#8ba2c8;}
.log b{color:#dbe4f3;}
.log b .urg{color:#ef9a9a;font-style:normal;}
.lg-content{color:#aebadd;white-space:pre-wrap;}
.lg-atts{display:flex;gap:7px;flex-wrap:wrap;color:#8ba2c8;}
.lg-atts .att{background:#0a1428;border-radius:6px;padding:2px 8px;}
.lg-atts i{color:#6f84ab;font-style:normal;margin-left:3px;}
.lg-url{font-size:11px;color:#90caf9;text-decoration:none;}
.log em{font-style:normal;font-size:10px;color:#6f84ab;}
</style>
