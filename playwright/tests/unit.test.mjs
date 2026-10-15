/* 不需要浏览器的部分：随机化、轨迹几何、参数解析、流程决策 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { human } from '../src/human.mjs';
import { createPointer } from '../src/pointer.mjs';
import { parseArgs, defaults } from '../src/config.mjs';
import { isAllowedUrl } from '../src/selectors.mjs';
import { CourseRunner } from '../src/course.mjs';
import { createLogger } from '../src/logger.mjs';
import { chromeLaunchHint, describePlatform } from '../src/platform.mjs';
import { launchOptions } from '../src/browser.mjs';

const silent = createLogger('silent');

test('等待时长会抖动，不落在同一个值上', () => {
    const values = new Set();
    for (let i = 0; i < 40; i += 1) values.add(human.ms(1000));
    assert.ok(values.size > 15, `应当分散，实际只有 ${values.size} 种`);
    assert.equal([...values].every((ms) => ms === 1000), false);

    const ranged = new Set();
    for (let i = 0; i < 40; i += 1) ranged.add(human.ms([200, 400]));
    assert.ok([...ranged].every((ms) => ms >= 200 && ms <= 400), '区间形式不应越界');
});

test('落点集中在元素中部且不是几何正中心', () => {
    const page = { viewportSize: () => ({ width: 1280, height: 800 }), mouse: {} };
    const pointer = createPointer(page);
    const box = { x: 100, y: 200, width: 200, height: 40 };
    const points = Array.from({ length: 60 }, () => pointer.aimAt(box));
    assert.ok(points.every((p) => p.x > 100 && p.x < 300 && p.y > 200 && p.y < 240), '落点必须在元素内');
    assert.ok(points.some((p) => Math.round(p.x) !== 200 || Math.round(p.y) !== 220), '不应总是正中心');
    const avgX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    assert.ok(Math.abs(avgX - 200) < 22, `均值应当靠近中心，实际 ${avgX.toFixed(1)}`);
});

test('指针轨迹是曲线、起步慢、终点精确', async () => {
    const moves = [];
    const page = {
        viewportSize: () => ({ width: 1440, height: 900 }),
        mouse: { move: (x, y) => moves.push({ x, y }) },
    };
    const pointer = createPointer(page, { x: 100, y: 100 });
    await pointer.moveTo({ x: 900, y: 600 });

    assert.ok(moves.length >= 6, '应当有多个采样点');
    assert.deepEqual(moves.at(-1), { x: 900, y: 600 }, '终点必须精确命中');

    /* 直线会让每一点都落在同一条斜率上 */
    const slope = (600 - 100) / (900 - 100);
    const offLine = moves.filter((p) => Math.abs((p.y - 100) - slope * (p.x - 100)) > 2);
    assert.ok(offLine.length > 0, '轨迹不应是直线');

    /* 缓入：第一步的位移应当小于中段某一步 */
    const first = Math.hypot(moves[0].x - 100, moves[0].y - 100);
    const mid = Math.hypot(
        moves[Math.floor(moves.length / 2)].x - moves[Math.floor(moves.length / 2) - 1].x,
        moves[Math.floor(moves.length / 2)].y - moves[Math.floor(moves.length / 2) - 1].y,
    );
    assert.ok(first < mid, `起步应当比中段慢（${first.toFixed(1)} vs ${mid.toFixed(1)}）`);
});

test('参数解析：支持区间外的覆盖、拒绝错误输入', () => {
    assert.equal(parseArgs([]).config.mode, 'connect', '默认走 connect');
    assert.equal(defaults.playbackRate, 1, '默认不改倍速');

    const parsed = parseArgs(['--launch', '--cdp-port=9444', '--max-sections', '2', '--no-idle-activity']);
    assert.equal(parsed.config.mode, 'launch');
    assert.equal(parsed.config.cdpPort, 9444);
    assert.equal(parsed.config.maxSections, 2);
    assert.equal(parsed.config.idleActivity, false);

    assert.throws(() => parseArgs(['--nope']), /无法识别的参数: --nope/);
    assert.throws(() => parseArgs(['--cdp-port', 'abc']), /需要是数字/);
    assert.throws(() => parseArgs(['--mode', 'weird']), /只能是 connect 或 launch/);
});

