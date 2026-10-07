<template>
  <div class="portal">
    <!-- 身份选择（演示：凭门户口令进入；正式环境由独立账号体系承接） -->
    <div v-if="!partner" class="gate">
      <div class="gate-card">
        <div class="gate-logo">📮</div>
        <h2>舆舟 · 外部协作反馈门户</h2>
        <p class="gate-desc">品牌方、监管方、媒体可在此提交<b>证据材料</b>与<b>整改进度</b>，材料经内部审核后将回写处置工单与危机时间线；紧急事项将立即联动内部升级。</p>
        <div class="quick">
          <span class="q-lbl">演示身份（点击快捷进入）：</span>
          <button v-for="c in quick" :key="c.code" class="q-btn" :class="c.kind" @click="login(c.code)">
            <i>{{ kindIcon(c.kind) }}</i>
            <b>{{ c.label }}</b>
            <code>{{ c.code }}</code>
          </button>
        </div>
        <form class="code-form" @submit.prevent="login(inputCode)">
          <input v-model="inputCode" placeholder="或输入协作方专属口令（ACCESS CODE）" required />
          <button class="enter" type="submit">进入门户 →</button>
        </form>
        <p v-if="loginError" class="err">⚠ {{ loginError }}</p>
        <p class="gate-foot">🔒 您只能查看本机构提交的内容；提交后可补充材料或在审核采纳前撤回。</p>
      </div>
    </div>

    <template v-else>
      <div class="toolbar">
        <div class="who">
          <span class="p-kind" :class="partner.kind">{{ kindIcon(partner.kind) }} {{ partner.kindText }}</span>
          <b>{{ partner.name }}</b>
          <span class="p-contact" v-if="partner.contact">联系人：{{ partner.contact }}</span>
        </div>
        <button class="add" @click="showForm=!showForm">＋ 提交证据/整改进度</button>
        <button class="ghost" @click="logout">退出门户</button>
      </div>

      <p class="hint">📌 提交后状态流转：<b>待审核 → 受理中 → 已采纳 / 已驳回</b>；已采纳材料将并入危机处置档案，可在下方查看内部审核意见；被驳回时可补充材料后重新提交。</p>

      <!-- ===== 分派给本协作方的危机整改事项（报送整改进度 / 申请验收） ===== -->
      <section v-if="rects.length" class="rect-block">
        <h3>🧹 分派给本机构的危机整改事项
          <span class="rect-brief">
            <i v-if="rectBrief.rectifying" class="b-wait">整改中 {{ rectBrief.rectifying }}</i>
            <i v-if="rectBrief.reviewing" class="b-rev">待验收 {{ rectBrief.reviewing }}</i>
            <i v-if="rectBrief.accepted" class="b-ok">已通过 {{ rectBrief.accepted }}</i>
          </span>
        </h3>
        <p class="rect-hint">按整改要求持续报送进度；全部完成后<b>申请验收</b>，由内部管理员验收通过或驳回（驳回原因在此可见，可补充进度后再次申请）。整改进度将同步内部跟进工单与危机时间线。</p>
        <div class="rect-list">
          <div v-for="r in rects" :key="r.id" class="rect-card" :class="[r.status,{overdue:r.overdue}]">
            <div class="rc-head">
              <span class="code">{{ r.code }}</span>
              <span class="rc-st" :class="r.status">{{ r.statusText }}</span>
              <span class="rc-prio" :class="r.priority">{{ prioText(r.priority) }}</span>
              <span v-if="r.overdue" class="rc-overdue">⏰ 已超过整改期限</span>
              <b class="rc-title">{{ r.title }}</b>
            </div>
            <div class="rc-meta">
              <span v-if="r.crisis_id">关联事件 <i>#{{ r.crisis_id }} {{ r.crisis_title }}</i></span>
              <span v-else class="rc-detached">关联事件已删除（整改留痕保留）</span>
              <span v-if="r.due_at" class="due">整改期限 {{ fmtTs(r.due_at) }}</span>
              <span>已报送 <i>{{ r.progress_count }}</i> 期<template v-if="r.rejected_count"> · 被驳回 <i>{{ r.rejected_count }}</i> 次</template></span>
            </div>
            <pre v-if="r.requirement" class="rc-req">{{ r.requirement }}</pre>

            <!-- 最近驳回原因 -->
            <div v-if="r.status==='rejected'" class="rc-reject">↩ 第 {{ r.review_round }} 轮验收未通过：{{ r.verify_note }}（{{ r.verified_by }}）——请补充整改后重新报送并申请验收</div>
            <div v-else-if="r.status==='reviewing'" class="rc-reviewing">⏳ 第 {{ r.review_round }} 轮验收申请已提交，等待内部管理员验收</div>
            <div v-else-if="r.status==='accepted'" class="rc-accepted">✔ 已验收通过（{{ r.verified_by }} · {{ r.verified_at }}）<template v-if="r.verify_note">：{{ r.verify_note }}</template></div>
            <div v-else-if="r.status==='cancelled'" class="rc-cancelled">✕ 该整改事项已被内部取消<template v-if="r.cancel_reason">：{{ r.cancel_reason }}</template></div>

            <!-- 进度列表（展开） -->
            <template v-if="openRect===r.id">
              <div v-if="r.progress && r.progress.length" class="rc-progs">
                <div v-for="p in r.progress" :key="p.id" class="rc-prog" :class="{review:p.submit_for_review}">
                  <span class="rp-flag">{{ p.submit_for_review ? '✔ 申请验收' : '📈 过程进度' }}</span>
                  <span class="rp-content">{{ p.content }}</span>
                  <span v-if="p.attachments && p.attachments.length" class="rp-atts">
                    📎 <span v-for="(a,i) in p.attachments" :key="i" class="rp-att">{{ a.name }}<i v-if="a.size">（{{ fmtSize(a.size) }}）</i></span>
                  </span>
                  <a v-if="p.source_url" :href="p.source_url" target="_blank" rel="noopener" class="rp-url">🔗 佐证链接</a>
                  <em>{{ p.submitted_by || '—' }} · {{ p.created }}</em>
                </div>
              </div>
              <div v-else class="rc-none">尚未报送进度，请按整改要求完成后报送第一期进展。</div>
              <div class="rc-logs">
                <div v-for="l in r.logs" :key="l.id" class="rclog" :class="l.operator_side">
                  <span>{{ rectLogText(l.action) }}</span><i>{{ l.detail }}</i><em>{{ l.operator }} · {{ l.time }}</em>
                </div>
              </div>
            </template>

            <!-- 外部操作：整改中/已驳回可报送；待验收/终态仅可查看 -->
            <div class="rc-actions">
              <button v-if="['rectifying','rejected'].includes(r.status)" class="rc-op progress" @click="openProgress(r,false)">📈 报送进度</button>
              <button v-if="['rectifying','rejected'].includes(r.status)" class="rc-op review" @click="openProgress(r,true)">✔ 完成整改·申请验收</button>
              <button class="rc-op logbtn" @click="toggleRect(r)">{{ openRect===r.id ? '收起明细' : '🧾 进度与留痕' }}</button>
            </div>
          </div>
        </div>
      </section>

      <!-- 报送进度/申请验收弹窗 -->
      <div v-if="progressForm" class="modal-mask" @click.self="progressForm=null">
        <div class="modal">
          <h4>{{ progressForReview ? '✔ 报送并申请验收' : '📈 报送整改进度' }} · {{ progressForm.code }}</h4>
          <p class="modal-hint">{{ progressForm.title }}<template v-if="progressForReview">；提交后事项进入「待验收」，等待内部管理员验收，期间不可再补充报送（驳回后可继续）。</template></p>
          <textarea v-model="progressDraft.content" :placeholder="progressForReview ? '请说明全部整改项的完成情况、核验结论与公示情况…' : '本期整改进展、已完成措施、下期计划…'" required></textarea>
          <input v-model="progressDraft.source_url" placeholder="佐证链接（整改公示页/检测报告页，可留空）" />
          <input v-model="progressDraft.contact_info" placeholder="本次对接联系方式（可留空）" />
          <div class="atts-edit">
            <span class="lbl">📎 附件清单（演示登记文件信息，不上传实体文件）</span>
            <div v-for="(a,i) in progressDraft.attachments" :key="i" class="att-row">
              <input v-model="a.name" placeholder="文件名，如 检测报告.pdf" />
              <input v-model.number="a.size" type="number" min="0" placeholder="大小(字节)" style="max-width:120px" />
              <input v-model="a.type" placeholder="类型，如 application/pdf" style="max-width:200px" />
              <button type="button" class="del-att" @click="progressDraft.attachments.splice(i,1)">✕</button>
            </div>
            <button type="button" class="add-att" @click="progressDraft.attachments.push({name:'',size:0,type:''})">＋ 添加附件</button>
          </div>
          <div class="modal-ops">
            <button class="save" @click="submitProgressFn">{{ progressForReview ? '确认申请验收' : '报送进度' }}</button>
            <button class="ghost" @click="progressForm=null">取消</button>
          </div>
        </div>
      </div>

      <!-- 提交表单 -->
      <form v-if="showForm" class="sub-form" @submit.prevent="submit">
        <div class="row">
          <select v-model="form.doc_type">
            <option value="evidence">🗂 证据材料</option>
            <option value="rectify">📈 整改进度</option>
            <option value="clue">💡 线索反映</option>
          </select>
          <select v-model.number="form.crisis_id">
            <option :value="null">不指定事件（通用线索，内部核实后挂接）</option>
            <option v-for="c in crises" :key="c.id" :value="c.id">
              #{{ c.id }} {{ c.title }}（{{ c.levelText }} · {{ stText(c.status) }}）
            </option>
          </select>
        </div>
        <input v-model="form.title" placeholder="标题，如 门店整改进度日报 / 监督检查证据 / 采访补充材料" required />
        <textarea v-model="form.content" class="content" placeholder="请详细描述：事实经过、整改措施与进度、可核实的时间地点…" required></textarea>
        <div class="row">
          <input v-model="form.source_url" placeholder="来源链接（报道 URL / 公开文号页面，可留空）" />
          <input v-model="form.contact_info" placeholder="本次对接联系方式（可留空）" />
        </div>
        <!-- 附件清单（演示：仅登记元数据，不落文件） -->
        <div class="atts-edit">
          <span class="lbl">📎 附件清单（演示环境登记文件信息，不上传实体文件）</span>
          <div v-for="(a,i) in form.attachments" :key="i" class="att-row">
            <input v-model="a.name" placeholder="文件名，如 检查记录.pdf" />
            <input v-model.number="a.size" type="number" min="0" placeholder="大小(字节)" style="max-width:120px" />
            <input v-model="a.type" placeholder="类型，如 application/pdf" style="max-width:200px" />
            <button type="button" class="del-att" @click="form.attachments.splice(i,1)">✕</button>
          </div>
          <button type="button" class="add-att" @click="form.attachments.push({name:'',size:0,type:''})">＋ 添加附件</button>
        </div>
        <label class="urgent-check"><input type="checkbox" v-model="form.is_urgent" /> ⚡ 紧急提交（监管督办/重大风险，提交后立即通知内部值班负责人并升级）</label>
        <div class="row">
          <button class="save" type="submit">提交</button>
          <button type="button" class="ghost" @click="showForm=false">取消</button>
        </div>
      </form>

      <div v-if="!mine.length" class="none">暂无提交记录，点击右上角「提交证据/整改进度」开始</div>

      <div class="list">
        <div v-for="s in mine" :key="s.id" class="m-card" :class="[s.status,{urgent:s.is_urgent}]">
          <div class="m-head">
            <span class="code">{{ s.code }}</span>
            <span class="st" :class="s.status">{{ s.statusText }}</span>
            <span class="dt">{{ s.docTypeText }}</span>
            <span v-if="s.is_urgent" class="urgent">⚡ 紧急</span>
            <b class="m-title">{{ s.title }}</b>
            <span class="upd">{{ s.updated }}</span>
          </div>
          <div class="m-meta">
            <span v-if="s.crisis_id">关联事件 <i>#{{ s.crisis_id }} {{ s.crisis_title }}</i></span>
            <span v-else class="no-crisis">未关联事件（等待内部核实挂接）</span>
            <a v-if="s.source_url" :href="s.source_url" target="_blank" rel="noopener">🔗 来源链接</a>
          </div>
          <pre class="content">{{ s.content }}</pre>
          <div v-if="s.attachments && s.attachments.length" class="atts">
            📎 <span v-for="(a,i) in s.attachments" :key="i" class="att">{{ a.name }}<i v-if="a.size">（{{ fmtSize(a.size) }}）</i></span>
          </div>

          <!-- 内部反馈 -->
          <div v-if="s.status==='accepted'" class="accept-box">
            ✔ 内部已采纳（{{ s.accepted_by }} · {{ s.accepted_at }}）<template v-if="s.work_order_id"> · 已回写处置工单 #{{ s.work_order_id }}</template><template v-if="s.resolved_alert_count"> · 同步解除 {{ s.resolved_alert_count }} 条预警</template><template v-if="s.accepted_note"><br />📝 {{ s.accepted_note }}</template>
          </div>
          <div v-if="s.status==='rejected'" class="reject-box">↩ 内部驳回：{{ s.reject_reason }}（{{ s.rejected_by }}）——可补充材料后重新提交</div>

          <!-- 外部操作 -->
          <div class="m-actions">
            <button v-if="['pending','reviewing','rejected'].includes(s.status)" class="op sup" @click="openSup(s)">＋ 补充材料</button>
            <button v-if="['pending','reviewing','rejected'].includes(s.status)" class="op wd" @click="withdraw(s)">撤回提交</button>
            <button class="op logbtn" @click="toggleLogs(s)">{{ logId===s.id ? '收起留痕' : '🧾 处理留痕' }}</button>
          </div>
          <div v-if="logId===s.id" class="m-logs">
            <div v-for="l in s.logs" :key="l.id" class="mlog" :class="l.operator_side">
              <span class="ml-side">{{ sideText(l.operator_side) }}</span>
              <b>{{ extLogText(l.action) }}</b>
              <span>{{ l.detail }}</span>
              <em>{{ l.operator }} · {{ l.time }}</em>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { usePubStore } from '@/store/pub'

