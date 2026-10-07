<template>
  <div class="rect">
    <div class="toolbar">
      <button v-if="canOps" class="add" @click="showForm=!showForm">＋ 新建整改事项</button>
      <div class="chips">
        <button class="chip" :class="{on:!statusFilter}" @click="setStatus('')">全部 {{ summary.total || 0 }}</button>
        <button v-for="(txt,k) in dict.status" :key="k" class="chip" :class="[k,{on:statusFilter===k}]" @click="setStatus(k)">
          {{ txt }} {{ summary.counts?.[k] || 0 }}
        </button>
      </div>
      <span class="me">👤 {{ store.user.name }} · {{ roleText(store.user.role) }}</span>
    </div>
    <p class="hint">
      🔗 为未结案危机建立<b>整改事项</b>并分派外部协作方 → 协作方在门户持续报送整改进度 → 值班员<b>分派跟进</b>（可拆分协同工单）
      → 管理员<b>验收通过 / 驳回</b>（驳回退回继续整改）；全程联动<b>通知</b>、<b>工单日志</b>与<b>危机时间线</b>，
      <b>未办结整改事项阻断危机结案</b>。
      <span v-if="summary.overdue" class="overdue-tip">⚠ {{ summary.overdue }} 项已超过整改期限</span>
    </p>

    <!-- 建档表单 -->
    <form v-if="showForm" class="r-form card-box" @submit.prevent="create">
      <h4>＋ 新建危机整改事项</h4>
      <div class="row">
        <select v-model.number="form.crisis_id" required>
          <option :value="null">选择未结案危机事件</option>
          <option v-for="c in openCrises" :key="c.id" :value="c.id">#{{ c.id }} {{ c.title }}（{{ lvText(c.level) }} · {{ stText(c.status) }}）</option>
        </select>
        <select v-model="form.priority">
          <option value="urgent">紧急</option>
          <option value="high">高</option>
          <option value="normal">普通</option>
        </select>
      </div>
      <input v-model="form.title" placeholder="整改要求标题，如 涉事门店整改与第三方检测验收" required />
      <textarea v-model="form.requirement" class="req" placeholder="整改要求/依据：整改项、完成标准、报送要求…（可多行）"></textarea>
      <div class="row">
        <select v-model.number="form.partner_id">
          <option :value="null">暂不分派（建档后由值班员分派）</option>
          <option v-for="p in partners" :key="p.id" :value="p.id" :disabled="!p.enabled">
            {{ kindText(p.kind) }} · {{ p.name }}{{ p.enabled ? '' : '（已停用）' }}
          </option>
        </select>
        <input v-model="form.due" type="datetime-local" title="整改期限（可留空）" />
      </div>
      <div class="row">
        <select v-model.number="form.work_order_id">
          <option :value="null">不关联跟进工单（可后续从事项拆分）</option>
          <option v-for="w in formWorkOrders" :key="w.id" :value="w.id">#{{ w.id }} {{ w.title }}（{{ w.statusText }}）</option>
        </select>
        <select v-model.number="form.source_submission_id">
          <option :value="null">不关联来源外部提交</option>
          <option v-for="s in formSubmissions" :key="s.id" :value="s.id">{{ s.code }} · {{ s.title }}</option>
        </select>
      </div>
      <div class="form-ops">
        <button class="save" type="submit">建立整改事项</button>
        <button type="button" class="ghost" @click="showForm=false">取消</button>
      </div>
    </form>

    <div class="filters">
      <select v-model="kindFilter" @change="reload">
        <option value="">全部协作方类型</option>
        <option value="brand">品牌方</option>
        <option value="regulator">监管方</option>
        <option value="media">媒体</option>
      </select>
      <select v-model.number="crisisFilter" @change="reload">
        <option :value="null">全部危机事件</option>
        <option v-for="c in store.crises" :key="c.id" :value="c.id">#{{ c.id }} {{ c.title }}</option>
      </select>
      <button class="ghost sm" @click="reload">🔄 刷新</button>
    </div>

    <div v-if="!items.length" class="none">暂无整改事项（点击「新建整改事项」为未结案危机分派外部协作方整改）</div>

    <div class="list">
      <div v-for="r in items" :key="r.id" class="r-card" :class="[r.status,{hl:openId===r.id,overdue:r.overdue}]">
        <div class="r-head">
          <span class="code">{{ r.code }}</span>
          <span class="st" :class="r.status">{{ r.statusText }}</span>
          <span class="prio" :class="r.priority">{{ r.priorityText }}</span>
          <span class="kind" :class="r.kind">{{ r.kindText }}</span>
          <span v-if="r.overdue" class="overdue-tag">⏰ 已逾期</span>
          <b class="r-title">{{ r.title }}</b>
          <span class="upd">{{ r.updated }}</span>
        </div>
        <div class="r-meta">
          <span v-if="r.crisis_id" class="crisis-link" @click="gotoCrisis(r)">🛟 危机 #{{ r.crisis_id }} {{ r.crisis_title }} →</span>
          <span v-else class="crisis-detached">关联事件已删除（整改留痕保留）</span>
          <span v-if="r.partner_id">协作方 <i>{{ r.partner_name }}</i></span>
          <span v-else class="no-partner">⚠ 待分派</span>
          <span v-if="r.due_at" class="due">期限 {{ fmtTs(r.due_at) }}</span>
          <span v-if="r.work_order_id" class="wo-link" @click="gotoWorkOrder(r)">📋 跟进工单 #{{ r.work_order_id }} {{ r.wo_title }} →</span>
          <span v-if="r.source_code" class="src-link">↳ 来源 {{ r.source_code }}</span>
          <span class="pstat">已报送 <i>{{ r.progress_count }}</i> 期<template v-if="r.rejected_count"> · 驳回 <i>{{ r.rejected_count }}</i> 次</template><template v-if="r.review_round"> · 当前第 <i>{{ r.review_round }}</i> 轮</template></span>
        </div>
        <pre v-if="r.requirement" class="requirement">{{ r.requirement }}</pre>

        <!-- 验收/驳回结论 -->
        <div v-if="r.status==='accepted'" class="verify-box">
          ✔ 管理员 {{ r.verified_by }} 已验收通过（{{ r.verified_at }}）<template v-if="r.verify_note">：{{ r.verify_note }}</template>
        </div>
        <div v-if="r.status==='rejected'" class="reject-box">
          ↩ 第 {{ r.review_round }} 轮验收驳回（{{ r.verified_by }}）：{{ r.verify_note }} —— 协作方可在门户补充进度后重新申请验收
        </div>

        <!-- 进度报送明细（展开时加载） -->
        <div v-if="openId===r.id" class="r-detail">
          <div v-if="r.progress && r.progress.length" class="prog-list">
            <div v-for="p in r.progress" :key="p.id" class="prog" :class="{review:p.submit_for_review}">
              <span class="p-flag">{{ p.submit_for_review ? '✔ 申请验收' : '📈 过程进度' }}</span>
              <span class="p-content">{{ p.content }}</span>
              <span v-if="p.source_url" class="p-url">🔗 <a :href="p.source_url" target="_blank" rel="noopener">佐证链接</a></span>
              <span v-if="p.attachments && p.attachments.length" class="p-atts">📎 {{ p.attachments.map(a=>a.name).join('、') }}</span>
              <em>{{ p.submitted_by || '—' }} · {{ p.created }}</em>
            </div>
          </div>
          <div v-else class="no-prog">协作方尚未报送进度</div>

          <div class="r-logs">
            <div v-for="l in r.logs" :key="l.id" class="rlog" :class="l.operator_side">
              <span class="rl-side">{{ sideText(l.operator_side) }}</span>
              <b>{{ logText(l.action) }}</b>
              <span>{{ l.detail }}</span>
              <em>{{ l.operator }} · {{ l.time }}</em>
            </div>
          </div>
        </div>

        <div class="r-actions">
          <template v-if="canOps">
            <!-- 分派/改派 -->
            <button v-if="['pending','rectifying','rejected'].includes(r.status)" class="op dispatch" @click="openDispatch(r)">
              📤 {{ r.partner_id ? '改派协作方' : '分派跟进' }}
            </button>
            <!-- 拆分跟进工单 -->
            <button v-if="!r.work_order_id && ['pending','rectifying','reviewing','rejected'].includes(r.status)" class="op wo" @click="openWo(r)">
              📋 拆分跟进工单
            </button>
            <!-- 取消 -->
            <button v-if="['pending','rectifying','reviewing','rejected'].includes(r.status)" class="op cancel" @click="cancel(r)">✕ 取消</button>
          </template>
          <!-- 管理员验收 -->
          <button v-if="r.status==='reviewing' && isAdmin" class="op verify" @click="openVerify(r)">✔ 验收通过</button>
          <button v-if="r.status==='reviewing' && isAdmin" class="op reject" @click="openReject(r)">↩ 驳回</button>
          <button class="op logbtn" @click="toggleLogs(r)">{{ openId===r.id ? '收起明细' : '🧾 进度与留痕' }}</button>
        </div>
      </div>
    </div>

    <!-- 分派弹窗 -->
    <div v-if="dispatchForm" class="modal-mask" @click.self="dispatchForm=null">
      <div class="modal">
        <h4>📤 分派整改跟进 · {{ dispatchForm.code }}</h4>
        <p class="modal-hint">分派后协作方可在「协作门户」页看到该整改事项并按期报送整改进度；改派将通知新协作方。</p>
        <label>整改责任协作方</label>
        <select v-model.number="dispatchPartnerId">
          <option v-for="p in partners" :key="p.id" :value="p.id" :disabled="!p.enabled">
            {{ kindText(p.kind) }} · {{ p.name }}{{ p.enabled ? '' : '（已停用）' }}
          </option>
        </select>
        <label>整改期限（可留空=不限期）</label>
        <input v-model="dispatchDue" type="datetime-local" />
        <div class="modal-ops">
          <button class="save" @click="confirmDispatch">确认分派</button>
          <button class="ghost" @click="dispatchForm=null">取消</button>
        </div>
      </div>
    </div>

    <!-- 跟进工单弹窗 -->
    <div v-if="woForm" class="modal-mask" @click.self="woForm=null">
      <div class="modal">
        <h4>📋 拆分跟进协同工单 · {{ woForm.code }}</h4>
        <p class="modal-hint">新建一张同危机协同工单并挂接该整改事项，内部值班团队按工单督促协作方整改；整改进度与验收结论将回写工单日志。</p>
        <input v-model="woDraft.title" :placeholder="'跟进：' + woForm.title" />
        <div class="row">
          <select v-model="woDraft.category">
            <option value="pr">公关口径</option><option value="legal">法务合规</option>
            <option value="ops">现场运营</option><option value="support">客诉跟进</option><option value="other">其他</option>
          </select>
          <select v-model="woDraft.priority">
            <option value="urgent">紧急</option><option value="high">高</option><option value="normal">普通</option>
          </select>
        </div>
        <div class="row">
          <input v-model="woDraft.assignee" placeholder="指派处理人（留空=待认领）" />
          <select v-model="woDraft.assignee_role">
            <option value="">未指定团队</option><option value="pr">公关</option><option value="legal">法务</option>
            <option value="ops">运营</option><option value="support">客服</option><option value="admin">协调组</option>
          </select>
          <input v-model.number="woDraft.sla_min" type="number" min="0" placeholder="SLA(分钟,0=无)" />
        </div>
        <div class="modal-ops">
          <button class="save" @click="confirmWo">拆分工单</button>
          <button class="ghost" @click="woForm=null">取消</button>
        </div>
      </div>
    </div>

    <!-- 验收弹窗 -->
    <div v-if="verifyForm" class="modal-mask" @click.self="verifyForm=null">
      <div class="modal">
        <h4>✔ 整改验收 · {{ verifyForm.code }}（第 {{ verifyForm.review_round || 1 }} 轮）</h4>
        <p class="modal-hint">验收通过后整改事项闭环，不再阻断危机结案；可勾选联动解除该危机全部未解除预警（解除途径：整改验收）。</p>
        <textarea v-model="verifyNote" placeholder="验收意见（可留空）：整改项完成情况、核验结论…"></textarea>
        <label class="check"><input type="checkbox" v-model="verifyResolve" /> 联动解除该危机下全部未解除预警</label>
        <div class="modal-ops">
          <button class="save" @click="confirmVerify">确认验收通过</button>
          <button class="ghost" @click="verifyForm=null">取消</button>
        </div>
      </div>
    </div>

    <!-- 驳回弹窗 -->
    <div v-if="rejectForm" class="modal-mask" @click.self="rejectForm=null">
      <div class="modal">
        <h4>↩ 验收驳回 · {{ rejectForm.code }}</h4>
        <p class="modal-hint">驳回原因将展示在协作门户，协作方补充整改后可重新报送并申请验收（计入下一轮）。</p>
        <textarea v-model="rejectReason" placeholder="驳回原因（必填）：材料不全 / 整改不达标 / 缺少检测项…"></textarea>
        <div class="modal-ops">
          <button class="save danger" @click="confirmReject">确认驳回</button>
          <button class="ghost" @click="rejectForm=null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { usePubStore } from '@/store/pub'