test('只接受 chaoxing.com 的地址', () => {
    assert.equal(isAllowedUrl('https://mooc1.chaoxing.com/mycourse/studentstudy?x=1'), true);
    assert.equal(isAllowedUrl('https://chaoxing.com/a'), true);
    assert.equal(isAllowedUrl('https://evil-chaoxing.com.attacker.net/a'), false);
    assert.equal(isAllowedUrl('https://notchaoxing.com/a'), false);
    assert.equal(isAllowedUrl('file:///etc/passwd'), false);
    assert.equal(isAllowedUrl('不是地址'), false);
});

test('平台提示用的是独立 profile 目录', () => {
    const hint = chromeLaunchHint(9222);
    assert.match(hint, /--remote-debugging-port=9222/);
    assert.match(hint, /--user-data-dir/);
    assert.ok(describePlatform().length > 0);
});

/* 用假 page 验证切节决策，不需要浏览器 */
function fakePage(tree) {
    const clicked = [];
    return {
        clicked,
        locator(selector) {
            const chain = [selector];
            const self = {
                nth(index) { chain.push(`nth(${index})`); return self; },
                locator(next) { chain.push(next); return self; },
                first() { chain.push('first'); return self; },
                async count() { return 1; },
                async boundingBox() { return { x: 10, y: 60, width: 180, height: 30 }; },
                async isVisible() { return true; },
                async textContent() { return ''; },
                chain,
            };
            return self;
        },
        async evaluate(fn, arg) {
            void fn;
            void arg;
            return tree;
        },
    };
}

test('切节：同章有下一节就点它', async () => {
    const tree = {
        chapters: [{ chapterIndex: 0, sections: [
            { chapterIndex: 0, sectionIndex: 0, title: '1.1', active: true },
            { chapterIndex: 0, sectionIndex: 1, title: '1.2', active: false },
        ] }],
        current: { chapterIndex: 0, sectionIndex: 0, title: '1.1', active: true },
        total: 2,
    };
    const page = fakePage(tree);
    const picked = [];
    const runner = new CourseRunner({
        page,
        pointer: { async click(locator) { picked.push(locator.chain.join(' > ')); } },
        config: { ...defaults, sectionLoadMs: [1, 2] },
        log: silent,
    });
    assert.equal(await runner.gotoNextSection(), true);
    assert.match(picked[0], /nth\(0\).*nth\(1\)/, `应当点同章的第二节，实际: ${picked[0]}`);
});

test('切节：本章放完跳到下一章第一节，没有下一章就收尾', async () => {
    const base = (currentChapter) => ({
        chapters: [
            { chapterIndex: 0, sections: [{ chapterIndex: 0, sectionIndex: 0, title: '1.1', active: currentChapter === 0 }] },
            { chapterIndex: 1, sections: [{ chapterIndex: 1, sectionIndex: 0, title: '2.1', active: currentChapter === 1 }] },
        ],
        current: { chapterIndex: currentChapter, sectionIndex: 0, title: '', active: true },
        total: 2,
    });

    const picked = [];
    const runner = new CourseRunner({
        page: fakePage(base(0)),
        pointer: { async click(locator) { picked.push(locator.chain.join(' > ')); } },
        config: { ...defaults, sectionLoadMs: [1, 2] },
        log: silent,
    });
    assert.equal(await runner.gotoNextSection(), true);
    assert.match(picked[0], /nth\(1\)/, '应当跨到第二章');

    const last = new CourseRunner({
        page: fakePage(base(1)),
        pointer: { async click() { throw new Error('最后一节不应该再点'); } },
        config: { ...defaults, sectionLoadMs: [1, 2] },
        log: silent,
    });
    assert.equal(await last.gotoNextSection(), false, '最后一节应当返回 false');
});

