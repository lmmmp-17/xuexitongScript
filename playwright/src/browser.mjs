/* ------------------------------------------------------------------
 * 浏览器接入
 *
 * 两种模式，默认用第一种：
 *
 * 1. connect（推荐）：连接到你自己启动的 Chrome。
 *    浏览器是你平时用的那一个——真实 profile、真实登录态、真实扩展列表，
 *    navigator.webdriver 为 false，没有 --enable-automation 带来的那一串特征。
 *    Playwright 只是通过 CDP 接管输入，不参与浏览器的启动。
 *
 * 2. launch：让脚本自己拉起 Chrome。
 *    方便，但 Playwright 默认会带上 --enable-automation 等参数，所以这里显式
 *    去掉它们并关掉 AutomationControlled，同时坚持用本机真实 Chrome
 *    （channel: 'chrome'）和持久化 profile，而不是 bundled Chromium + 临时目录。
 *    即便如此，它在特征上仍然不如模式 1，所以只作为备选。
 *
 * 两种模式都不跑 headless：无头浏览器的特征面比自动化标志本身还大。
 * ------------------------------------------------------------------ */
import { resolve } from 'node:path';
import { isAllowedUrl } from './selectors.mjs';
import { chromeLaunchHint } from './platform.mjs';

async function loadPlaywright() {
    try {
        return await import('playwright-core');
    } catch (e) {
        const error = new Error(
            '未找到 playwright-core。在 playwright/ 目录下执行 npm install 即可（它不会下载浏览器，直接用你本机的 Chrome）。'
        );
        error.cause = e;
        throw error;
    }
}

/* 启动参数单独拎出来，便于断言——这几项都不是随手写的：
 *   headless: false   无头浏览器的特征面比自动化标志本身还大，UA 里直接带
 *                     HeadlessChrome，还缺一堆真实窗口才有的东西
 *   channel: 'chrome' 用本机真实 Chrome，而不是 Playwright 自带的 Chromium
 *   ignoreDefaultArgs 去掉 Playwright 默认加的 --enable-automation
 *   AutomationControlled 关掉之后 navigator.webdriver 才是 false
 *   viewport: null    跟随真实窗口尺寸，不要那个固定的 1280x720
 */
export function launchOptions({ mute = true } = {}) {
    return {
        channel: 'chrome',
        headless: false,
        viewport: null,
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        ignoreDefaultArgs: ['--enable-automation', '--disable-component-update'],
        args: [
            '--disable-blink-features=AutomationControlled',
            '--start-maximized',
            /* 自己启动的专用 profile 顺手在浏览器这一层也静音: 页面读不到它
             * (muted / volume 都不变), 只是声音不送到声卡。Playwright 只在
             * 无头模式才默认带这一项。connect 模式管不到启动参数, 靠播放器上的静音。 */
            ...(mute ? ['--mute-audio'] : []),
        ],
    };
}

export async function openBrowser(config, log) {
    const { chromium } = await loadPlaywright();

    if (config.mode === 'launch') {
        /* profile 目录按绝对路径传，不然换个工作目录就换了一个 profile */
        const profileDir = resolve(config.profileDir);
        log.say(`启动本机 Chrome，profile: ${profileDir}`);
        const context = await chromium.launchPersistentContext(profileDir, launchOptions({ mute: config.mute }));
        /* Playwright 的默认操作超时是“不限”，元素一直不出现就会无声地挂住 */
        context.setDefaultTimeout(config.actionTimeoutMs);
        return {
            context,
            owned: true,
            async close() {
                await context.close();
            },
        };
    }

    const endpoint = `http://127.0.0.1:${config.cdpPort}`;
    log.say(`连接已在运行的 Chrome: ${endpoint}`);
    let browser;
    try {
        browser = await chromium.connectOverCDP(endpoint);
    } catch (e) {
        throw new Error(
            `连不上 ${endpoint}。请先这样启动一个可被接管的 Chrome：\n\n` +
            `  ${chromeLaunchHint(config.cdpPort)}\n\n` +
            '注意：如果 Chrome 已经在运行，直接加 --remote-debugging-port 是不会生效的——\n' +
            '参数会被转交给已有实例，端口上什么都没有。上面的命令用了一个独立的 profile\n' +
            '目录来绕开这一点，第一次需要在里面登录一次学习通。\n' +
            '然后在那个窗口里打开课程播放页，再重新运行本脚本。'
        );
    }
    const context = browser.contexts()[0];
    if (!context) throw new Error('这个 Chrome 实例里没有可用的浏览上下文');
    context.setDefaultTimeout(config.actionTimeoutMs);
    return {
        context,
        browser,
        owned: false,
        /* 不是我们启动的浏览器就只断开连接，不去关别人的窗口 */
        async close() {
            await browser.close();
        },
    };
}

/* 优先接管已经打开的课程页；没有就按 --url 开一个 */
export async function pickCoursePage(context, config, log) {
    const pages = context.pages();
    const opened = pages.find((page) => /\/mycourse\/studentstudy/.test(page.url()));
    if (opened) {
        log.say(`接管已打开的课程页: ${opened.url()}`);
        await opened.bringToFront();
        return opened;
    }

    if (!config.url) {
        const hint = pages.map((page) => page.url()).filter(Boolean).slice(0, 5);
        throw new Error(
            '没有找到打开着的课程播放页。要么先在浏览器里打开它，要么用 --url <课程页地址> 指定。' +
            (hint.length ? `\n当前标签页：\n  ${hint.join('\n  ')}` : '')
        );
    }

    if (!isAllowedUrl(config.url)) {
        throw new Error(`--url 必须是 chaoxing.com 下的地址，拿到的是: ${config.url}`);
    }

    const page = pages.find((item) => item.url() === 'about:blank') || await context.newPage();
    log.say(`打开课程页: ${config.url}`);
    await page.bringToFront();
    await page.goto(config.url, { waitUntil: 'domcontentloaded' });
    return page;
}