const store = usePubStore()
const quick = [
  { code: 'BRAND-2026', label: '某连锁品牌总部（公关部）', kind: 'brand' },
  { code: 'GOV-12315', label: '市市场监督管理局', kind: 'regulator' },
  { code: 'PRESS-PP', label: '澎湃新闻（民生调查部）', kind: 'media' }
]
const inputCode = ref('')
const loginError = ref('')
const partner = ref(null)
const crises = ref([])
const mine = ref([])
const rects = ref([])
const rectBrief = ref({ rectifying: 0, reviewing: 0, accepted: 0 })
const showForm = ref(false)
const logId = ref(null)
const openRect = ref(null)
const progressForm = ref(null)
const progressForReview = ref(false)
const progressDraft = ref(blankProgress())
const form = ref(blankForm())

function blankForm() {
  return { doc_type: 'evidence', crisis_id: null, title: '', content: '', source_url: '', contact_info: '', is_urgent: false, attachments: [] }
}
function blankProgress() {
  return { content: '', source_url: '', contact_info: '', attachments: [] }
}
function kindIcon(k) { return { brand: '🏢', regulator: '⚖️', media: '📰' }[k] || '🤝' }
function stText(s) { return { monitoring: '监测中', disposal: '处置中', closed: '已结案' }[s] || s }
function prioText(p) { return { urgent: '紧急', high: '高', normal: '普通' }[p] || p }
function fmtTs(ms) { return ms ? new Date(ms).toLocaleString('zh-CN') : '—' }
function fmtSize(n) {
  if (!n) return ''
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'MB'
  return Math.max(1, Math.round(n / 1024)) + 'KB'
}
function sideText(s) { return { internal: '内部', external: '我方', system: '系统' }[s] || s }
function extLogText(a) {
  return { create: '提交', supplement: '补充材料', withdraw: '撤回', receive: '内部受理', accept: '审核采纳', reject: '审核驳回', bind: '挂接事件', urgent: '紧急升级' }[a] || a
}
function rectLogText(a) {
  return { create: '建档', dispatch: '分派跟进', progress: '进度报送', submit: '报送验收', verify: '验收通过', reject: '验收驳回', cancel: '取消' }[a] || a
}

