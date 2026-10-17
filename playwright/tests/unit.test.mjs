/* 不需要浏览器的部分：随机化、轨迹几何、参数解析、流程决策 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { human } from '../src/human.mjs';
import { createPointer } from '../src/pointer.mjs';
import { parseArgs, defaults } from '../src/config.mjs';
import { isAllowedUrl } from '../src/selectors.mjs';
import { CourseRunner, pickNextSection } from '../src/course.mjs';
import { createLogger } from '../src/logger.mjs';
import { chromeLaunchHint, describePlatform, findChrome, chromeCandidates, dedicatedChromeArgs } from '../src/platform.mjs';
import { launchOptions, launchDedicatedChrome, pickCoursePage } from '../src/browser.mjs';
import { ensureInstalled } from '../src/setup.mjs';
import { createServer } from 'node:http';

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
    assert.match(hint, /--mute-audio/);
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
            void arg;
            if (String(fn).includes('innerWidth')) return 1280;
            return tree;
        },
    };
}

/* 点了目录项之后, 真实页面会把激活项移到被点的那一节。假页面也照做,
 * 否则 gotoNextSection 的"确认切过去"永远等不到。 */
function clickingMovesActive(tree, picked) {
    return {
        async click(locator) {
            picked.push(locator.chain.join(' > '));
            const indexes = locator.chain
                .filter((part) => part.startsWith('nth('))
                .map((part) => Number(part.slice(4, -1)));
            if (indexes.length >= 2) {
                const [c, sec] = indexes;
                tree.chapters.forEach((ch) => ch.sections.forEach((item) => { item.active = false; }));
                const hit = tree.chapters[c].sections[sec];
                hit.active = true;
                tree.current = hit;
            }
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
        pointer: clickingMovesActive(tree, picked),
        config: { ...defaults, sectionLoadMs: [1, 2], sectionSwitchWaitMs: 500 },
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
    const firstTree = base(0);
    const runner = new CourseRunner({
        page: fakePage(firstTree),
        pointer: clickingMovesActive(firstTree, picked),
        config: { ...defaults, sectionLoadMs: [1, 2], sectionSwitchWaitMs: 500 },
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

test('切节：目录有任务点标记时跳到下一个有待完成任务点的小节', () => {
    const section = (chapterIndex, sectionIndex, pending, active = false) => ({ chapterIndex, sectionIndex, title: `${chapterIndex + 1}.${sectionIndex + 1}`, active, pending });
    const tree = (sections) => {
        const chapters = [0, 1].map((chapterIndex) => ({ chapterIndex, sections: sections.filter((s) => s.chapterIndex === chapterIndex) }));
        return { chapters, current: sections.find((s) => s.active), total: sections.length };
    };

    /* 实测结构: 1.2 有 1 个待完成, 中间是 0 个任务点和已完成(0) */
    let picked = pickNextSection(tree([section(0, 0, 0, true), section(0, 1, 0), section(1, 0, 0), section(1, 1, 1), section(1, 2, 0)]));
    assert.equal(picked.target.title, '2.2');
    assert.equal(picked.skipped, 2);

    /* 后面都没有待完成的: 收尾, 不往下点 */
    picked = pickNextSection(tree([section(0, 0, 1, true), section(0, 1, 0), section(1, 0, 0)]));
    assert.equal(picked.target, null);
    assert.equal(picked.marked, true);

    /* 读不出标记的小节要进去看看 */
    picked = pickNextSection(tree([section(0, 0, 0, true), section(0, 1, 0), section(1, 0, null), section(1, 1, 1)]));
    assert.equal(picked.target.title, '2.1');

    /* 整个目录都没有标记(旧布局): 按顺序 */
    picked = pickNextSection(tree([section(0, 0, null, true), section(0, 1, null), section(1, 0, null)]));
    assert.equal(picked.target.title, '1.2');
    assert.equal(picked.marked, false);
});

test('默认静音, --no-mute 可以关掉', () => {
    assert.equal(parseArgs([]).config.mute, true);
    assert.equal(parseArgs(['--no-mute']).config.mute, false);
});

test('播放中课程页被关掉: 如实停下, 不算这一节完成', async () => {
    /* 实测: 播放 8 秒后标签页被关掉, 以前会计一节完成、歇 43 秒再去点下一节, 最后报错退出 */
    const page = { isClosed: () => true, frames: () => [] };
    const runner = new CourseRunner({ page, pointer: {}, config: { ...defaults, pollIntervalMs: 5 }, log: silent });
    const video = { frame: null, locator: { evaluate: async () => { throw new Error('Target page, context or browser has been closed'); } } };
    assert.equal(await runner.watchUntilEnd(video), 'stopped');
    assert.equal(runner.stopped, true);
    assert.equal(runner.sectionsDone, 0);
});

test('指针微动的间隔铺满配置区间, 不被轮询压成固定节拍', async () => {
    /* 实测: 每轮轮询重抽阈值时, 18–55 秒的配置跑出来全是 22–26 秒 */
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
        const fired = [];
        const runner = new CourseRunner({
            page: {},
            pointer: { async drift() { fired.push(now); } },
            config: { ...defaults, idleActivityMs: [18000, 55000] },
            log: silent,
        });
        for (let t = 0; t < 4 * 3600 * 1000; t += 1200) {
            now += 1200;
            await runner.maybeDrift();
        }
        const gaps = fired.slice(1).map((at, i) => (at - fired[i]) / 1000);
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        assert.ok(mean > 32 && mean < 41, `平均间隔应在区间中部, 实际 ${mean.toFixed(1)} 秒`);
        assert.ok(gaps.filter((g) => g > 45).length > gaps.length * 0.15, '应当有相当比例的长间隔');
        assert.ok(gaps.every((g) => g >= 18 && g <= 56.5), `不应越出区间: ${Math.min(...gaps)}–${Math.max(...gaps)}`);
    } finally {
        Date.now = realNow;
    }
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
    assert.ok(options.args.includes('--mute-audio'), '默认在浏览器这一层也静音');
    assert.equal(launchOptions({ mute: false }).args.includes('--mute-audio'), false);
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
            videoProbeMs: [1, 2], maxStepSwitchTries: 3, jobsWaitMs: 1,
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

test('切节：点了目录却没切过去时重试一次就停下，不原地打转', async () => {
    const tree = {
        chapters: [{ chapterIndex: 0, sections: [
            { chapterIndex: 0, sectionIndex: 0, title: '1.1', active: true },
            { chapterIndex: 0, sectionIndex: 1, title: '1.2', active: false },
        ] }],
        current: { chapterIndex: 0, sectionIndex: 0, title: '1.1', active: true },
        total: 2,
    };
    let clicks = 0;
    const runner = new CourseRunner({
        page: fakePage(tree),
        /* 实测: 目录收起时点击落在视口外, 页面不动 */
        pointer: { async click() { clicks += 1; } },
        config: { ...defaults, sectionLoadMs: [1, 2], sectionSwitchWaitMs: 200 },
        log: silent,
    });
    assert.equal(await runner.gotoNextSection(), false);
    assert.equal(clicks, 2, '应当只点两次: 一次加一次重试');
    assert.equal(runner.stopped, true, '切不过去就该停下');
});

test('找 Chrome：Windows / macOS 看固定位置，Linux 在 PATH 里找，--chrome-path 优先', () => {
    const win = chromeCandidates('win32', { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' });
    assert.equal(win[0], 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    assert.ok(win.some((p) => p.startsWith('C:\\Users\\u\\AppData\\Local')), '要包括只给当前用户装的位置');
    const winHit = findChrome({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L' }, exists: (p) => p.startsWith('C:\\L') });
    assert.equal(winHit, 'C:\\L\\Google\\Chrome\\Application\\chrome.exe');

    const linux = findChrome({ platform: 'linux', env: { PATH: '/nope:/opt/bin' }, exists: (p) => p === '/opt/bin/chromium' });
    assert.equal(linux, '/opt/bin/chromium');
    assert.equal(findChrome({ platform: 'linux', env: { PATH: '/nope' }, exists: () => false }), null);

    assert.equal(findChrome({ configured: '/my/chrome', exists: (p) => p === '/my/chrome' }), '/my/chrome');
    assert.equal(findChrome({ configured: '/missing', exists: () => false }), null, '指定的路径不存在就别悄悄换成别的');
    assert.match(chromeCandidates('darwin', {}, '/Users/u')[0], /^\/Applications\/Google Chrome\.app/);
});

test('自动启动专用 Chrome 的参数：和手动命令同一组，不带任何自动化开关', () => {
    const args = dedicatedChromeArgs({ port: 9222, profileDir: '/home/u/xuexitong-chrome', url: 'https://i.chaoxing.com/' });
    assert.ok(args.includes('--remote-debugging-port=9222'));
    assert.ok(args.includes('--user-data-dir=/home/u/xuexitong-chrome'));
    assert.ok(args.includes('--mute-audio'), '默认静音');
    assert.equal(args.at(-1), 'https://i.chaoxing.com/');
    assert.equal(args.some((a) => /automation|headless|webdriver/i.test(a)), false);
    assert.equal(dedicatedChromeArgs({ port: 1, profileDir: '/p', mute: false }).includes('--mute-audio'), false);
});

test('连不上时自动启动专用 Chrome：独立进程、不跟着脚本退出、等到调试端口就绪', async () => {
    /* 用一个假的 /json/version 充当“Chrome 起来了” */
    const server = createServer((req, res) => { res.writeHead(200); res.end('{}'); });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address();
    let call = null;
    let unref = 0;
    try {
        await launchDedicatedChrome(
            { ...defaults, cdpPort: port, chromePath: process.execPath, chromeProfile: '/tmp/p' },
            silent,
            {
                url: 'http://example.test/',
                spawnProcess(exe, args, options) {
                    call = { exe, args, options };
                    return { pid: 1, on() {}, unref() { unref += 1; } };
                },
            },
        );
    } finally {
        server.close();
    }
    assert.equal(call.exe, process.execPath);
    assert.equal(call.options.detached, true, '脚本退出（Ctrl+C）时不能把 Chrome 一起带走');
    assert.equal(call.options.stdio, 'ignore');
    assert.equal(unref, 1);
    assert.ok(call.args.includes(`--remote-debugging-port=${port}`));
    assert.ok(call.args.includes('--user-data-dir=/tmp/p'));
    assert.equal(call.args.at(-1), 'http://example.test/');
});

test('找不到 Chrome 时说清楚怎么办', async () => {
    await assert.rejects(
        launchDedicatedChrome({ ...defaults, chromePath: '/definitely/not/chrome' }, silent, { spawnProcess() { throw new Error('不应启动'); } }),
        /没找到本机的 Google Chrome.*--chrome-path/s,
    );
});

test('没有课程页时一直等，用户点开课程后自动接管；Ctrl+C 能退出', async () => {
    const pages = [{ url: () => 'https://i.chaoxing.com/base' }];
    const context = { pages: () => pages };
    const course = {
        url: () => 'https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=1',
        async waitForLoadState() {},
        async bringToFront() {},
    };
    setTimeout(() => pages.push(course), 400);
    const picked = await pickCoursePage(context, { ...defaults }, silent, { stopped: false });
    assert.equal(picked, course);

    const abort = { stopped: false };
    setTimeout(() => { abort.stopped = true; }, 300);
    await assert.rejects(pickCoursePage({ pages: () => [] }, { ...defaults }, silent, abort), /已退出/);
});

test('第一次运行自动安装依赖；装过就不再装；--setup 强制重装；失败时给出镜像提示', () => {
    const calls = [];
    const ok = (cmd, options) => { calls.push({ cmd, options }); return { status: 0 }; };
    assert.equal(ensureInstalled(silent, { dir: '/nonexistent-dir', run: ok }), true);
    assert.match(calls[0].cmd, /^npm install/);
    assert.equal(calls[0].options.shell, true, 'Windows 上 npm 是 .cmd，要经过 shell 才能启动');
    assert.equal(ensureInstalled(silent, { run: ok }), false, '本仓库已经装过，不应再装');
    assert.equal(ensureInstalled(silent, { force: true, run: ok }), true);
    assert.throws(() => ensureInstalled(silent, { dir: '/nonexistent-dir', run: () => ({ status: 1 }) }), /npmmirror/);
});