test('倍速：默认一次都不写 playbackRate', async () => {
    let writes = 0;
    const video = { locator: { async evaluate() { writes += 1; return undefined; } } };
    const runner = new CourseRunner({ page: fakePage({}), pointer: {}, config: { ...defaults }, log: silent });
    assert.equal(await runner.applyPlaybackRate(video), 1);
    assert.equal(writes, 0, '默认配置不应写入 playbackRate');

    const jitter = new CourseRunner({
        page: fakePage({}),
        pointer: {},
        config: { ...defaults, playbackRate: 1.5, playbackRateJitter: 0.08 },
        log: silent,
    });
    const rates = new Set();
    for (let i = 0; i < 10; i += 1) rates.add(await jitter.applyPlaybackRate(video));
    assert.ok(rates.size > 1, '开启抖动后不应是死值');
    assert.ok([...rates].every((rate) => rate > 1.4 && rate < 1.6));
});

test('launch 模式的启动参数不引入新特征', () => {
    const options = launchOptions();
    assert.equal(options.headless, false, '无头浏览器的特征面比自动化标志本身还大');
    assert.equal(options.channel, 'chrome', '要用本机真实 Chrome，不是 bundled Chromium');
    assert.equal(options.viewport, null, '视口应跟随真实窗口');
    assert.ok(options.ignoreDefaultArgs.includes('--enable-automation'), '必须去掉自动化标志');
    assert.ok(
        options.args.includes('--disable-blink-features=AutomationControlled'),
        'navigator.webdriver 要靠这一项变成 false'
    );
    assert.equal(options.locale, 'zh-CN');
});

test('指针起点必须是 (0,0)，否则第一次移动会带一个瞬移位移', () => {
    const pointer = createPointer({ viewportSize: () => ({ width: 1280, height: 800 }), mouse: {} });
    assert.deepEqual({ x: pointer.state.x, y: pointer.state.y }, { x: 0, y: 0 },
        'Blink 用上一次坐标算 movementX/Y，页面刚打开时那个坐标就是 (0,0)');
});

test('页签点了却始终没出现视频时要停手，不能原地打转', async () => {
    const tree = {
        chapters: [{ chapterIndex: 0, sections: [
            { chapterIndex: 0, sectionIndex: 0, title: '1.1', active: true },
            { chapterIndex: 0, sectionIndex: 1, title: '1.2', active: false },
        ] }],
        current: { chapterIndex: 0, sectionIndex: 0, title: '1.1', active: true },
        total: 2,
    };
    let clicks = 0;
    const page = {
        async waitForSelector() { return true; },
        frames() { return []; },           /* 永远找不到视频 */
        async evaluate(fn, arg) {
            if (typeof arg === 'string') return '学习目标';   /* currentStepTitle */
            if (arg && arg.chapter) return tree;              /* readTree */
            return false;                                      /* document.hidden */
        },
        locator() {
            const self = {
                nth: () => self, locator: () => self, first: () => self,
                async count() { return 1; },
                async isVisible() { return true; },
                async textContent() { return '2视频'; },
                async boundingBox() { return { x: 0, y: 40, width: 80, height: 24 }; },
            };
            return self;
        },
    };
    const runner = new CourseRunner({
        page,
        pointer: { async click() { clicks += 1; } },
        config: {
            ...defaults,
            startupDelayMs: [1, 2], stepProbeMs: [1, 2], stepSwitchWaitMs: [1, 2],
            videoProbeMs: [1, 2], maxStepSwitchTries: 3,
        },
        log: silent,
    });

    /* 没有上限保护的话这里会永远转下去 */
    await Promise.race([
        runner.run(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('run() 没有在上限处停下')), 5000)),
    ]);
    assert.equal(clicks, 3, `应当恰好点 3 次页签就停，实际 ${clicks} 次`);
});