async function login(code) {
  loginError.value = ''
  store.setPortalCode((code || '').trim())
  try {
    const d = await store.portalBootstrap()
    partner.value = d.partner
    crises.value = d.crises
    mine.value = d.mine
    rects.value = d.rectifications || []
    rectBrief.value = d.rectBrief || { rectifying: 0, reviewing: 0, accepted: 0 }
  } catch (e) {
    partner.value = null
    loginError.value = e.message || '门户口令无效'
  }
}
function logout() {
  partner.value = null
  mine.value = []
  rects.value = []
  openRect.value = null
  inputCode.value = ''
  store.setPortalCode('')
}

async function refresh() {
  if (!partner.value) return
  const d = await store.portalBootstrap()
  partner.value = d.partner
  crises.value = d.crises
  mine.value = d.mine
  rects.value = d.rectifications || []
  rectBrief.value = d.rectBrief || rectBrief.value
  // 展开中的整改项同步最新明细
  if (openRect.value) {
    const full = rects.value.find((x) => x.id === openRect.value)
    if (full && (!full.logs || !full.progress)) {
      const detail = await store.portalRectFetch(full.id)
      const idx = rects.value.findIndex((x) => x.id === full.id)
      if (idx >= 0) rects.value[idx] = detail
    }
  }
}
async function submit() {
  // 清理空附件行
  form.value.attachments = form.value.attachments.filter((a) => a.name && a.name.trim())
  await store.portalSubmit({ ...form.value })
  showForm.value = false
  form.value = blankForm()
  refresh()
}
async function openSup(s) {
  const note = window.prompt('补充材料说明（将追加到原提交并通知内部审核）：')
  if (note && note.trim()) { await store.portalSupplement(s.id, note.trim()); refresh() }
}
async function withdraw(s) {
  const reason = window.prompt('撤回原因（可留空）：') || ''
  if (reason === null) return
  await store.portalWithdraw(s.id, reason.trim())
  refresh()
}
// ===== 整改事项：展开明细 / 报送进度 / 申请验收 =====
async function toggleRect(r) {
  if (openRect.value === r.id) { openRect.value = null; return }
  openRect.value = r.id
  if (!r.logs || !r.progress) {
    const detail = await store.portalRectFetch(r.id)
    const idx = rects.value.findIndex((x) => x.id === r.id)
    if (idx >= 0) rects.value[idx] = detail
  }
}
function openProgress(r, forReview) {
  progressForm.value = r
  progressForReview.value = !!forReview
  progressDraft.value = blankProgress()
}
async function submitProgressFn() {
  if (!progressDraft.value.content.trim()) { store.msg('请填写本期整改进度说明', 'warn'); return }
  const body = { ...progressDraft.value }
  body.attachments = (body.attachments || []).filter((a) => a.name && a.name.trim())
  body.submit_for_review = progressForReview.value
  await store.portalRectProgress(progressForm.value.id, body)
  progressForm.value = null
  refresh()
}
async function toggleLogs(s) {
  if (logId.value === s.id) { logId.value = null; return }
  logId.value = s.id
  if (!s.logs) {
    const full = await store.portalFetch(s.id)
    const idx = mine.value.findIndex((x) => x.id === s.id)
    if (idx >= 0) mine.value[idx] = full
  }
}