const store = usePubStore()
const items = ref([])
const summary = ref({ counts: {} })
const dict = ref({ status: {}, priority: {}, kind: {} })
const partners = ref([])
const statusFilter = ref('')
const kindFilter = ref('')
const crisisFilter = ref(store.rectFilterCrisis)
const openId = ref(store.rectOpenId)
const showForm = ref(false)
const canOps = computed(() => ['admin', 'ops'].includes(store.user.role))
const isAdmin = computed(() => store.user.role === 'admin')
const openCrises = computed(() => store.crises.filter((c) => c.status !== 'closed'))

const blankForm = () => ({
  crisis_id: openCrises.value.length === 1 ? openCrises.value[0].id : null,
  title: '', requirement: '', priority: 'high', partner_id: null, due: '',
  work_order_id: null, source_submission_id: null
})
const form = ref(blankForm())
const formWorkOrders = ref([])
const formSubmissions = ref([])

const dispatchForm = ref(null)
const dispatchPartnerId = ref(null)
const dispatchDue = ref('')
const woForm = ref(null)
const woDraft = ref({ title: '', category: 'ops', priority: 'high', assignee: '', assignee_role: 'ops', sla_min: 60 })
const verifyForm = ref(null)
const verifyNote = ref('')
const verifyResolve = ref(false)
const rejectForm = ref(null)
const rejectReason = ref('')

