/**
 * dsh-approval-bubble —— Client half.
 *
 * 两处槽位注册：
 *   1. sidebar.workspaces.session.row.action / approval-bubble-anchor
 *      每个会话行无条件挂载的 0×0 锚点；把该行（[data-row-key]）的几何写进共享 store。
 *   2. shell.overlay / approval-bubble-layer
 *      读取 uiSession.sessionStatus 的待交互对象，在侧栏行右侧渲染橘色气泡，
 *      就地完成权限审批 / 选项提问 / 计划确认；翻译走 Host 路由，复制走剪贴板。
 *
 * 待交互对象只存在于浏览器端（PendingApproval / PendingQuestion 由自带
 * ui-approval / ui-user-questions 创建并注册进 uiSession），所以回答动作只能
 * 在客户端调用它们的 answer()/dismiss()；本插件不重复实现请求链路。
 */

window.__ModuleLoader__.load({
  id: 'dsh-approval-bubble',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const TRANSLATE_ROUTE = '/dsh-approval-bubble/translate'
    const BUBBLE_MIN_WIDTH = 268
    const BUBBLE_MAX_WIDTH = 420

    /** 气泡宽度跟随窗口宽度缩放：约 26% 视口宽，带上下限；缩放窗口时实时变化。 */
    function bubbleWidthFor(viewportWidth) {
      const proportional = Math.round(viewportWidth * 0.26)
      return Math.max(BUBBLE_MIN_WIDTH, Math.min(BUBBLE_MAX_WIDTH, proportional))
    }
    const GAP = 8

    // ---------------------------------------------------------------- 文案 ----

    const TEXTS = {
      zh: {
        'kind.approval': '权限审批',
        'kind.question': '待你选择',
        'kind.planReview': '计划确认',
        'kind.generic': '需要你操作',
        'action.allowOnce': '允许一次',
        'action.reject': '拒绝',
        'action.approve': '通过',
        'action.translate': '翻译',
        'action.copy': '复制',
        'action.openSession': '打开会话',
        'action.detail': '详情',
        'action.skip': '跳过',
        'action.prev': '上一步',
        'action.next': '下一步',
        'action.submit': '提交',
        'bubble.hide': '关闭本气泡',
        'bubble.drag': '按住这里可拖动气泡',
        'hint.copied': '已复制',
        'hint.copyFailed': '复制失败',
        'hint.translating': '翻译中…',
        'hint.translateFailed': '翻译失败',
        'hint.expired': '该请求已结束',
        'hint.unanswered': '请选择或填写后再继续',
        'hint.approvalFallback': '工具 {tool} 请求越权执行',
        'hint.genericBody': '该会话需要你的操作',
        'label.translation': '译文',
        'pager': '第 {index} / {total} 题',
        'customPlaceholder': '其他回答…',
        'recommended': '推荐',
        'untitled': '未命名会话',
      },
      en: {
        'kind.approval': 'Permission',
        'kind.question': 'Needs your choice',
        'kind.planReview': 'Plan review',
        'kind.generic': 'Needs your action',
        'action.allowOnce': 'Allow once',
        'action.reject': 'Reject',
        'action.approve': 'Approve',
        'action.translate': 'Translate',
        'action.copy': 'Copy',
        'action.openSession': 'Open session',
        'action.detail': 'Details',
        'action.skip': 'Skip',
        'action.prev': 'Back',
        'action.next': 'Next',
        'action.submit': 'Submit',
        'bubble.hide': 'Hide this bubble',
        'bubble.drag': 'Drag here to move the bubble',
        'hint.copied': 'Copied',
        'hint.copyFailed': 'Copy failed',
        'hint.translating': 'Translating…',
        'hint.translateFailed': 'Translation failed',
        'hint.expired': 'This request has ended',
        'hint.unanswered': 'Choose or type an answer to continue',
        'hint.approvalFallback': 'Tool {tool} requests elevated permission',
        'hint.genericBody': 'This session needs your action',
        'label.translation': 'Translation',
        'pager': 'Question {index} / {total}',
        'customPlaceholder': 'Other answer…',
        'recommended': 'Recommended',
        'untitled': 'Untitled session',
      },
    }

    function format(template, vars) {
      if (!vars) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
      )
    }

    function normalizeLocaleId(value) {
      const text = String(value || '').toLowerCase()
      return text.startsWith('zh') ? 'zh' : 'en'
    }

    // ---------------------------------------------------------------- 样式 ----

    const CSS = `
.dsab-bubble{position:fixed;z-index:1200;width:340px;max-height:60vh;display:flex;flex-direction:column;
  pointer-events:auto;box-sizing:border-box;overflow:hidden;font-family:inherit;font-size:13px;line-height:1.5;
  --dsab-accent:var(--dsw-alias-state-warn-primary,#f2b95e);
  --dsab-accent-soft:var(--dsw-alias-state-warn-tertiary,#3b2d18);
  --dsab-accent-border:var(--dsw-alias-state-warn-secondary,#c98a3c);
  --dsab-accent-fg:#241a0c;
  color:var(--dsw-alias-label-primary,#eaeaea);
  background:linear-gradient(180deg,color-mix(in srgb,var(--dsab-accent) 8%,var(--dsw-alias-bg-overlay,#24242b)),var(--dsw-alias-bg-overlay,#24242b) 132px);
  border:1.5px solid color-mix(in srgb,var(--dsab-accent) 62%,transparent);
  border-radius:14px;
  box-shadow:0 12px 32px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.22);
  animation:dsab-in .18s cubic-bezier(.2,.8,.3,1);-webkit-font-smoothing:antialiased}
@keyframes dsab-in{from{opacity:0;transform:translateY(-6px) scale(.985)}to{opacity:1;transform:none}}
/* 颜色区分：权限申请=橙（state-warn），普通提问/计划确认=蓝（state-business，浅色 #4176e6 / 深色 #7aaaff）
   注意：--dsw-alias-brand-primary 在本主题是黑白墨色（浅 #0f1115 / 深 #f9fafb），不能当蓝色用。 */
.dsab-bubble[data-kind="question"],.dsab-bubble[data-kind="plan-review"]{
  --dsab-accent:var(--dsw-alias-state-business-primary,#4176e6);
  --dsab-accent-soft:var(--dsw-alias-state-business-tertiary,#e4edfd);
  --dsab-accent-border:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 72%,transparent);
  --dsab-accent-fg:#fff}
/* 深色主题下 business-primary 是亮蓝 #7aaaff，实心按钮/标签改用深色文字避免发白 */
body[data-ds-dark-theme] .dsab-bubble[data-kind="question"],
body[data-ds-dark-theme] .dsab-bubble[data-kind="plan-review"]{--dsab-accent-fg:#0f1115}
/* 拖动时只改光标和阴影；不要动 animation，否则松手时入场动画会重播 */
.dsab-bubble.dsab-dragging{cursor:grabbing;
  box-shadow:0 18px 44px rgba(0,0,0,.44),0 4px 12px rgba(0,0,0,.28)}
.dsab-head{display:flex;align-items:center;gap:8px;padding:8px 10px;flex:none;
  background:linear-gradient(180deg,color-mix(in srgb,var(--dsab-accent) 30%,transparent),color-mix(in srgb,var(--dsab-accent) 8%,transparent));
  color:var(--dsab-accent);cursor:grab;user-select:none;touch-action:none}
.dsab-bubble.dsab-dragging .dsab-head{cursor:grabbing}
.dsab-dot{flex:none;width:7px;height:7px;border-radius:50%;background:currentColor;
  box-shadow:0 0 0 3px color-mix(in srgb,currentColor 24%,transparent)}
.dsab-title{flex:1;min-width:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  color:var(--dsw-alias-label-primary,#f1f1f3)}
.dsab-kind{flex:none;font-size:10.5px;line-height:18px;padding:0 8px;border-radius:999px;font-weight:600;letter-spacing:.02em;
  background:var(--dsab-accent);color:var(--dsab-accent-fg)}
.dsab-close{flex:none;width:22px;height:22px;border:0;border-radius:7px;cursor:pointer;background:transparent;color:inherit;
  font-size:15px;line-height:20px;padding:0;opacity:.72;transition:background .12s,opacity .12s}
.dsab-close:hover{background:color-mix(in srgb,currentColor 16%,transparent);opacity:1}
.dsab-body{padding:10px 12px 6px;overflow:auto;display:flex;flex-direction:column;gap:8px;min-height:0}
.dsab-body::-webkit-scrollbar{width:8px}
.dsab-body::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 16%,transparent);
  border-radius:8px;border:2px solid transparent;background-clip:content-box}
.dsab-eyebrow{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-secondary,color-mix(in srgb,var(--dsw-alias-label-primary,#888) 75%,transparent))}
.dsab-question{font-size:13.5px;font-weight:600;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.dsab-reason{font-size:12.5px;line-height:1.55;color:var(--dsw-alias-label-secondary,color-mix(in srgb,var(--dsw-alias-label-primary,#888) 82%,transparent));
  white-space:pre-wrap;word-break:break-word;max-height:14vh;overflow:auto}
.dsab-plan{font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;max-height:22vh;overflow:auto;
  border-left:3px solid color-mix(in srgb,var(--dsab-accent) 55%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 4%,transparent);
  border-radius:0 9px 9px 0;padding:8px 10px}
.dsab-options{display:flex;flex-direction:column;gap:6px}
.dsab-option{display:flex;align-items:flex-start;gap:9px;width:100%;padding:8px 10px;border-radius:10px;cursor:pointer;
  text-align:left;font:inherit;color:inherit;transition:border-color .12s,background .12s;
  border:1px solid var(--dsw-alias-border-l3,color-mix(in srgb,var(--dsw-alias-label-primary,#888) 16%,transparent));
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 3%,transparent)}
.dsab-option:hover{border-color:color-mix(in srgb,var(--dsab-accent) 60%,transparent)}
.dsab-option.selected{border-color:var(--dsab-accent);
  background:color-mix(in srgb,var(--dsab-accent) 12%,transparent)}
.dsab-choice{flex:none;width:16px;height:16px;margin-top:2px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;
  border:1.5px solid color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 32%,transparent);
  transition:background .12s,border-color .12s}
.dsab-choice.multi{border-radius:5px}
.dsab-choice::after{content:"";width:6px;height:6px;border-radius:50%;background:transparent}
.dsab-choice.multi::after{width:8px;height:4px;border-radius:0;background:transparent;
  border-left:2px solid transparent;border-bottom:2px solid transparent;transform:rotate(-45deg) translateY(-1px)}
.dsab-option.selected .dsab-choice{border-color:var(--dsab-accent);background:var(--dsab-accent)}
.dsab-option.selected .dsab-choice::after{background:var(--dsw-alias-bg-overlay,#24242b)}
.dsab-option.selected .dsab-choice.multi::after{background:transparent;border-color:var(--dsw-alias-bg-overlay,#24242b)}
.dsab-option-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsab-option-label{font-size:12.5px;line-height:1.4;word-break:break-word}
.dsab-option-desc{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary,color-mix(in srgb,var(--dsw-alias-label-primary,#888) 70%,transparent))}
.dsab-badge{flex:none;font-size:10px;line-height:16px;padding:0 6px;border-radius:999px;font-weight:500;
  color:var(--dsab-accent);
  background:color-mix(in srgb,var(--dsab-accent) 15%,transparent)}
.dsab-input{width:100%;box-sizing:border-box;height:32px;padding:0 10px;border-radius:9px;font:inherit;font-size:12.5px;color:inherit;
  transition:border-color .12s;
  border:1px solid var(--dsw-alias-border-l3,color-mix(in srgb,var(--dsw-alias-label-primary,#888) 16%,transparent));
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 4%,transparent)}
.dsab-input::placeholder{color:var(--dsw-alias-label-secondary,color-mix(in srgb,var(--dsw-alias-label-primary,#888) 52%,transparent))}
.dsab-input:focus{outline:none;border-color:var(--dsab-accent)}
.dsab-foot{display:flex;align-items:center;gap:6px;padding:8px 10px;flex:none;
  border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 8%,transparent);
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 2%,transparent)}
.dsab-tools{display:flex;gap:2px;align-items:center}
.dsab-btns{display:flex;gap:6px;align-items:center;margin-left:auto;flex-wrap:wrap;justify-content:flex-end}
.dsab-btn{height:28px;padding:0 12px;border-radius:9px;cursor:pointer;font:inherit;font-size:12.5px;font-weight:500;
  color:inherit;transition:background .12s,border-color .12s,filter .12s;
  border:1px solid var(--dsw-alias-border-l3,color-mix(in srgb,var(--dsw-alias-label-primary,#888) 18%,transparent));background:transparent}
.dsab-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 8%,transparent)}
.dsab-btn.primary{background:var(--dsab-accent);color:var(--dsab-accent-fg);border-color:transparent;font-weight:600}
.dsab-btn.primary:hover{filter:brightness(1.05)}
.dsab-btn.danger{color:var(--dsw-alias-state-error-primary,#e05a5a);
  border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e05a5a) 32%,transparent)}
.dsab-btn.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,80,80,.16))}
.dsab-link{height:26px;padding:0 8px;border:0;border-radius:8px;background:transparent;cursor:pointer;font:inherit;font-size:12px;
  color:var(--dsw-alias-label-secondary,color-mix(in srgb,var(--dsw-alias-label-primary,#888) 70%,transparent))}
.dsab-link:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 7%,transparent);
  color:var(--dsw-alias-label-primary,#eaeaea)}
.dsab-hint{font-size:11.5px;line-height:1.45;color:var(--dsab-accent);white-space:pre-wrap}
.dsab-hint.error{color:var(--dsw-alias-state-error-primary,#e05a5a)}
.dsab-trans{margin:0;padding:8px 10px;border-radius:10px;white-space:pre-wrap;word-break:break-word;
  font-size:12px;line-height:1.55;max-height:20vh;overflow:auto;
  background:color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 4%,transparent);
  border:1px dashed color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 12%,transparent)}
.dsab-trans-label{display:block;font-size:10px;line-height:1.4;letter-spacing:.06em;margin-bottom:2px;
  color:var(--dsw-alias-label-secondary,color-mix(in srgb,var(--dsw-alias-label-primary,#888) 60%,transparent))}
.dsab-pager{font-size:11px;color:var(--dsw-alias-label-secondary,color-mix(in srgb,var(--dsw-alias-label-primary,#888) 60%,transparent));font-variant-numeric:tabular-nums}
.dsab-detail-toggle{align-self:flex-start;border:0;background:transparent;color:var(--dsab-accent);
  font:inherit;font-size:11.5px;cursor:pointer;padding:0 0 2px;opacity:.9}
.dsab-detail-toggle:hover{text-decoration:underline}
`

    // ------------------------------------------------------------ 共享状态 ----

    /** sessionId → () => DOMRect | null（由行内 Anchor 注册） */
    const anchorMeasures = new Map()
    /** pending.key → 本机已关闭 */
    const dismissedKeys = new Set()
    /** pending.key → 气泡内交互状态 */
    const uiStates = new Map()
    /** pending.key → 首次发现“行锚点不可用”的时间（用于右下角兜底延迟） */
    const unseenSince = new Map()
    /** 强制 Layer 重算 */
    const bumpListeners = new Set()

    function bump() {
      for (const listener of bumpListeners) {
        try {
          listener()
        } catch {
          /* ignore */
        }
      }
    }

    // 自检遥测：没有浏览器自动化，用宿主路由记录 apply / 槽位挂载 / 气泡渲染次数。
    let anchorReported = false
    let lastBubbleReport = ''

    function report(payload) {
      try {
        fetch('/dsh-approval-bubble/ping', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {})
      } catch {
        /* ignore */
      }
    }

    function uiStateOf(key, pending) {
      let state = uiStates.get(key)
      if (state === undefined) {
        state = {
          questionIndex: 0,
          showDetail: false,
          answers: new Map(), // questionId → {selected: [], custom: '', skipped: false}
          translation: '',
          translating: false,
          translateError: false,
          hint: '',
          copyState: '',
          /** 用户拖动后的固定位置 {top,left}；null 表示跟随会话行自动定位 */
          manual: null,
        }
        const questions = Array.isArray(pending.questions) ? pending.questions : []
        for (const question of questions) {
          const draft = { selected: [], custom: '', skipped: false }
          const options = Array.isArray(question.options) ? question.options : []
          const first = options[0]
          if (first && typeof first.label === 'string' && /(?:\(\s*(?:recommended|推荐)\s*\)|（\s*(?:recommended|推荐)\s*）)\s*$/i.test(first.label)) {
            draft.selected = [first.label]
          }
          state.answers.set(question.id, draft)
        }
        uiStates.set(key, state)
      }
      return state
    }

    function answerOf(state, question) {
      let answer = state.answers.get(question.id)
      if (answer === undefined) {
        answer = { selected: [], custom: '', skipped: false }
        state.answers.set(question.id, answer)
      }
      return answer
    }

    function isAnswerable(pending) {
      if (!pending) return false
      if (pending.kind === 'approval') return pending.answerable !== false
      if (pending.kind === 'question' || pending.kind === 'plan-review') {
        if (typeof pending.snapshot !== 'function') return true
        const snapshot = pending.snapshot()
        if (!snapshot) return true
        return snapshot.channel !== 'none' && snapshot.closed !== true
      }
      return false
    }

    function pendingKindOf(pending) {
      if (!pending) return ''
      return pending.kind === 'approval' || pending.kind === 'question' || pending.kind === 'plan-review'
        ? pending.kind
        : ''
    }

    function stripMarkdown(text) {
      return String(text || '')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/`{1,3}/g, '')
        .replace(/\*\*/g, '')
        .replace(/^\s*[-*+]\s+/gm, '· ')
        .trim()
    }

    function planHeadline(plan) {
      const source = String(plan || '')
      const lines = source.split(/\r?\n/)
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed !== '') return stripMarkdown(trimmed.replace(/^#+\s*/, ''))
      }
      return ''
    }

    function planSummary(plan) {
      const source = stripMarkdown(plan)
      const blocks = source.split(/\n{2,}/)
      const first = blocks.map((block) => block.replace(/\s+/g, ' ').trim()).find((block) => block !== '')
      if (!first) return ''
      const headline = planHeadline(plan)
      const body = first === headline ? blocks.slice(1).join(' ').trim() || first : first
      return body.length > 220 ? body.slice(0, 220) + '…' : body
    }

    async function writeClipboard(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* fall through */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.left = '-1000px'
        area.style.top = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        area.remove()
        return ok === true
      } catch {
        return false
      }
    }

    // ---------------------------------------------------------------- 插件 ----

    function apply(ctx) {
      const styleElement = document.createElement('style')
      styleElement.setAttribute('data-dsh-approval-bubble', 'style')
      styleElement.setAttribute('data-plugin-css', 'dsh-approval-bubble/client')
      styleElement.textContent = CSS
      document.head.appendChild(styleElement)
      ctx.effect(() => () => styleElement.remove())

      const locale = ctx.get('locale')
      const uiSession = ctx.get('uiSession')
      const sessionsService = ctx.get('sessions')
      const uiWorkspace = ctx.get('uiWorkspace')

      const statusStore = uiSession && uiSession.sessionStatus ? uiSession.sessionStatus : undefined
      const listStore = sessionsService && sessionsService.list ? sessionsService.list : undefined

      function activeLocaleId() {
        let snapshot
        try {
          snapshot = locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : undefined
        } catch {
          snapshot = undefined
        }
        const candidates = []
        if (snapshot && typeof snapshot === 'object') {
          candidates.push(snapshot.id, snapshot.locale, snapshot.current, snapshot.language, snapshot.value)
          if (snapshot.preference && typeof snapshot.preference === 'object') candidates.push(snapshot.preference.id)
        }
        if (typeof snapshot === 'string') candidates.push(snapshot)
        for (const candidate of candidates) {
          if (typeof candidate === 'string' && candidate !== '') return normalizeLocaleId(candidate)
        }
        const documentLocale = document.documentElement && document.documentElement.lang
        if (documentLocale) return normalizeLocaleId(documentLocale)
        return normalizeLocaleId(navigator.language)
      }

      function translateText(key, vars) {
        const localeId = currentLocaleRef.current
        const dict = TEXTS[localeId] || TEXTS.en
        const template = dict[key] !== undefined ? dict[key] : TEXTS.en[key] !== undefined ? TEXTS.en[key] : key
        return format(template, vars)
      }

      const currentLocaleRef = { current: activeLocaleId() }

      function useSnapshotStore(store) {
        const [snapshot, setSnapshot] = React.useState(() => {
          try {
            return store ? store.getSnapshot() : undefined
          } catch {
            return undefined
          }
        })
        React.useEffect(() => {
          if (!store || typeof store.subscribe !== 'function') return undefined
          let alive = true
          const sync = () => {
            if (!alive) return
            try {
              setSnapshot(store.getSnapshot())
            } catch {
              /* ignore */
            }
          }
          sync()
          const off = store.subscribe(sync)
          return () => {
            alive = false
            if (typeof off === 'function') off()
          }
        }, [store])
        return snapshot
      }

      /** 行内锚点：把该会话行的几何暴露给 Layer。 */
      function Anchor(props) {
        const sessionId = props && props.sessionId
        const ref = React.useRef(null)
        React.useLayoutEffect(() => {
          if (typeof sessionId !== 'string' || sessionId === '') return undefined
          const measure = () => {
            const node = ref.current
            if (!node) return null
            let row = null
            try {
              row = node.closest('[data-row-key]')
            } catch {
              row = null
            }
            if (!row) return null
            const rect = row.getBoundingClientRect()
            if (rect.width === 0 && rect.height === 0) return null
            return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
          }
          anchorMeasures.set(sessionId, measure)
          if (!anchorReported) {
            anchorReported = true
            report({ event: 'anchor', sessionId })
          }
          bump()
          return () => {
            anchorMeasures.delete(sessionId)
            bump()
          }
        }, [sessionId])
        return h('span', { ref, 'data-dsh-approval-bubble': 'anchor', style: { display: 'none' } })
      }

      /** 覆盖层：渲染所有气泡。 */
      function Layer() {
        const [localeId, setLocaleId] = React.useState(() => activeLocaleId())
        currentLocaleRef.current = localeId
        const statuses = useSnapshotStore(statusStore)
        const list = useSnapshotStore(listStore)
        const statusesRef = React.useRef(statuses)
        const listRef = React.useRef(list)
        statusesRef.current = statuses
        listRef.current = list

        const [layout, setLayout] = React.useState([])
        const layoutSignatureRef = React.useRef('')
        const heightsRef = React.useRef(new Map())
        const elementRefs = React.useRef(new Map())

        React.useEffect(() => {
          if (!locale || typeof locale.subscribe !== 'function') return undefined
          const sync = () => setLocaleId(activeLocaleId())
          const off = locale.subscribe(sync)
          return () => {
            if (typeof off === 'function') off()
          }
        }, [])

        React.useEffect(() => {
          report({ event: 'layer' })
        }, [])

        React.useEffect(() => {
          let scheduled = 0
          const listener = () => {
            layoutSignatureRef.current = ''
            if (scheduled !== 0) return
            scheduled = requestAnimationFrame(() => {
              scheduled = 0
              heightsRef.current.clear()
              for (const [key, node] of elementRefs.current) {
                if (node && typeof node.offsetHeight === 'number') heightsRef.current.set(key, node.offsetHeight)
              }
              setLayout(computeLayout())
            })
          }
          bumpListeners.add(listener)
          listener()
          return () => {
            bumpListeners.delete(listener)
            if (scheduled !== 0) cancelAnimationFrame(scheduled)
          }
        }, [])

        React.useEffect(() => {
          let frame = 0
          let stopped = false
          let last = 0
          function step(now) {
            if (stopped) return
            frame = requestAnimationFrame(step)
            // 约 10fps：气泡只需跟随侧栏滚动，不必逐帧。
            if (now - last < 100) return
            last = now
            heightsRef.current.clear()
            for (const [key, node] of elementRefs.current) {
              if (node && typeof node.offsetHeight === 'number') heightsRef.current.set(key, node.offsetHeight)
            }
            const next = computeLayout()
            const signature = next.map((item) => `${item.key}:${Math.round(item.top)}:${Math.round(item.left)}:${item.width}`).join('|')
            if (signature !== layoutSignatureRef.current) {
              layoutSignatureRef.current = signature
              setLayout(next)
            }
          }
          frame = requestAnimationFrame(step)
          return () => {
            stopped = true
            cancelAnimationFrame(frame)
          }
        }, [])

        function computeLayout() {
          const statusesNow = statusesRef.current
          const listNow = listRef.current
          if (!statusesNow || typeof statusesNow.forEach !== 'function') return []
          const byId = listNow && listNow.byId ? listNow.byId : {}
          const now = Date.now()
          const candidates = []
          for (const [sessionId, status] of statusesNow) {
            const pending = status && status.pendingInteraction
            if (!pendingKindOf(pending)) continue
            if (!isAnswerable(pending)) continue
            if (dismissedKeys.has(pending.key)) continue
            const row = byId[sessionId]
            if (row && row.retainedBy && (row.retainedBy.mainView || 0) > 0) continue
            const measure = anchorMeasures.get(sessionId)
            const rect = measure ? measure() : null
            const title = (row && row.displayTitle) || (row && row.title) || ''
            if (rect && rect.bottom >= 0 && rect.top <= window.innerHeight) {
              unseenSince.delete(pending.key)
              candidates.push({ sessionId, pending, rect, anchored: true, title: title || translateText('untitled') })
              continue
            }
            // 行锚点不可用（工作区折叠 / 行滚出视口 / 侧栏收起）：1.2s 后改用右下角兜底堆叠，
            // 避免待交互请求完全不出现；短暂缺锚点（滚动/重渲染）不会造成闪烁。
            let since = unseenSince.get(pending.key)
            if (since === undefined) {
              since = now
              unseenSince.set(pending.key, now)
            }
            if (now - since < 1200) continue
            candidates.push({
              sessionId,
              pending,
              rect: null,
              anchored: false,
              title: title || translateText('untitled'),
            })
          }
          candidates.sort((a, b) => {
            if (a.anchored !== b.anchored) return a.anchored ? -1 : 1
            if (a.anchored) return a.rect.top - b.rect.top
            return String(a.pending.key).localeCompare(String(b.pending.key))
          })
          // 请求被别处答掉 / 超时后清掉残留状态；仍存在但被本机关闭的请求保留 dismissed 标记。
          const presentKeys = new Set()
          for (const [, status] of statusesNow) {
            const pending = status && status.pendingInteraction
            if (pendingKindOf(pending)) presentKeys.add(pending.key)
          }
          for (const key of dismissedKeys) {
            if (!presentKeys.has(key)) dismissedKeys.delete(key)
          }
          for (const key of uiStates.keys()) {
            if (!presentKeys.has(key)) uiStates.delete(key)
          }
          for (const key of unseenSince.keys()) {
            if (!presentKeys.has(key)) unseenSince.delete(key)
          }
          const viewportWidth = window.innerWidth
          const bubbleWidth = bubbleWidthFor(viewportWidth)
          const maxTop = window.innerHeight - 80
          const placed = []
          // 用户拖动过（manual）的气泡固定在自己拖到的位置，不再随会话行/滚动移动。
          const manualKeys = new Set()
          for (const candidate of candidates) {
            const state = uiStates.get(candidate.pending.key)
            if (state === undefined || state.manual === null) continue
            manualKeys.add(candidate.pending.key)
            const top = Math.min(Math.max(state.manual.top, GAP), Math.max(GAP, maxTop))
            const left = Math.min(Math.max(state.manual.left, GAP), Math.max(GAP, viewportWidth - bubbleWidth - GAP))
            state.manual = { top, left }
            placed.push({
              key: candidate.pending.key,
              sessionId: candidate.sessionId,
              pending: candidate.pending,
              title: candidate.title,
              fallback: candidate.anchored !== true,
              top,
              left,
              width: bubbleWidth,
            })
          }
          let previousBottom = 0
          for (const candidate of candidates) {
            if (!candidate.anchored) continue
            if (manualKeys.has(candidate.pending.key)) continue
            const key = candidate.pending.key
            const height = heightsRef.current.get(key) || 120
            let top = Math.max(candidate.rect.top, previousBottom + GAP)
            if (top > maxTop) top = Math.max(GAP, maxTop)
            let left = candidate.rect.right + GAP
            if (left + bubbleWidth + GAP > viewportWidth) left = viewportWidth - bubbleWidth - GAP
            if (left < GAP) left = GAP
            placed.push({
              key,
              sessionId: candidate.sessionId,
              pending: candidate.pending,
              title: candidate.title,
              fallback: false,
              top,
              left,
              width: bubbleWidth,
            })
            previousBottom = top + height
          }
          // 右下角兜底：从下往上堆叠，不遮挡顶部输入区。
          const fallbackLeft = Math.max(GAP, viewportWidth - bubbleWidth - GAP)
          let fallbackBottom = window.innerHeight - GAP
          for (const candidate of candidates) {
            if (candidate.anchored) continue
            if (manualKeys.has(candidate.pending.key)) continue
            const key = candidate.pending.key
            const height = heightsRef.current.get(key) || 120
            const top = Math.max(GAP, fallbackBottom - height)
            placed.push({
              key,
              sessionId: candidate.sessionId,
              pending: candidate.pending,
              title: candidate.title,
              fallback: true,
              top,
              left: fallbackLeft,
              width: bubbleWidth,
            })
            fallbackBottom = top - GAP
          }
          const bubbleSignature = placed
            .map((entry) => entry.key + ':' + pendingKindOf(entry.pending) + ':' + (entry.fallback ? 'fb' : 'row'))
            .join('|')
          if (bubbleSignature !== lastBubbleReport) {
            lastBubbleReport = bubbleSignature
            report({
              event: 'bubbles',
              count: placed.length,
              kinds: placed.map((entry) => pendingKindOf(entry.pending)).join(','),
            })
          }
          return placed
        }

        // portal 到 document.body：避开 shell.overlay 容器的 pointer-events / 裁剪约束。
        return ReactDOM.createPortal(
          layout.map((item) =>
            h(Bubble, {
              key: item.key,
              item,
              localeId,
              registerElement: (node) => {
                if (node) elementRefs.current.set(item.key, node)
                else elementRefs.current.delete(item.key)
              },
              onLayoutChange: () => setLayout((previous) => previous.slice()),
            }),
          ),
          document.body,
        )
      }

      /** 单个气泡。 */
      function Bubble(props) {
        const { item, localeId } = props
        const pending = item.pending
        const t = (key, vars) => {
          const dict = TEXTS[localeId] || TEXTS.en
          const template = dict[key] !== undefined ? dict[key] : TEXTS.en[key] !== undefined ? TEXTS.en[key] : key
          return format(template, vars)
        }
        const [, force] = React.useState(0)
        const state = uiStateOf(pending.key, pending)
        const kind = pendingKindOf(pending)

        function rerender() {
          force((value) => value + 1)
          props.onLayoutChange()
        }

        /** 按住头部拖动气泡；拖过之后位置固定，不再跟随会话行。 */
        function startDrag(event) {
          if (event.button !== 0) return
          if (event.target && event.target.closest && event.target.closest('button')) return
          const bubbleElement = event.currentTarget && event.currentTarget.closest
            ? event.currentTarget.closest('.dsab-bubble')
            : null
          if (!bubbleElement) return
          event.preventDefault()
          const startX = event.clientX
          const startY = event.clientY
          const rect = bubbleElement.getBoundingClientRect()
          const startTop = rect.top
          const startLeft = rect.left
          const maxTop = Math.max(GAP, window.innerHeight - 80)
          const maxLeft = Math.max(GAP, window.innerWidth - (item.width || bubbleWidthFor(window.innerWidth)) - GAP)
          let moved = false
          bubbleElement.classList.add('dsab-dragging')
          const move = (moveEvent) => {
            const dx = moveEvent.clientX - startX
            const dy = moveEvent.clientY - startY
            if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return
            moved = true
            const top = Math.min(Math.max(startTop + dy, GAP), maxTop)
            const left = Math.min(Math.max(startLeft + dx, GAP), maxLeft)
            state.manual = { top, left }
            bubbleElement.style.top = top + 'px'
            bubbleElement.style.left = left + 'px'
          }
          const finish = () => {
            bubbleElement.classList.remove('dsab-dragging')
            window.removeEventListener('pointermove', move, true)
            window.removeEventListener('pointerup', finish, true)
            window.removeEventListener('pointercancel', finish, true)
            if (moved) {
              bump()
              rerender()
            }
          }
          window.addEventListener('pointermove', move, true)
          window.addEventListener('pointerup', finish, true)
          window.addEventListener('pointercancel', finish, true)
        }

        async function answerApproval(outcome) {
          state.hint = ''
          try {
            await pending.answer(outcome)
          } catch {
            state.hint = t('hint.expired')
            rerender()
          }
        }

        function buildAnswers() {
          const questions = Array.isArray(pending.questions) ? pending.questions : []
          const answers = []
          for (const question of questions) {
            const draft = answerOf(state, question)
            if (draft.skipped) {
              answers.push({ id: question.id, selected: [] })
              continue
            }
            const custom = String(draft.custom || '').trim()
            const selected = Array.isArray(draft.selected) ? draft.selected : []
            if (question.multiSelect === true) {
              if (selected.length === 0 && custom === '') return null
              const entry = { id: question.id, selected: selected.slice() }
              if (custom !== '') entry.custom = custom
              answers.push(entry)
            } else if (custom !== '') {
              answers.push({ id: question.id, selected: [], custom })
            } else if (selected.length > 0) {
              answers.push({ id: question.id, selected: [selected[0]] })
            } else {
              return null
            }
          }
          return { answers }
        }

        async function submitQuestions() {
          const payload = buildAnswers()
          if (payload === null) {
            state.hint = t('hint.unanswered')
            rerender()
            return
          }
          state.hint = ''
          try {
            await pending.answer(payload)
            try {
              const snapshot = typeof pending.snapshot === 'function' ? pending.snapshot() : undefined
              if (snapshot && snapshot.channel === 'rpc' && typeof pending.dismiss === 'function') pending.dismiss()
            } catch {
              /* dismiss is best-effort */
            }
          } catch {
            state.hint = t('hint.expired')
            rerender()
          }
        }

        async function approvePlan(question) {
          const intent = question && question.intent ? question.intent : {}
          const label = typeof intent.approve === 'string' && intent.approve !== '' ? intent.approve : t('action.approve')
          state.hint = ''
          try {
            await pending.answer({ answers: [{ id: question.id, selected: [label] }] })
            try {
              const snapshot = typeof pending.snapshot === 'function' ? pending.snapshot() : undefined
              if (snapshot && snapshot.channel === 'rpc' && typeof pending.dismiss === 'function') pending.dismiss()
            } catch {
              /* ignore */
            }
          } catch {
            state.hint = t('hint.expired')
            rerender()
          }
        }

        function openSession() {
          const sessionId = item.sessionId
          let opened = false
          if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
            try {
              uiWorkspace.openSession(sessionId)
              opened = true
            } catch {
              opened = false
            }
          }
          if (!opened) {
            try {
              const row = document.querySelector('[data-row-key="session:' + sessionId + '"]')
              if (row) row.click()
            } catch {
              /* ignore */
            }
          }
          dismissedKeys.add(pending.key)
          bump()
        }

        async function translate() {
          if (state.translating) return
          const text = collectTranslatableText()
          if (text === '') return
          state.translating = true
          state.translateError = false
          rerender()
          try {
            const targetLanguage = localeId === 'zh' ? 'zh-CN' : 'en'
            const response = await fetch(TRANSLATE_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text, targetLanguage }),
            })
            const data = await response.json()
            if (data && data.ok === true && typeof data.text === 'string') state.translation = data.text
            else state.translateError = true
          } catch {
            state.translateError = true
          } finally {
            state.translating = false
            rerender()
          }
        }

        function collectTranslatableText() {
          if (kind === 'approval') return approvalText()
          if (kind === 'plan-review') {
            const question = pending.questions && pending.questions[0]
            return question ? String(question.detail || question.question || '') : ''
          }
          if (kind === 'question') {
            const question = currentQuestion()
            if (!question) return ''
            const parts = [String(question.question || '')]
            const options = Array.isArray(question.options) ? question.options : []
            for (const option of options) {
              parts.push('- ' + String(option.label || '') + (option.description ? '：' + String(option.description) : ''))
            }
            return parts.join('\n')
          }
          return ''
        }

        async function copyContent() {
          const text = collectTranslatableText()
          const payload = state.translation ? text + '\n\n' + state.translation : text
          if (payload === '') return
          const ok = await writeClipboard(payload)
          state.copyState = ok ? 'ok' : 'failed'
          rerender()
          window.setTimeout(() => {
            state.copyState = ''
            rerender()
          }, 1500)
        }

        function handleTranslateMenu() {
          void translate()
        }

        function handleCopyMenu() {
          void copyContent()
        }

        function approvalText() {
          const reason = resolveApprovalReason(pending)
          return reason !== '' ? reason : t('hint.approvalFallback', { tool: pending.toolName || '?' })
        }

        function resolveApprovalReason(approval) {
          const display = approval.displayReason
          if (display === undefined || display === null) return typeof approval.reason === 'string' ? approval.reason : ''
          if (typeof display === 'string') return display
          try {
            if (locale && typeof locale.resolveText === 'function') {
              const resolved = locale.resolveText(display)
              if (typeof resolved === 'string') return resolved
            }
          } catch {
            /* ignore */
          }
          try {
            if (typeof display.text === 'string') return display.text
          } catch {
            /* ignore */
          }
          return ''
        }

        function currentQuestion() {
          const questions = Array.isArray(pending.questions) ? pending.questions : []
          return questions[state.questionIndex] || questions[0]
        }

        function questionAnswered(question) {
          if (!question) return false
          const draft = answerOf(state, question)
          return draft.skipped || draft.selected.length > 0 || String(draft.custom || '').trim() !== ''
        }

        function toggleOption(question, option) {
          const draft = answerOf(state, question)
          const label = String(option.label || '')
          draft.skipped = false
          state.hint = ''
          if (question.multiSelect === true) {
            const index = draft.selected.indexOf(label)
            if (index >= 0) draft.selected.splice(index, 1)
            else draft.selected.push(label)
          } else {
            draft.selected = [label]
            draft.custom = ''
          }
          rerender()
        }

        function setCustom(question, value) {
          const draft = answerOf(state, question)
          draft.custom = value
          draft.skipped = false
          if (question.multiSelect !== true && value !== '') draft.selected = []
          if (state.hint !== '') state.hint = ''
          rerender()
        }

        function goNext() {
          const question = currentQuestion()
          if (question && !questionAnswered(question)) {
            state.hint = t('hint.unanswered')
            rerender()
            return
          }
          const questions = Array.isArray(pending.questions) ? pending.questions : []
          state.hint = ''
          if (state.questionIndex < questions.length - 1) {
            state.questionIndex += 1
            rerender()
          }
        }

        function goPrev() {
          state.hint = ''
          if (state.questionIndex > 0) {
            state.questionIndex -= 1
            rerender()
          }
        }

        function skipCurrent() {
          const question = currentQuestion()
          if (!question) return
          const draft = answerOf(state, question)
          draft.skipped = true
          draft.selected = []
          draft.custom = ''
          state.hint = ''
          const questions = Array.isArray(pending.questions) ? pending.questions : []
          if (state.questionIndex < questions.length - 1) {
            state.questionIndex += 1
            rerender()
          } else {
            void submitQuestions()
          }
        }

        // ---- 渲染 ----

        const children = []
        children.push(
          h(
            'div',
            { className: 'dsab-head', key: 'head', onPointerDown: startDrag, title: t('bubble.drag') },
            h('span', { className: 'dsab-dot', key: 'dot' }),
            h('span', { className: 'dsab-title', key: 'title', title: item.title }, item.title),
            h('span', { className: 'dsab-kind', key: 'kind' }, t('kind.' + (kind === 'plan-review' ? 'planReview' : kind))),
            h(
              'button',
              {
                type: 'button',
                className: 'dsab-close',
                key: 'close',
                title: t('bubble.hide'),
                'aria-label': t('bubble.hide'),
                onClick: () => {
                  dismissedKeys.add(pending.key)
                  bump()
                },
              },
              '×',
            ),
          ),
        )

        const body = []
        if (kind === 'approval') {
          body.push(h('div', { className: 'dsab-reason', key: 'reason' }, approvalText()))
        } else if (kind === 'plan-review') {
          const question = (pending.questions && pending.questions[0]) || {}
          const plan = String(question.detail || '')
          const headline = planHeadline(plan) || String(question.question || '')
          const summary = planSummary(plan)
          body.push(h('div', { className: 'dsab-eyebrow', key: 'eyebrow' }, t('kind.planReview')))
          body.push(h('div', { className: 'dsab-question', key: 'headline' }, headline))
          if (summary !== '') body.push(h('div', { className: 'dsab-reason', key: 'summary' }, summary))
          if (plan !== '') {
            body.push(
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsab-detail-toggle',
                  key: 'toggle',
                  onClick: () => {
                    state.showDetail = !state.showDetail
                    rerender()
                  },
                },
                t('action.detail'),
              ),
            )
            if (state.showDetail) body.push(h('div', { className: 'dsab-plan', key: 'plan' }, plan))
          }
        } else if (kind === 'question') {
          const questions = Array.isArray(pending.questions) ? pending.questions : []
          const question = currentQuestion()
          if (question) {
            if (question.header) body.push(h('div', { className: 'dsab-eyebrow', key: 'eyebrow' }, String(question.header)))
            body.push(h('div', { className: 'dsab-question', key: 'question' }, String(question.question || '')))
            if (question.detail) {
              body.push(
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsab-detail-toggle',
                    key: 'toggle',
                    onClick: () => {
                      state.showDetail = !state.showDetail
                      rerender()
                    },
                  },
                  t('action.detail'),
                ),
              )
              if (state.showDetail) body.push(h('div', { className: 'dsab-plan', key: 'detail' }, String(question.detail)))
            }
            const options = Array.isArray(question.options) ? question.options : []
            const draft = answerOf(state, question)
            if (options.length > 0) {
              const optionNodes = []
              for (const option of options) {
                const label = String(option.label || '')
                const cleaned = label.replace(/\s*(?:\(\s*(?:recommended|推荐)\s*\)|（\s*(?:recommended|推荐)\s*）)\s*$/i, '')
                const recommended = cleaned !== label
                const selected = draft.selected.indexOf(label) >= 0
                optionNodes.push(
                  h(
                    'button',
                    {
                      type: 'button',
                      key: 'option:' + label,
                      className: 'dsab-option' + (selected ? ' selected' : ''),
                      onClick: () => toggleOption(question, option),
                    },
                    h('span', {
                      className: 'dsab-choice' + (question.multiSelect === true ? ' multi' : ''),
                      key: 'choice',
                      'aria-hidden': true,
                    }),
                    h(
                      'span',
                      { className: 'dsab-option-text', key: 'text' },
                      h('span', { className: 'dsab-option-label' }, cleaned),
                      option.description
                        ? h('span', { className: 'dsab-option-desc' }, String(option.description))
                        : null,
                    ),
                    recommended ? h('span', { className: 'dsab-badge', key: 'badge' }, t('recommended')) : null,
                  ),
                )
              }
              body.push(h('div', { className: 'dsab-options', key: 'options' }, optionNodes))
            }
            body.push(
              h('input', {
                key: 'custom',
                className: 'dsab-input',
                type: 'text',
                value: draft.custom,
                placeholder: t('customPlaceholder'),
                onChange: (event) => setCustom(question, event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.nativeEvent?.isComposing) {
                    event.preventDefault()
                    if (state.questionIndex < questions.length - 1) goNext()
                    else void submitQuestions()
                  }
                },
              }),
            )
            if (questions.length > 1) {
              body.push(h('div', { className: 'dsab-pager', key: 'pager' },
                t('pager', { index: state.questionIndex + 1, total: questions.length })))
            }
          }
        } else {
          body.push(h('div', { className: 'dsab-reason', key: 'generic' }, t('hint.genericBody')))
        }

        if (state.hint) body.push(h('div', { className: 'dsab-hint', key: 'hint' }, state.hint))
        if (state.translation) {
          body.push(
            h(
              'div',
              { className: 'dsab-trans', key: 'trans' },
              h('span', { className: 'dsab-trans-label', key: 'label' }, t('label.translation')),
              state.translation,
            ),
          )
        }
        if (state.translateError) body.push(h('div', { className: 'dsab-hint error', key: 'transError' }, t('hint.translateFailed')))
        if (state.copyState) {
          body.push(h('div', { className: 'dsab-hint', key: 'copy' }, t(state.copyState === 'ok' ? 'hint.copied' : 'hint.copyFailed')))
        }

        const actions = []
        if (kind === 'approval') {
          actions.push(h('button', { type: 'button', key: 'reject', className: 'dsab-btn danger', onClick: () => void answerApproval('rejected') }, t('action.reject')))
          actions.push(h('button', { type: 'button', key: 'allow', className: 'dsab-btn primary', onClick: () => void answerApproval('allowed-once') }, t('action.allowOnce')))
        } else if (kind === 'plan-review') {
          const question = (pending.questions && pending.questions[0]) || {}
          actions.push(h('button', { type: 'button', key: 'open', className: 'dsab-link', onClick: openSession }, t('action.openSession')))
          actions.push(h('button', { type: 'button', key: 'approve', className: 'dsab-btn primary', onClick: () => void approvePlan(question) }, t('action.approve')))
        } else if (kind === 'question') {
          const questions = Array.isArray(pending.questions) ? pending.questions : []
          if (state.questionIndex > 0) actions.push(h('button', { type: 'button', key: 'prev', className: 'dsab-link', onClick: goPrev }, t('action.prev')))
          actions.push(h('button', { type: 'button', key: 'skip', className: 'dsab-link', onClick: skipCurrent }, t('action.skip')))
          if (state.questionIndex < questions.length - 1) {
            actions.push(h('button', { type: 'button', key: 'next', className: 'dsab-btn primary', onClick: goNext }, t('action.next')))
          } else {
            actions.push(h('button', { type: 'button', key: 'submit', className: 'dsab-btn primary', onClick: () => void submitQuestions() }, t('action.submit')))
          }
        } else {
          actions.push(h('button', { type: 'button', key: 'open', className: 'dsab-link', onClick: openSession }, t('action.openSession')))
        }

        const tools = []
        if (kind !== 'generic') {
          tools.push(h('button', { type: 'button', key: 'translate', className: 'dsab-link', onClick: handleTranslateMenu, disabled: state.translating }, state.translating ? t('hint.translating') : t('action.translate')))
          tools.push(h('button', { type: 'button', key: 'copy', className: 'dsab-link', onClick: handleCopyMenu }, t('action.copy')))
        }

        children.push(h('div', { className: 'dsab-body', key: 'body' }, body))
        children.push(
          h('div', { className: 'dsab-foot', key: 'foot' },
            h('div', { className: 'dsab-tools', key: 'tools' }, tools),
            h('div', { className: 'dsab-btns', key: 'btns' }, actions),
          ),
        )

        return h(
          'div',
          {
            className: 'dsab-bubble',
            'data-dsh-approval-bubble': 'bubble',
            'data-kind': kind,
            'data-key': pending.key,
            style: { top: item.top + 'px', left: item.left + 'px', width: item.width + 'px' },
            ref: props.registerElement,
            role: 'dialog',
            'aria-label': t('kind.' + (kind === 'plan-review' ? 'planReview' : kind)),
            onPointerDown: (event) => event.stopPropagation(),
            onClick: (event) => event.stopPropagation(),
          },
          children,
        )
      }

      ctx.slots.inject('sidebar.workspaces.session.row.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.row.action',
            id: 'approval-bubble-anchor',
            order: 400,
          },
          Anchor,
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'approval-bubble-layer',
            order: 400,
          },
          Layer,
        ),
      )

      // 自检探针：证明浏览器侧确实加载并执行了本插件（失败静默，不影响功能）。
      window.setTimeout(() => {
        report({ event: 'apply', locale: activeLocaleId(), slots: 'anchor,overlay' })
      }, 800)
    }

    return {
      inject: ['slots', 'uiSession', 'sessions', 'locale'],
      apply,
    }
  },
})