let timer = null
onMounted(() => {
  timer = setInterval(() => { if (partner.value && document.visibilityState === 'visible') refresh().catch(() => {}) }, 10000)
})
onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.portal{display:flex;flex-direction:column;gap:12px;}
/* 身份门 */
.gate{min-height:70vh;display:flex;align-items:center;justify-content:center;padding:20px;}
.gate-card{width:560px;max-width:100%;background:linear-gradient(160deg,#10234a,#0c1730);border:1px solid rgba(120,160,220,0.25);border-radius:18px;padding:32px 34px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.45);}
.gate-logo{font-size:42px;}
.gate-card h2{margin:8px 0 10px;font-size:20px;background:linear-gradient(90deg,#90caf9,#ce93d8);-webkit-background-clip:text;background-clip:text;color:transparent;}
.gate-desc{font-size:13px;color:#aebadd;line-height:1.8;margin:0 0 20px;}
.quick{display:flex;flex-direction:column;gap:8px;margin-bottom:18px;text-align:left;}
.q-lbl{font-size:12px;color:#8ba2c8;}
.q-btn{display:flex;align-items:center;gap:10px;background:#13233f;border:1px solid rgba(120,160,220,0.22);border-radius:10px;padding:10px 14px;cursor:pointer;color:#dbe4f3;text-align:left;}
.q-btn:hover{border-color:#5b82c0;background:#163055;}
.q-btn i{font-style:normal;font-size:18px;}
.q-btn b{flex:1;font-size:13px;font-weight:600;}
.q-btn code{font-size:11px;color:#ffd54f;background:#0a1224;border-radius:5px;padding:2px 8px;}
.code-form{display:flex;gap:8px;}
.code-form input{flex:1;background:#0a1224;border:1px solid rgba(120,160,220,0.3);border-radius:9px;padding:11px 14px;color:#dbe4f3;font-size:13px;font-family:monospace;letter-spacing:1px;}
.enter{background:linear-gradient(135deg,#1565c0,#6a1b9a);color:#fff;border:none;border-radius:9px;padding:0 20px;font-weight:700;cursor:pointer;font-size:13px;}
.err{color:#ef9a9a;font-size:12px;margin:10px 0 0;}
.gate-foot{font-size:11px;color:#6f84ab;margin:16px 0 0;}
/* 门户内 */
.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.who{display:flex;align-items:center;gap:10px;font-size:13px;}
.p-kind{padding:4px 11px;border-radius:14px;font-size:12px;font-weight:700;}
.p-kind.brand{background:#0d3a2c;color:#80cbc4;}
.p-kind.regulator{background:#3a1f0d;color:#ffb74d;}
.p-kind.media{background:#1f2a4a;color:#90caf9;}
.p-contact{color:#8ba2c8;font-size:12px;}
.add{margin-left:auto;background:linear-gradient(135deg,#1565c0,#6a1b9a);color:#fff;border:none;padding:9px 16px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;}
.ghost{background:transparent;border:1px solid rgba(120,160,220,0.35);color:#aebadd;border-radius:8px;padding:8px 14px;cursor:pointer;font-size:13px;}
.hint{font-size:12px;color:#8ba2c8;line-height:1.7;margin:0;}
.sub-form{background:#0f1d38;border:1px solid rgba(120,160,220,0.2);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;}
.row{display:flex;gap:10px;flex-wrap:wrap;}
.row>*{flex:1;min-width:200px;}
.sub-form select,.sub-form input,.sub-form textarea{background:#13233f;border:1px solid rgba(120,160,220,0.25);color:#dbe4f3;border-radius:8px;padding:9px 11px;font-size:13px;font-family:inherit;}
.sub-form textarea.content{min-height:130px;resize:vertical;}
.atts-edit{display:flex;flex-direction:column;gap:7px;}
.lbl{font-size:12px;color:#8ba2c8;}
.att-row{display:flex;gap:8px;}
.att-row input{flex:1;min-width:0;font-size:12px;padding:7px 9px;}
.del-att{background:transparent;border:1px solid rgba(239,83,80,.5);color:#ef9a9a;border-radius:7px;width:38px;cursor:pointer;}
.add-att{align-self:flex-start;background:transparent;border:1px dashed rgba(120,160,220,0.4);color:#90caf9;border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer;}
.urgent-check{font-size:12px;color:#ffb74d;display:flex;align-items:center;gap:8px;}
.save{background:#2e7d32;color:#fff;border:none;border-radius:8px;padding:10px 22px;cursor:pointer;font-weight:700;font-size:13px;}
.none{text-align:center;color:#6f84ab;padding:50px 0;}
.list{display:flex;flex-direction:column;gap:10px;}
.m-card{background:#0f1d38;border:1px solid rgba(120,160,220,0.15);border-radius:12px;padding:14px 16px;}
.m-card.urgent{border-color:rgba(239,83,80,.5);}
.m-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.code{font-family:monospace;background:#0a1224;border:1px solid rgba(120,160,220,0.3);border-radius:5px;padding:2px 8px;font-size:11px;color:#90caf9;}
.st{font-size:11px;padding:2px 9px;border-radius:10px;font-weight:700;}
.st.pending{background:#5d1a1a;color:#ff8a80;}
.st.reviewing{background:#5d3a10;color:#ffcc80;}
.st.accepted{background:#143d1c;color:#a5d6a7;}
.st.rejected{background:#3d1a4d;color:#ce93d8;}
.st.withdrawn{background:#263238;color:#90a4ae;}
.dt{font-size:11px;color:#aebadd;background:#13233f;border-radius:10px;padding:2px 9px;}
.urgent{font-size:11px;color:#fff;background:#c62828;border-radius:10px;padding:2px 9px;font-weight:700;}
.m-title{font-size:14px;}
.upd{margin-left:auto;font-size:11px;color:#6f84ab;}
.m-meta{display:flex;gap:14px;flex-wrap:wrap;margin:9px 0;font-size:12px;color:#8ba2c8;}
.m-meta i{color:#dbe4f3;font-style:normal;}
.m-meta a{color:#90caf9;text-decoration:none;}
.no-crisis{color:#ffb74d;}
.content{white-space:pre-wrap;font-family:inherit;font-size:13px;line-height:1.7;color:#c6d3ea;margin:6px 0;background:#0c1730;border-radius:8px;padding:10px 12px;}
.atts{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:#aebadd;margin-bottom:6px;}
.att{background:#13233f;border-radius:6px;padding:3px 9px;}
.att i{color:#6f84ab;font-style:normal;margin-left:4px;}
.accept-box{background:#143d1c55;border:1px solid #43a04780;color:#a5d6a7;border-radius:8px;padding:8px 12px;font-size:12px;line-height:1.7;margin:6px 0;}
.reject-box{background:#3d1a4d33;border:1px solid #8e24aa80;color:#ce93d8;border-radius:8px;padding:8px 12px;font-size:12px;margin:6px 0;}
.m-actions{display:flex;gap:8px;flex-wrap:wrap;}
.op{border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer;background:transparent;}
.op.sup{border:1px solid #fb8c00;color:#ffcc80;}
.op.wd{border:1px solid rgba(239,83,80,.55);color:#ef9a9a;}
.logbtn{border:1px solid rgba(120,160,220,0.35);color:#aebadd;}
.m-logs{margin-top:10px;border-top:1px dashed rgba(120,160,220,0.18);padding-top:8px;display:flex;flex-direction:column;gap:5px;max-height:230px;overflow-y:auto;}
.mlog{display:flex;gap:10px;align-items:baseline;font-size:12px;flex-wrap:wrap;}
.ml-side{font-size:10px;border-radius:8px;padding:0 7px;font-weight:700;}
.mlog.internal .ml-side{background:#0d2b4d;color:#90caf9;}
.mlog.external .ml-side{background:#3d2a0d;color:#ffb74d;}
.mlog.system .ml-side{background:#263238;color:#b0bec5;}
.mlog b{min-width:56px;color:#dbe4f3;}
.mlog span{color:#aebadd;flex:1;min-width:180px;}
.mlog em{color:#6f84ab;font-style:normal;font-size:11px;}
/* ===== 整改事项（门户） ===== */
.rect-block{background:linear-gradient(160deg,#0c2342,#0b1a33);border:1px solid rgba(38,166,154,.28);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:8px;}
.rect-block h3{margin:0;font-size:15px;color:#80cbc4;display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.rect-brief{display:inline-flex;gap:6px;font-size:11px;font-weight:400;}
.rect-brief i{font-style:normal;border-radius:9px;padding:2px 9px;}
.rect-brief .b-wait{background:#3e2f0a;color:#ffe082;}
.rect-brief .b-rev{background:#3d1a4d;color:#ce93d8;}
.rect-brief .b-ok{background:#143d1c;color:#a5d6a7;}
.rect-hint{margin:0;font-size:12px;color:#8ba2c8;line-height:1.7;}
.rect-list{display:flex;flex-direction:column;gap:10px;}
.rect-card{background:#0a1730;border:1px solid rgba(120,160,220,0.16);border-radius:11px;padding:12px 14px;border-left:4px solid #26a69a;}
.rect-card.pending{border-left-color:#ef5350;}
.rect-card.rectifying{border-left-color:#fb8c00;}
.rect-card.reviewing{border-left-color:#ab47bc;}
.rect-card.rejected{border-left-color:#8d6e63;}
.rect-card.accepted{border-left-color:#43a047;}
.rect-card.cancelled{border-left-color:#607d8b;opacity:.85;}
.rect-card.overdue{box-shadow:0 0 0 1px rgba(239,83,80,.35);}
.rc-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}
.rc-head .code{font-family:monospace;background:#0c1730;border:1px solid rgba(120,160,220,0.35);border-radius:5px;padding:2px 8px;font-size:11px;color:#80cbc4;}
.rc-st{font-size:11px;padding:2px 9px;border-radius:10px;font-weight:700;background:#0d302c;color:#80cbc4;}
.rc-st.pending{background:#5d1a1a;color:#ff8a80;}
.rc-st.rectifying{background:#5d3a10;color:#ffcc80;}
.rc-st.reviewing{background:#3d1a4d;color:#ce93d8;}
.rc-st.accepted{background:#143d1c;color:#a5d6a7;}
.rc-st.rejected{background:#3e2723;color:#bcaaa4;}
.rc-st.cancelled{background:#263238;color:#90a4ae;}
.rc-prio{font-size:10px;padding:2px 8px;border-radius:9px;background:#0d2137;color:#90caf9;}
.rc-prio.urgent{background:#4a1518;color:#ef9a9a;}
.rc-overdue{font-size:10px;color:#fff;background:#c62828;border-radius:9px;padding:2px 8px;font-weight:700;}
.rc-title{font-size:13px;}
.rc-meta{display:flex;gap:14px;flex-wrap:wrap;margin:8px 0;font-size:12px;color:#8ba2c8;}
.rc-meta i{color:#dbe4f3;font-style:normal;}
.rc-meta .due{color:#ffb74d;}
.rc-detached{color:#90a4ae;}
.rc-req{white-space:pre-wrap;font-family:inherit;font-size:12px;line-height:1.7;color:#c6d3ea;margin:4px 0;background:#0c1730;border-radius:8px;padding:9px 12px;border:1px solid rgba(120,160,220,0.12);}
.rc-reject{background:#3e272355;border:1px solid #8d6e6380;color:#d7ccc8;border-radius:8px;padding:8px 12px;font-size:12px;margin:6px 0;line-height:1.6;}
.rc-reviewing{background:#3d1a4d33;border:1px solid #8e24aa80;color:#ce93d8;border-radius:8px;padding:8px 12px;font-size:12px;margin:6px 0;}
.rc-accepted{background:#143d1c55;border:1px solid #43a04780;color:#a5d6a7;border-radius:8px;padding:8px 12px;font-size:12px;margin:6px 0;}
.rc-cancelled{background:#26323855;border:1px solid #607d8b80;color:#b0bec5;border-radius:8px;padding:8px 12px;font-size:12px;margin:6px 0;}
.rc-progs{display:flex;flex-direction:column;gap:6px;margin-top:6px;}
.rc-prog{background:#0c1a30;border:1px solid rgba(120,160,220,0.14);border-radius:8px;padding:8px 10px;font-size:12px;display:flex;flex-direction:column;gap:3px;}
.rc-prog.review{border-color:rgba(171,71,188,.4);}
.rp-flag{font-size:10px;font-weight:700;color:#90caf9;}
.rc-prog.review .rp-flag{color:#ce93d8;}
.rp-content{color:#dbe4f3;line-height:1.6;white-space:pre-wrap;}
.rp-atts{display:flex;gap:8px;flex-wrap:wrap;font-size:11px;color:#aebadd;}
.rp-att{background:#13233f;border-radius:6px;padding:2px 8px;}
.rp-att i{color:#6f84ab;font-style:normal;margin-left:3px;}
.rp-url{font-size:11px;color:#90caf9;text-decoration:none;}
.rc-prog em{font-size:10px;color:#6f84ab;font-style:normal;}
.rc-logs{margin-top:8px;border-top:1px dashed rgba(120,160,220,0.16);padding-top:7px;display:flex;flex-direction:column;gap:4px;max-height:190px;overflow-y:auto;}
.rclog{display:flex;gap:8px;font-size:11px;color:#aebadd;flex-wrap:wrap;}
.rclog span{color:#80cbc4;font-weight:600;flex:none;}
.rclog i{font-style:normal;flex:1;min-width:160px;}
.rclog em{color:#6f84ab;font-style:normal;}
.rc-none{font-size:12px;color:#6f84ab;text-align:center;padding:8px 0;}
.rc-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;}
.rc-op{border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer;background:transparent;}
.rc-op.progress{border:1px solid #26a69a;color:#80cbc4;}
.rc-op.review{border:1px solid #ab47bc;color:#ce93d8;font-weight:600;}
.rc-op.logbtn{border:1px solid rgba(120,160,220,0.35);color:#aebadd;}
.modal-mask{position:fixed;inset:0;background:rgba(4,10,22,.72);z-index:60;display:flex;align-items:center;justify-content:center;padding:20px;}
.modal{background:#0f1d38;border:1px solid rgba(120,160,220,0.3);border-radius:14px;padding:20px;width:560px;max-width:100%;display:flex;flex-direction:column;gap:10px;max-height:88vh;overflow-y:auto;}
.modal h4{margin:0;font-size:15px;}
.modal-hint{margin:0;font-size:12px;color:#8ba2c8;line-height:1.6;}
.modal input,.modal textarea{background:#13233f;border:1px solid rgba(120,160,220,0.25);color:#dbe4f3;border-radius:8px;padding:9px 11px;font-size:13px;font-family:inherit;}
.modal textarea{min-height:110px;resize:vertical;}
.modal-ops{display:flex;gap:10px;justify-content:flex-end;}
.del-att{background:transparent;border:1px solid rgba(239,83,80,.5);color:#ef9a9a;border-radius:7px;width:38px;cursor:pointer;}
.add-att{align-self:flex-start;background:transparent;border:1px dashed rgba(120,160,220,0.4);color:#90caf9;border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer;}
</style>
