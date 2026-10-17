#!/usr/bin/env node
/* ------------------------------------------------------------------
 * 入口
 * Ctrl+C 只停自己的循环，不会去关你的浏览器窗口。
 * ------------------------------------------------------------------ */
import { parseArgs, helpText } from './src/config.mjs';
import { createLogger } from './src/logger.mjs';
import { openBrowser, pickCoursePage } from './src/browser.mjs';
import { createPointer } from './src/pointer.mjs';
import { CourseRunner } from './src/course.mjs';
import { collectFingerprint, probeTrustedInput, formatReport } from './src/diagnose.mjs';
import { hardenFocus, noteOnVisibility } from './src/environment.mjs';
import { inspectPage } from './src/inspect.mjs';
import { isAllowedUrl } from './src/selectors.mjs';
import { ensureInstalled } from './src/setup.mjs';

async function main() {
    const { config, check, inspect, help, setup } = parseArgs(process.argv.slice(2));
    if (help) {
        console.log(helpText);
        return 0;
    }

    const log = createLogger(config.logLevel);
    /* 第一次运行（或 --setup）先把依赖装上，用户不用单独执行 npm install */
    ensureInstalled(log, { force: setup });

    const session = await openBrowser(config, log);
    let runner = null;
    /* 等用户打开课程页的时候还没有 runner，Ctrl+C 要能直接退出 */
    const abort = { stopped: false };

    const shutdown = () => {
        abort.stopped = true;
        if (runner) runner.stop('收到中断信号');
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
        /* 等课程页的时候按了 Ctrl+C：正常退出，不当成错误 */
        const page = await pickCoursePage(session.context, config, log, abort).catch((error) => {
            if (abort.stopped) return null;
            throw error;
        });
        if (!page) {
            log.say('已退出');
            return 0;
        }
        if (!isAllowedUrl(page.url())) {
            throw new Error(`当前页面不在 chaoxing.com 域名下，已停止：${page.url()}`);
        }
        const pointer = createPointer(page);

        /* 焦点模拟要在跑流程之前装好，这样整段播放期间都不会有 blur */
        const focus = await hardenFocus(page, log);

        if (inspect) {
            const report = await inspectPage(page, {
                /* 把指针移进播放器, 再补一次 1px 移动迫使浏览器重新命中测试 */
                hoverPlayer: async (frame, selector) => {
                    const box = await frame.locator(selector).first().boundingBox();
                    if (!box) return;
                    await pointer.moveTo({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
                    await page.mouse.move(Math.round(pointer.state.x) + 1, Math.round(pointer.state.y));
                    pointer.state.x += 1;
                    await new Promise((done) => setTimeout(done, 800));
                },
            });
            console.log(report);
            return 0;
        }

        if (check) {
            const fingerprint = await collectFingerprint(page);
            const probe = await probeTrustedInput(page, pointer);
            console.log(formatReport(fingerprint, probe, focus));
            console.log(noteOnVisibility());
            console.log('');
            return probe && probe.isTrusted ? 0 : 1;
        }

        if (focus.applied.length > 0) {
            log.say('窗口可以放到后面去，失焦不会再打断播放。别在同一个窗口里把课程页切成后台标签。');
        }

        runner = new CourseRunner({ page, pointer, config, log });
        try {
            await runner.run();
        } catch (error) {
            /* 切节、等待这些步骤里课程页被关掉时报一句人话, 不甩一串 Playwright 错误 */
            if (page.isClosed()) {
                log.warn('课程页被关闭了，已停下。重新打开课程页后再运行即可。');
                return 1;
            }
            throw error;
        }
        return 0;
    } finally {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        /* close() 里已经区分了“自己启动的要关掉”和“连上去的只断开” */
        await session.close();
        if (session.launchedChrome) {
            log.say('专用 Chrome 还开着（登录状态保存在里面）。用完请关掉它：调试端口开着时，本机任何程序都能控制它。');
        }
    }
}

main().then(
    (code) => process.exit(code ?? 0),
    (error) => {
        console.error(`\n${error.message}`);
        if (process.env.DEBUG) console.error(error);
        process.exit(1);
    }
);
