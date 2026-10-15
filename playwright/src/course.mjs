/* ------------------------------------------------------------------
 * 课程播放流程
 *
 * 分工：
 *   - 凡是“操作”（点目录、点页签、点播放、滚动）都走真实输入，由 pointer 完成
 *   - 凡是“读取”（目录结构、播放进度）都用 evaluate 只读 DOM，不派发任何事件
 *
 * 比浏览器内版本强的两点：
 *   1. 点击是浏览器自己构造的事件，isTrusted 为 true
 *   2. 跨域 iframe 里的视频也能直接读到——油猴版受同源策略限制，只能跳过
 * ------------------------------------------------------------------ */
import { SEL } from './selectors.mjs';
import { human, sleep, sleepFor } from './human.mjs';

export class CourseRunner {
    constructor({ page, pointer, config, log }) {
        this.page = page;
        this.pointer = pointer;
        this.config = config;
        this.log = log;
        this.stopped = false;
        this.lastDriftAt = Date.now();
        this.chapterTestTries = 0;
        this.stepSwitchTries = 0;
        this.sectionsDone = 0;
    }

    stop(reason) {
        if (this.stopped) return;
        this.stopped = true;
        this.log.say(`停止：${reason}`);
    }

    async waitForTree() {
        /* 真人打开页面不会在同一毫秒开始操作 */
        await sleepFor(this.config.startupDelayMs);
        await this.page.waitForSelector(SEL.tree, { timeout: this.config.treeTimeoutMs });
        this.log.say('已找到课程目录');
    }

    /* 目录结构一次读出来，纯只读 */
    async readTree() {
        return this.page.evaluate((sel) => {
            const chapters = Array.from(document.querySelectorAll(sel.chapter)).map((chapter, chapterIndex) => {
                const sections = Array.from(chapter.querySelectorAll(sel.section)).map((section, sectionIndex) => {
                    const name = section.querySelector(sel.sectionName);
                    return {
                        chapterIndex,
                        sectionIndex,
                        title: ((name && name.getAttribute('title')) || (name && name.textContent) || '').trim(),
                        active: section.classList.contains('posCatalog_active'),
                    };
                });
                return { chapterIndex, sections };
            });
            const flat = chapters.flatMap((chapter) => chapter.sections);
            return { chapters, current: flat.find((section) => section.active) || null, total: flat.length };
        }, SEL);
    }

    sectionLocator(position) {
        return this.page
            .locator(SEL.chapter)
            .nth(position.chapterIndex)
            .locator(SEL.section)
            .nth(position.sectionIndex)
            .locator(SEL.sectionName)
            .first();
    }

    async currentStepTitle() {
        return this.page.evaluate((selector) => {
            const el = document.querySelector(selector);
            if (!el) return '';
            return (el.getAttribute('title') || el.textContent || '').trim();
        }, SEL.stepTitle);
    }

    /* 遍历所有 frame 找视频。Playwright 能进跨域 frame，这里不需要像油猴版那样
     * 逐帧 try/catch 再放弃。 */
    async findVideo() {
        /* 切节时新旧 iframe 可能短暂并存，所以先挑“装好了的”那个：
         * readyState > 0 说明已经拿到媒体信息。都没装好就退回第一个候选，
         * 由调用方继续等。 */
        let fallback = null;
        for (const frame of this.page.frames()) {
            if (frame.isDetached()) continue;
            try {
                const locator = frame.locator(SEL.video).first();
                if (await locator.count() === 0) continue;
                const info = await locator.evaluate((el) => ({
                    media: el instanceof HTMLMediaElement,
                    readyState: el.readyState,
                })).catch(() => null);
                if (!info || !info.media) continue;
                if (info.readyState > 0) return { frame, locator };
                fallback = fallback || { frame, locator };
            } catch (e) {
                this.log.trace('读取 frame 失败，跳过:', e.message);
            }
        }
        return fallback;
    }

