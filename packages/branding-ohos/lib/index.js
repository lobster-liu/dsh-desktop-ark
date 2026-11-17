/**
 * `@dsh-ohos/branding` —— DSH Desktop 品牌位的 **Host 半边**。
 *
 * 只做两件上游留了官方口子的事（上游源码零改动）：
 *   1) 页面标题：上游 `apps/web/index.html` 写死 `<title>DSH Local Build</title>`，
 *      用 `webServer.tapIndex()`（结构化注入行表达不了的原始 HTML 变换口）改成产品名；
 *      ArkWeb 的窗口标题取 `document.title`，所以这是「标题」对外的实际落点。
 *   2) hero 标语：上游会话空态把 `t('hero.headline')`（"探索未至之境" / "Into the Unknown"）
 *      与 Preview 徽标**写死在组件里**，既没有槽位也不能用 locale 覆盖（`locale.register`
 *      对同一 (命名空间, 语言) 只允许一个占用者，会抛错）。因此用 `webserver/index-inject`
 *      的 `style` 行下发一条**以我们品牌位标记为锚点**的规则：只有本产品的品牌位真的画出来
 *      （浏览器半边装上了），上游标语才被隐藏；品牌位没装上时规则不匹配，界面退回上游原样。
 *
 * 边界：不改上游源码、不伪造上游开关、不动 DeepSeek 账号/推理等业务身份；
 * 上游的版权与 MIT 归属说明照旧保留（见包 README）。
 */

/** Cordis 插件名（与 bundle 行 id 一致）。 */
export const name = 'branding-ohos'

/** 只依赖 webServer：两处都是它的服务口。 */
export const inject = ['webServer']

/** 产品名（与 `AppScope/resources/base/element/string.json` 的 `app_name` 同源）。 */
export const PRODUCT_TITLE = 'DSH Desktop'

/** 审计标记：出现在下发的样式里，便于对账。 */
export const BRAND_MARKER = 'DSH_OHOS_BRANDING'

/** hero 品牌位标记属性：只有浏览器半边的 hero 占用者带它，CSS 以它为锚点。 */
export const HERO_ATTR = 'data-dsh-ohos-hero'

/**
 * hero 品牌位的替换规则。
 *
 * 结构（上游 `ui-conversation` 的 EmptyHero，rc.5 实测 DOM）：
 *   `div.headline > div[data-slot="conversation.hero.brand.mark"]（display:contents）> span[data-dsh-ohos-hero]`
 *   `div.headline > span.titleGroup`（标语 + Preview 徽标）
 * rc.5 把品牌槽位从「`span.fishHitbox` 包裹」改成「`div[data-slot]` 直挂 headline」
 * （`display: contents`），所以旧选择器 `:has(> span > [data-slot] …)` 不再命中；
 * 现同时接受 直挂 div / div 内嵌 / span 包裹 三种形态，兼容新旧两种渲染。
 * 上游若改动 hero 结构，规则会**不匹配**（标语恢复原样），不会误伤别的元素 ——
 * 由 `specs/205-plugin-branding` 的回归用例兜住。
 */
export const HERO_CSS = `/* ${BRAND_MARKER}: 上游 hero 标语/Preview 徽标由本产品品牌位接管 */
div:has(> [data-slot="conversation.hero.brand.mark"][${HERO_ATTR}], > [data-slot="conversation.hero.brand.mark"] [${HERO_ATTR}], > span > [data-slot="conversation.hero.brand.mark"] [${HERO_ATTR}]) > span:not(:has([${HERO_ATTR}])){display:none !important}
`

/** 首个 `<title>…</title>`（容忍上游改写模板的缩进与内容）。 */
const TITLE_PATTERN = /<title>[\s\S]*?<\/title>/i

/**
 * 登录桥接标记：注入脚本里带它，二次注入可短路。
 */
export const LOGIN_BRIDGE_MARKER = 'dsh-ohos-login-bridge'