function roleText(r) { return { admin: '管理员', ops: '值班员', viewer: '观察员' }[r] || r }
function kindText(k) { return dict.value.kind[k] || k }
function sideText(s) { return { internal: '内部', external: '协作方', system: '系统' }[s] || s }
function lvText(x) { return { red: '红色', orange: '橙色', yellow: '黄色' }[x] || x }
function stText(x) { return { monitoring: '监测中', disposal: '处置中', closed: '已结案' }[x] || x }
function fmtTs(ms) { return ms ? new Date(ms).toLocaleString('zh-CN') : '—' }
function logText(a) {
  return { create: '建立', dispatch: '分派跟进', progress: '进度报送', submit: '报送验收', verify: '验收通过', reject: '验收驳回', cancel: '取消' }[a] || a
}

async function reload() {
  const d = await store.fetchRectifications({
    status: statusFilter.value, kind: kindFilter.value, crisis_id: crisisFilter.value || ''
  })
  items.value = d.items
  summary.value = d.summary
  dict.value = d.dict
  if (openId.value && !items.value.some((x) => x.id === openId.value)) {
    const full = await store.fetchRectification(openId.value).catch(() => null)
    if (full) items.value.unshift(full)
  }
}
function setStatus(k) { statusFilter.value = k; reload() }
async function loadPartners() { partners.value = await store.fetchExtPartners() }

