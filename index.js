/**
 * dsh-approval-bubble —— Host half.
 *
 * 唯一职责：为客户端气泡提供一个同源翻译路由（浏览器端直接调匿名翻译端点会被
 * CORS / CSP 拦掉，所以翻译必须经过 Host）。回答审批 / 选择题 / 计划确认全部
 * 在客户端完成，Host 不持有待交互对象，也不写会话日志。
 *
 * 路由放在私有前缀下（/api 由连接层保留），并沿用本机 profile 的鉴权口径：
 *   - 无 Origin（同源 fetch / 本地进程）→ 放行
 *   - Origin 为 dsh-app://app（桌面端渲染进程）→ 放行
 *   - Origin 与请求 Host 同源 → 放行
 *   - 其余一律 403，挡住网页对 localhost 的 CSRF。
 */

const ROUTE_TRANSLATE = '/dsh-approval-bubble/translate'
const ROUTE_PING = '/dsh-approval-bubble/ping'
const MAX_BODY_BYTES = 64 * 1024
const MAX_TEXT_CHARS = 2000
const TRANSLATE_TIMEOUT_MS = 15000
const DEFAULT_TARGET = 'zh-CN'

/** @type {string[]} */
export const inject = ['webServer']

function textOf(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  try {
    return String(value)
  } catch {
    return ''
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        done('')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => done(''))
    req.on('aborted', () => done(''))
  })
}