    /* 切节点之后播放器要装一会儿才会出现 video 元素，不能看一眼就判定“这节没视频” */
    async findVideoWithWait(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const video = await this.findVideo();
            if (video) return video;
            if (this.stopped || Date.now() >= deadline) return null;
            await sleepFor(this.config.videoProbeMs);
        }
    }

    async videoState(video) {
        try {
            return await video.locator.evaluate((el) => ({
                currentTime: Number(el.currentTime) || 0,
                duration: Number.isFinite(el.duration) ? el.duration : 0,
                paused: el.paused,
                ended: el.ended,
                muted: el.muted,
                volume: el.volume,
                readyState: el.readyState,
                rate: el.playbackRate,
            }));
        } catch (e) {
            return null;
        }
    }

    /* 起播优先用真实点击：播放器的大播放按钮本来就是给人点的，
     * 点它既能拿到用户激活（不会被 autoplay 策略拦），行为也最普通。 */
    async startPlayback(video) {
        const before = await this.videoState(video);
        if (before && !before.paused && before.currentTime > 0) {
            this.log.note('视频已在播放');
            return true;
        }

        const buttons = [SEL.bigPlayButton, SEL.playControl];
        for (const selector of buttons) {
            const button = video.frame.locator(selector).first();
            try {
                if (await button.count() === 0) continue;
                if (!await button.isVisible()) continue;
                this.log.note(`点击播放按钮 ${selector}`);
                await this.pointer.click(button);
                await sleepFor([700, 1600]);
                const after = await this.videoState(video);
                if (after && !after.paused) return true;
            } catch (e) {
                this.log.trace(`点 ${selector} 没成功:`, e.message);
            }
        }

        /* 播放器皮肤不一样时，点视频画面本身也是人会做的操作 */
        try {
            const state = await this.videoState(video);
            if (state && state.paused) {
                this.log.note('点击视频画面起播');
                await this.pointer.click(video.locator);
                await sleepFor([700, 1600]);
                const after = await this.videoState(video);
                if (after && !after.paused) return true;
            }
        } catch (e) {
            this.log.trace('点击视频画面失败:', e.message);
        }

        /* 兜底才用脚本调用。前面已经有过真实点击，所以这里通常不会被策略拦。 */
        if (this.config.allowScriptedPlay) {
            this.log.warn('真实点击未能起播，改用 video.play()（这一步是脚本调用，不是真实点击）');
            const ok = await video.locator.evaluate((el) => el.play().then(() => true).catch(() => false));
            if (ok) return true;
        }
        return false;
    }

    async applyPlaybackRate(video) {
        const base = Number(this.config.playbackRate) || 1;
        const jitter = Math.max(0, Number(this.config.playbackRateJitter) || 0);
        /* 默认 1 且不抖动时一次都不写：倍速会随播放心跳上报 */
        if (base === 1 && jitter === 0) return 1;
        const rate = jitter > 0
            ? Number(human.float(Math.max(0.0625, base - jitter), base + jitter).toFixed(3))
            : base;
        await video.locator.evaluate((el, value) => { el.playbackRate = value; }, rate);
        this.log.note(`倍速设为 ${rate}x`);
        return rate;
    }

    /* 轮询进度。间隔每轮重抽，不去踩整秒 */
    async watchUntilEnd(video) {
        let lastTime = -1;
        let lastProgressAt = Date.now();
        let lastResumeAt = 0;

        for (;;) {
            if (this.stopped) return 'stopped';
            await sleepFor(this.config.pollIntervalMs, 0.3);

            let state = await this.videoState(video);
            if (!state) {
                /* frame 可能因为切节点被换掉了，重新找一次 */
                const again = await this.findVideo();
                if (!again) {
                    this.log.warn('视频元素消失，当前小节的监控结束');
                    return 'lost';
                }
                video.frame = again.frame;
                video.locator = again.locator;
                state = await this.videoState(video);
                if (!state) return 'lost';
            }

            const nearEnd = state.duration > 0 && state.currentTime >= state.duration - 0.4;
            if (state.ended || nearEnd) {
                this.log.say(`播放完成：${this.formatTime(state.currentTime)} / ${this.formatTime(state.duration)}`);
                return 'ended';
            }

            if (state.currentTime > lastTime + 0.01) {
                lastTime = state.currentTime;
                lastProgressAt = Date.now();
                this.log.trace(`进度 ${this.formatTime(state.currentTime)} / ${this.formatTime(state.duration)}`);
            }

            const stalledMs = Date.now() - lastProgressAt;
            const needResume = state.paused || stalledMs >= human.ms(this.config.guardNoProgressMs, 0.25);
            if (needResume && Date.now() - lastResumeAt >= human.ms(this.config.resumeCooldownMs, 0.3)) {
                lastResumeAt = Date.now();
                if (await this.page.evaluate(() => document.hidden) && !this.config.resumeWhileHidden) {
                    this.log.trace('页面在后台，按配置不去动播放状态');
                } else {
                    this.log.note(state.paused ? '视频被暂停，尝试恢复' : `进度停滞 ${Math.round(stalledMs / 1000)} 秒，尝试恢复`);
                    await this.startPlayback(video);
                    lastProgressAt = Date.now();
                }
            }

            await this.maybeDrift();
        }
    }

    async maybeDrift() {
        if (!this.config.idleActivity) return;
        const due = this.lastDriftAt + human.ms(this.config.idleActivityMs);
        if (Date.now() < due) return;
        this.lastDriftAt = Date.now();
        try {
            await this.pointer.drift();
            this.log.trace('指针微动');
        } catch (e) {
            this.log.trace('指针微动失败:', e.message);
        }
    }

    /* 当前不在视频步骤时，点顶部的“视频”页签 */
    async enterVideoStep() {
        const tabs = this.page.locator(SEL.stepTab);
        const count = await tabs.count();
        for (let i = 0; i < count; i += 1) {
            const tab = tabs.nth(i);
            try {
                if (!await tab.isVisible()) continue;
                const text = ((await tab.textContent()) || '').replace(/\s+/g, '');
                if (!text.includes('视频')) continue;
                this.log.note(`点击学习步骤页签：${text}`);
                await this.pointer.click(tab);
                return true;
            } catch (e) {
                this.log.trace('页签点击失败:', e.message);
            }
        }
        return false;
    }

    async skipChapterTest() {
        if (this.chapterTestTries >= this.config.maxChapterTestTries) {
            this.log.warn('章节测验连续跳转失败，停下来避免页面来回打转');
            return false;
        }
        const next = this.page.locator(SEL.testNext).first();
        if (await next.count() === 0 || !await next.isVisible()) {
            this.log.warn('章节测验页上没找到下一步按钮');
            return false;
        }
        this.chapterTestTries += 1;
        /* 测验页上先“看一眼”再点下一步 */
        await sleepFor(this.config.testPeekMs);
        this.log.note('章节测验：点击下一步');
        await this.pointer.click(next);
        await sleepFor(this.config.testAdvanceWaitMs);
        return true;
    }

    async sectionPause() {
        if (human.chance(this.config.longBreakChance)) {
            const ms = human.ms(this.config.longBreakMs);
            this.log.say(`本节结束，离开 ${Math.round(ms / 1000)} 秒再继续`);
            await sleep(ms);
            return;
        }
        const ms = human.ms(this.config.sectionPauseMs);
        this.log.note(`本节结束，${(ms / 1000).toFixed(1)} 秒后切换`);
        await sleep(ms);
    }

    async gotoNextSection() {
        const tree = await this.readTree();
        if (!tree.current) {
            this.log.warn('目录里找不到当前激活的小节，需要先手动点开一节');
            return false;
        }
        const chapter = tree.chapters[tree.current.chapterIndex];
        let target = chapter.sections[tree.current.sectionIndex + 1] || null;
        if (!target) {
            for (let i = tree.current.chapterIndex + 1; i < tree.chapters.length; i += 1) {
                if (tree.chapters[i].sections.length > 0) {
                    [target] = tree.chapters[i].sections;
                    break;
                }
            }
        }
        if (!target) {
            this.log.say('已经是最后一节，课程播放完成');
            return false;
        }

        this.log.say(`切换到：${target.title || `第${target.chapterIndex + 1}章第${target.sectionIndex + 1}节`}`);
        const locator = this.sectionLocator(target);
        await this.pointer.click(locator, { scrollAnchor: this.page.locator(SEL.tree) });
        await sleepFor(this.config.sectionLoadMs);
        /* 新的一节重新给满重试次数 */
        this.chapterTestTries = 0;
        this.stepSwitchTries = 0;
        return true;
    }

    formatTime(seconds) {
        const total = Math.max(0, Math.round(Number(seconds) || 0));
        const m = String(Math.floor(total / 60)).padStart(2, '0');
        const s = String(total % 60).padStart(2, '0');
        return `${m}:${s}`;
    }

    async run() {
        await this.waitForTree();
        const tree = await this.readTree();
        this.log.say(`课程共 ${tree.chapters.length} 章 ${tree.total} 节，当前：${tree.current ? tree.current.title || '未命名' : '未定位'}`);

        while (!this.stopped) {
            if (this.config.maxSections > 0 && this.sectionsDone >= this.config.maxSections) {
                this.log.say(`已完成 ${this.sectionsDone} 节，达到 --max-sections 上限`);
                return;
            }

            const step = await this.currentStepTitle();
            /* 已经在视频步骤上就多等一会儿等播放器装好；其它步骤没必要干等 */
            const waitMs = step === '视频' ? this.config.videoWaitMs : human.ms(this.config.stepProbeMs);
            const video = await this.findVideoWithWait(waitMs);
            if (this.stopped) return;
            if (!video) {
                this.log.note(`当前步骤「${step || '未知'}」没有视频`);

                if (step === '章节测验') {
                    if (await this.skipChapterTest()) continue;
                    return;
                }
                /* 点了页签却始终没出现视频时必须停手：否则这里会一直点同一个
                 * 页签转圈，比什么都不做更显眼。 */
                if (this.stepSwitchTries >= this.config.maxStepSwitchTries) {
                    this.log.warn(`已连续 ${this.stepSwitchTries} 次切到视频步骤但没等到视频，停下来避免原地打转`);
                    return;
                }
                if (await this.enterVideoStep()) {
                    this.stepSwitchTries += 1;
                    await sleepFor(this.config.stepSwitchWaitMs);
                    continue;
                }
                if (!this.config.autoAdvanceNoVideo) {
                    this.log.warn('这一节没有视频也没有可识别的学习步骤，已停下。确认无需完成课件后再加 --auto-advance-no-video 重跑。');
                    return;
                }
                this.log.warn('按配置跳过没有视频的小节');
                if (!await this.gotoNextSection()) return;
                continue;
            }

            await this.applyPlaybackRate(video);
            if (!await this.startPlayback(video)) {
                this.log.warn('这一节起播失败，已停下');
                return;
            }

            const result = await this.watchUntilEnd(video);
            if (result === 'stopped') return;
            this.sectionsDone += 1;

            await this.sectionPause();
            if (this.stopped) return;
            if (!await this.gotoNextSection()) return;
        }
    }
}