// 建档表单随选危机刷新可选工单/来源提交
async function refreshFormRefs() {
  formWorkOrders.value = []
  formSubmissions.value = []
  if (!form.value.crisis_id) return
  const [wo, ext] = await Promise.all([
    store.fetchWorkOrders({ crisis_id: form.value.crisis_id }),
    store.fetchExtSubmissions({ crisis_id: form.value.crisis_id })
  ])
  formWorkOrders.value = wo.items.filter((w) => ['todo', 'doing', 'blocked'].includes(w.status))
  formSubmissions.value = ext.items
}
async function create() {
  const due = form.value.due ? new Date(form.value.due).getTime() : null
  await store.createRectification({
    crisis_id: form.value.crisis_id, title: form.value.title, requirement: form.value.requirement,
    priority: form.value.priority, partner_id: form.value.partner_id, due_at: due,
    work_order_id: form.value.work_order_id, source_submission_id: form.value.source_submission_id
  })
  showForm.value = false
  form.value = blankForm()
  reload(); loadPartners()
}

function openDispatch(r) { dispatchForm.value = r; dispatchPartnerId.value = r.partner_id; dispatchDue.value = r.due_at ? toLocalInput(r.due_at) : '' }
async function confirmDispatch() {
  if (!dispatchPartnerId.value) { store.msg('请选择整改责任协作方', 'warn'); return }
  const due = dispatchDue.value ? new Date(dispatchDue.value).getTime() : null
  await store.dispatchRectification(dispatchForm.value.id, { partner_id: dispatchPartnerId.value, due_at: due })
  dispatchForm.value = null
  reload()
}
function openWo(r) {
  woForm.value = r
  woDraft.value = { title: '', category: 'ops', priority: r.priority === 'normal' ? 'normal' : 'high', assignee: '', assignee_role: 'ops', sla_min: 60 }
}
async function confirmWo() {
  await store.openRectWorkOrder(woForm.value.id, { ...woDraft.value })
  woForm.value = null
  reload()
}
function openVerify(r) { verifyForm.value = r; verifyNote.value = ''; verifyResolve.value = false }
async function confirmVerify() {
  await store.verifyRectification(verifyForm.value.id, { note: verifyNote.value, resolve_alerts: verifyResolve.value })
  verifyForm.value = null
  reload()
}
function openReject(r) { rejectForm.value = r; rejectReason.value = '' }
async function confirmReject() {
  if (!rejectReason.value.trim()) { store.msg('请填写驳回原因', 'warn'); return }
  await store.rejectRectification(rejectForm.value.id, rejectReason.value)
  rejectForm.value = null
  reload()
}
async function cancel(r) {
  const reason = window.prompt(`取消整改事项「${r.title}」？取消后不再阻断危机结案。\n取消原因（可留空）：`) || ''
  if (reason === null) return
  await store.cancelRectification(r.id, reason.trim())
  reload()
}
async function toggleLogs(r) {
  if (openId.value === r.id) { openId.value = null; return }
  openId.value = r.id
  if (!r.logs || !r.progress) {
    const full = await store.fetchRectification(r.id)
    const idx = items.value.findIndex((x) => x.id === r.id)
    if (idx >= 0) items.value[idx] = full
  }
}
function gotoCrisis(r) { store.tab = 'crisis' }
function gotoWorkOrder(r) { store.woFilterCrisis = r.crisis_id; store.tab = 'work' }
function toLocalInput(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

let timer = null
onMounted(async () => {
  try {
    await Promise.all([reload(), loadPartners()])
  } catch (e) { store.msg(e.message, 'warn') }
  // 建档表单随选危机联动可选工单/来源提交
  watch(() => form.value.crisis_id, refreshFormRefs)
  if (form.value.crisis_id) refreshFormRefs()
  timer = setInterval(() => { if (document.visibilityState === 'visible') reload().catch(() => {}) }, 8000)
})
onUnmounted(() => { clearInterval(timer); store.rectFilterCrisis = null; store.rectOpenId = null })
</script>

<style scoped>
.rect{display:flex;flex-direction:column;gap:12px;}
.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.add{background:linear-gradient(135deg,#00695c,#2e7d32);color:#fff;border:none;padding:9px 16px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;}
.chips{display:flex;gap:6px;flex-wrap:wrap;}
.chip{background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#aebadd;padding:6px 12px;border-radius:14px;cursor:pointer;font-size:12px;}
.chip.on{background:#2c4a7c;color:#fff;border-color:#5b82c0;}
.chip.pending.on{background:#c62828;border-color:#ef5350;}
.chip.rectifying.on{background:#e65100;border-color:#fb8c00;}
.chip.reviewing.on{background:#6a1b9a;border-color:#8e24aa;}
.chip.accepted.on{background:#1b5e20;border-color:#43a047;}
.chip.rejected.on{background:#4e342e;border-color:#8d6e63;}
.me{margin-left:auto;font-size:12px;color:#8ba2c8;}
.hint{font-size:12px;color:#8ba2c8;line-height:1.7;margin:0;}
.overdue-tip{color:#ef9a9a;font-weight:700;margin-left:8px;}
.card-box{background:#0f1d38;border:1px solid rgba(120,160,220,0.18);border-radius:12px;padding:14px;}
.card-box h4{margin:0 0 10px;font-size:14px;}
.r-form{display:flex;flex-direction:column;gap:8px;}
.r-form select,.r-form input,.r-form textarea{background:#13233f;border:1px solid rgba(120,160,220,0.25);color:#dbe4f3;border-radius:8px;padding:9px 11px;font-size:13px;font-family:inherit;}
.r-form .req{min-height:74px;resize:vertical;}
.row{display:flex;gap:8px;flex-wrap:wrap;}
.row>*{flex:1;min-width:200px;}
.form-ops{display:flex;gap:10px;}
.save{background:#2e7d32;color:#fff;border:none;border-radius:8px;padding:9px 18px;cursor:pointer;font-size:13px;font-weight:600;}
.save.danger{background:#c62828;}
.ghost{background:transparent;border:1px solid rgba(120,160,220,0.35);color:#aebadd;border-radius:8px;padding:9px 14px;cursor:pointer;font-size:13px;}
.filters{display:flex;gap:8px;}
.filters select{background:#13233f;border:1px solid rgba(120,160,220,0.25);color:#dbe4f3;border-radius:7px;padding:7px 10px;font-size:12px;}
.ghost.sm{padding:7px 14px;}
.none{text-align:center;color:#6f84ab;padding:50px 0;}
.list{display:flex;flex-direction:column;gap:10px;}
.r-card{background:#0f1d38;border:1px solid rgba(120,160,220,0.15);border-radius:12px;padding:14px 16px;}
.r-card.hl{outline:2px solid #ffb300;}
.r-card.overdue{border-color:rgba(239,83,80,.5);}
.r-card.reviewing{border-left:4px solid #ab47bc;}
.r-card.accepted{border-left:4px solid #43a047;}
.r-card.rejected{border-left:4px solid #8d6e63;}
.r-card.pending{border-left:4px solid #ef5350;}
.r-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.code{font-family:monospace;background:#0a1224;border:1px solid rgba(120,160,220,0.3);border-radius:5px;padding:2px 8px;font-size:11px;color:#80cbc4;}
.st{font-size:11px;padding:2px 9px;border-radius:10px;font-weight:700;}
.st.pending{background:#5d1a1a;color:#ff8a80;}
.st.rectifying{background:#5d3a10;color:#ffcc80;}
.st.reviewing{background:#3d1a4d;color:#ce93d8;}
.st.accepted{background:#143d1c;color:#a5d6a7;}
.st.rejected{background:#3e2723;color:#bcaaa4;}
.st.cancelled{background:#263238;color:#90a4ae;}
.prio{font-size:10px;padding:2px 8px;border-radius:10px;background:#0d2137;color:#90caf9;}
.prio.urgent{background:#4a1518;color:#ef9a9a;}
.prio.high{background:#3e2f0a;color:#ffe082;}
.kind{font-size:11px;padding:2px 9px;border-radius:10px;font-weight:700;background:#0d3a2c;color:#80cbc4;}
.kind.regulator{background:#3a1f0d;color:#ffb74d;}
.kind.media{background:#1f2a4a;color:#90caf9;}
.overdue-tag{font-size:10px;color:#fff;background:#c62828;border-radius:10px;padding:2px 8px;font-weight:700;}
.r-title{font-size:14px;}
.upd{margin-left:auto;font-size:11px;color:#6f84ab;}
.r-meta{display:flex;gap:14px;flex-wrap:wrap;margin:9px 0;font-size:12px;color:#8ba2c8;}
.r-meta i{color:#dbe4f3;font-style:normal;}
.crisis-link,.wo-link{color:#ffd54f;cursor:pointer;}
.crisis-link:hover,.wo-link:hover{text-decoration:underline;}
.crisis-detached{color:#90a4ae;}
.no-partner{color:#ff8a80;font-weight:600;}
.due{color:#ffb74d;}
.src-link{color:#90caf9;}
.pstat{color:#8ba2c8;}
.requirement{white-space:pre-wrap;font-family:inherit;font-size:12px;line-height:1.7;color:#c6d3ea;margin:4px 0;background:#0c1730;border-radius:8px;padding:9px 12px;}
.verify-box{background:#143d1c55;border:1px solid #43a04780;color:#a5d6a7;border-radius:8px;padding:8px 12px;font-size:12px;margin:6px 0;}
.reject-box{background:#3e272355;border:1px solid #8d6e6380;color:#bcaaa4;border-radius:8px;padding:8px 12px;font-size:12px;margin:6px 0;}
.r-detail{margin-top:8px;border-top:1px dashed rgba(120,160,220,0.18);padding-top:8px;display:flex;flex-direction:column;gap:10px;}
.prog-list{display:flex;flex-direction:column;gap:6px;}
.prog{background:#0c1a30;border:1px solid rgba(120,160,220,0.15);border-radius:8px;padding:8px 10px;font-size:12px;display:flex;flex-direction:column;gap:3px;}
.prog.review{border-color:rgba(171,71,188,.45);}
.p-flag{font-size:10px;font-weight:700;color:#ce93d8;}
.prog:not(.review) .p-flag{color:#90caf9;}
.p-content{color:#dbe4f3;line-height:1.6;white-space:pre-wrap;}
.p-url{font-size:11px;}
.p-url a{color:#90caf9;}
.p-atts{font-size:11px;color:#8ba2c8;}
.prog em{font-size:10px;color:#6f84ab;font-style:normal;}
.no-prog{font-size:12px;color:#6f84ab;text-align:center;padding:8px 0;}
.r-logs{display:flex;flex-direction:column;gap:5px;max-height:230px;overflow-y:auto;}
.rlog{display:flex;gap:10px;align-items:baseline;font-size:12px;flex-wrap:wrap;}
.rl-side{font-size:10px;border-radius:8px;padding:0 7px;font-weight:700;}
.rlog.internal .rl-side{background:#0d2b4d;color:#90caf9;}
.rlog.external .rl-side{background:#3d2a0d;color:#ffb74d;}
.rlog.system .rl-side{background:#263238;color:#b0bec5;}
.rlog b{min-width:56px;color:#dbe4f3;}
.rlog span{color:#aebadd;flex:1;min-width:200px;}
.rlog em{color:#6f84ab;font-style:normal;font-size:11px;}
.r-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;}
.op{border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer;background:transparent;}
.op.dispatch{border:1px solid #26a69a;color:#80cbc4;}
.op.wo{border:1px solid #5b82c0;color:#90caf9;}
.op.verify{border:1px solid #43a047;color:#a5d6a7;font-weight:600;}
.op.reject{border:1px solid #8d6e63;color:#bcaaa4;}
.op.cancel{border:1px solid rgba(239,83,80,.55);color:#ef9a9a;}
.logbtn{border:1px solid rgba(120,160,220,0.35);color:#aebadd;}
.modal-mask{position:fixed;inset:0;background:rgba(4,10,22,.72);z-index:60;display:flex;align-items:center;justify-content:center;padding:20px;}
.modal{background:#0f1d38;border:1px solid rgba(120,160,220,0.3);border-radius:14px;padding:20px;width:560px;max-width:100%;display:flex;flex-direction:column;gap:10px;}
.modal h4{margin:0;font-size:15px;}
.modal-hint{margin:0;font-size:12px;color:#8ba2c8;line-height:1.6;}
.modal label{font-size:12px;color:#aebadd;}
.modal input,.modal select,.modal textarea{background:#13233f;border:1px solid rgba(120,160,220,0.25);color:#dbe4f3;border-radius:8px;padding:9px 11px;font-size:13px;font-family:inherit;}
.modal textarea{min-height:90px;resize:vertical;}
.modal .row{display:flex;gap:8px;flex-wrap:wrap;}
.modal .row>*{flex:1;min-width:140px;}
.check{display:flex;align-items:center;gap:8px;}
.modal-ops{display:flex;gap:10px;justify-content:flex-end;}
</style>
