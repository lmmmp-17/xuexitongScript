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
import { isAllowedUrl } from './src/selectors.mjs';

async function main() {
    const { config, check, help } = parseArgs(process.argv.slice(2));
    if (help) {
        console.log(helpText);
        return 0;
    }

    const log = createLogger(config.logLevel);
    const session = await openBrowser(config, log);
    let runner = null;

    const shutdown = () => {
        if (runner) runner.stop('收到中断信号');
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
        const page = await pickCoursePage(session.context, config, log);
        if (!isAllowedUrl(page.url())) {
            throw new Error(`当前页面不在 chaoxing.com 域名下，已停止：${page.url()}`);
        }
        const pointer = createPointer(page);

        /* 焦点模拟要在跑流程之前装好，这样整段播放期间都不会有 blur */
        const focus = await hardenFocus(page, log);

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
        await runner.run();
        return 0;
    } finally {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        /* close() 里已经区分了“自己启动的要关掉”和“连上去的只断开” */
        await session.close();
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