/**
 * 登录桥接脚本 —— **不注入 `dshDesktop`**，让 `ui-settings-account` 走网页分支。
 *
 * 两条分支的差别（`ui-settings-account` 的 `start()`）：
 *   - 有 `dshDesktop`：只调 `account/startSignIn`，拿到的 `authorizeUrl` 交给**外壳**开窗
 *     （Electron 的 `openExternal`）。ArkWeb 外壳没有这一步，界面会停在「复制登录链接」。
 *   - 没有 `dshDesktop`：`BrowserLogin.begin()` 先 `window.open('about:blank', '_blank')`
 *     占位，随后 `popup.location.replace(authorizeUrl)` 把授权页导航进那个标签页。
 *
 * ArkWeb 没有系统标签栏，`window.open` 在非用户手势/跨进程场景下返回 null，登录随即
 * 失败（「操作未完成，请重试」）。这里把 `window.open` 换成**同页导航垫片**：占位返回
 * 一个假 popup 对象，它的 `location.replace/assign/href` 统统把地址落到当前窗口；
 * 当前窗口的 `onLoadIntercept` 判定 `https://` 为外链并交给系统浏览器打开，平台跳回的
 * `http://127.0.0.1:<port>/oauth/callback` 与 Host 同机，回调直达 Host 完成登录。
 *
 * 只桥接这一处：垫片不改变「外链一律出系统浏览器」的既有围栏，也不替上游伪造别的能力。
 */
const LOGIN_BRIDGE_SCRIPT = `<script>/* ${LOGIN_BRIDGE_MARKER} */(function(){
  if (globalThis.__dshOhosLoginBridge) return;
  globalThis.__dshOhosLoginBridge = true;
  const navigate = (url) => {
    const target = String(url == null ? '' : url);
    if (target === '' || target === 'about:blank') return;
    try { location.href = target } catch (error) {}
  };
  const makePopup = () => ({
    closed: false,
    opener: null,
    focus() {},
    blur() {},
    close() { this.closed = true },
    location: {
      replace: navigate,
      assign: navigate,
      get href() { return 'about:blank' },
      set href(url) { navigate(url) },
    },
  });
  window.open = function () { return makePopup() };
  globalThis.__DSH_TRANSPORT__ = globalThis.__DSH_TRANSPORT__ || { streamBaseUrl: location.origin };
})();</script>`

/**
 * 把页面标题换成产品名，并注入登录桥接。已是目标状态时原样返回（幂等）。
 * @param {string} html - 上游返回的 index.html 文本。
 * @returns {string} 替换后的文本；模板里没有 `<title>` 时原样返回。
 */
export function replacePageTitle(html) {
  const replacement = `<title>${PRODUCT_TITLE}</title>`
  const withTitle = html.includes(replacement)
    ? html
    : TITLE_PATTERN.test(html) ? html.replace(TITLE_PATTERN, replacement) : html
  return withLoginBridge(withTitle)
}

/**
 * 在 `</head>` 前注入登录桥接脚本。
 *
 * 必须在页面脚本之前执行：`ui-settings-account` 在插件装载时就决定走哪条登录分支，
 * 并读取 `window.open`。内联 `<script>` 放在 `</head>` 前，早于所有 `type="module"` 入口。
 *
 * `__DSH_TRANSPORT__.streamBaseUrl` 取当前页 origin：本产品 Host 与页面同源
 * （`http://127.0.0.1:<port>`），登录回调要回到这个 origin 才能命中 `/oauth/callback`。
 *
 * @param {string} html - 含 `<head>` 的页面文本。
 * @returns {string} 注入后的文本；已有标记或没有 `<head>` 时原样返回。
 */
export function withLoginBridge(html) {
  if (html.includes(LOGIN_BRIDGE_MARKER)) return html
  const headEnd = /<\/head>/i
  return headEnd.test(html) ? html.replace(headEnd, `${LOGIN_BRIDGE_SCRIPT}</head>`) : `${LOGIN_BRIDGE_SCRIPT}${html}`
}

/**
 * 安装两处品牌位注入。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 带 `webServer` 服务的插件上下文。
 * @returns {void}
 */
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.tapIndex(replacePageTitle), 'branding-ohos: page title')
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'style', text: HERO_CSS })
  })
}