function authorized(req) {
  const origin = textOf(req.headers.origin)
  if (origin === '') return true
  if (origin === 'dsh-app://app') return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/** 界面语言（zh-* / en-*）→ 翻译目标语言。 */
function targetLanguageOf(value) {
  const raw = textOf(value).trim()
  if (!raw) return DEFAULT_TARGET
  const lower = raw.toLowerCase()
  if (lower.startsWith('zh')) return lower.includes('tw') || lower.includes('hk') || lower.includes('hant') ? 'zh-TW' : 'zh-CN'
  if (lower.startsWith('en')) return 'en'
  return raw
}

/** 简体/繁体标签映射到匿名端点各自接受的形式。 */
function bingTargetOf(target) {
  const lower = target.toLowerCase()
  if (lower.startsWith('zh')) {
    return lower.includes('tw') || lower.includes('hk') || lower.includes('hant') ? 'zh-Hant' : 'zh-Hans'
  }
  return target
}

function googleTargetOf(target) {
  const lower = target.toLowerCase()
  if (lower.startsWith('zh')) {
    return lower.includes('tw') || lower.includes('hk') || lower.includes('hant') ? 'zh-TW' : 'zh-CN'
  }
  return target
}

function safeMessage(error) {
  const message = textOf((error && error.message) || error)
  return message.slice(0, 300)
}

async function fetchJson(url, init, signal) {
  const response = await fetch(url, { ...init, signal, redirect: 'error', credentials: 'omit' })
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`)
  return await response.json()
}

/** 直连微软 Edge 匿名翻译端点（本机实测可达；Google 端点在国内常被阻断）。 */
async function translateViaBingDirect(text, target, signal) {
  const url =
    'https://edge.microsoft.com/translate/translatetext?from=&to=' + encodeURIComponent(bingTargetOf(target))
  const data = await fetchJson(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([text]),
    },
    signal,
  )
  const first = Array.isArray(data) ? data[0] : undefined
  const translated = first && Array.isArray(first.translations) ? first.translations[0] : undefined
  const result = translated && typeof translated.text === 'string' ? translated.text : ''
  if (!result) throw new Error('empty translation from bing endpoint')
  return result
}

/** 兜底：Google gtx 匿名端点（可能被网络阻断，仅在前两者都不可用时尝试）。 */
async function translateViaGoogleDirect(text, target, signal) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
    encodeURIComponent(googleTargetOf(target)) +
    '&dt=t&q=' +
    encodeURIComponent(text)
  const data = await fetchJson(url, { method: 'GET' }, signal)
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('unexpected google response')
  const joined = data[0]
    .map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : ''))
    .join('')
  if (!joined) throw new Error('empty translation from google endpoint')
  return joined
}

/**
 * 翻译一段文本：优先宿主 translator 服务（Bing 默认、免 key），
 * 服务未挂载或失败时直连匿名端点兜底。返回 { text, provider }。
 */
async function translateText(ctx, text, targetLanguage) {
  const translator = ctx.get('translator')
  if (translator && typeof translator.resolve === 'function' && typeof translator.translate === 'function') {
    try {
      const spec = translator.resolve({ text, targetLanguage, provider: 'bing' })
      const result = await translator.translate(spec, AbortSignal.timeout(TRANSLATE_TIMEOUT_MS))
      if (typeof result === 'string' && result !== '') return { text: result, provider: 'translator:bing' }
    } catch {
      // 服务未配置 / 网络失败 / 超限 → 继续直连兜底
    }
  }

  try {
    const result = await translateViaBingDirect(text, targetLanguage, AbortSignal.timeout(TRANSLATE_TIMEOUT_MS))
    return { text: result, provider: 'bing' }
  } catch (bingError) {
    try {
      const result = await translateViaGoogleDirect(text, targetLanguage, AbortSignal.timeout(TRANSLATE_TIMEOUT_MS))
      return { text: result, provider: 'google' }
    } catch {
      throw new Error(`translation unavailable: ${safeMessage(bingError)}`)
    }
  }
}

export function apply(ctx) {
  // 客户端半加载探针：页面里的 client.js 会上报 apply / 槽位挂载 / 气泡渲染次数，
  // 用于确认浏览器侧真的加载了本插件（没有浏览器自动化时这是唯一可观测的证据）。
  const clientState = {
    applyCount: 0,
    layerMounts: 0,
    anchors: [],
    bubbles: 0,
    bubbleKinds: '',
    lastEvent: '',
    lastAt: 0,
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PING,
      handler: async (req, res) => {
        if (!authorized(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        if (req.method === 'POST') {
          const body = await readBody(req, MAX_BODY_BYTES)
          let payload = {}
          try {
            payload = JSON.parse(body || '{}')
          } catch {
            payload = {}
          }
          const event = textOf(payload.event).slice(0, 40)
          clientState.lastEvent = event
          clientState.lastAt = Date.now()
          if (event === 'apply') clientState.applyCount += 1
          else if (event === 'layer') clientState.layerMounts += 1
          else if (event === 'anchor') {
            const sessionId = textOf(payload.sessionId).slice(0, 80)
            if (sessionId && clientState.anchors.indexOf(sessionId) < 0 && clientState.anchors.length < 50) {
              clientState.anchors.push(sessionId)
            }
          } else if (event === 'bubbles') {
            clientState.bubbles = Number(payload.count) || 0
            clientState.bubbleKinds = textOf(payload.kinds).slice(0, 100)
          }
          sendJson(res, 200, { ok: true })
          return
        }
        sendJson(res, 200, {
          ok: true,
          version: '1.0.0',
          clientSeen: clientState.applyCount > 0,
          applyCount: clientState.applyCount,
          layerMounts: clientState.layerMounts,
          anchorCount: clientState.anchors.length,
          anchors: clientState.anchors,
          bubbles: clientState.bubbles,
          bubbleKinds: clientState.bubbleKinds,
          lastEvent: clientState.lastEvent,
          lastAt: clientState.lastAt,
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_TRANSLATE,
      handler: async (req, res) => {
        if (!authorized(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }

        const body = await readBody(req, MAX_BODY_BYTES)
        let payload
        try {
          payload = JSON.parse(body || '{}')
        } catch {
          sendJson(res, 400, { ok: false, error: 'bad-json' })
          return
        }

        const text = textOf(payload && payload.text).slice(0, MAX_TEXT_CHARS)
        if (text.trim() === '') {
          sendJson(res, 400, { ok: false, error: 'empty-text' })
          return
        }

        const targetLanguage = targetLanguageOf(payload && payload.targetLanguage)
        try {
          const translated = await translateText(ctx, text, targetLanguage)
          sendJson(res, 200, { ok: true, text: translated.text, provider: translated.provider, targetLanguage })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: 'translate-failed', message: safeMessage(error) })
        }
      },
    }),
  )
}
