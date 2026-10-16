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
                const finished = await this.videoJobFinished(frame);
                /* 已完成任务点的视频只作兜底: 同一节里可能还有没放完的 */
                if (info.readyState > 0 && finished !== true) return { frame, locator, finished };
                fallback = fallback || { frame, locator, finished };
            } catch (e) {
                this.log.trace('读取 frame 失败，跳过:', e.message);
            }
        }
        return fallback;
    }

    /* 读当前小节卡片里的任务点。
     *
     * 真实页面(mooc2 布局)上一个小节的卡片里可能同时有视频和章节测验，各自是一个
     * .ans-attach-ct，完成的带 ans-job-finished：
     *   .ans-attach-ct.videoContainer.ans-job-finished  > iframe /ananas/modules/video/
     *   .ans-attach-ct                                  > iframe /ananas/modules/work/
     * 目录上的"1个待完成任务点"可能是测验而不是视频，所以得看这里才知道视频要不要放。
     * 没有卡片 frame(旧布局)时返回 null。 */
    async readJobs(timeoutMs = this.config.jobsWaitMs ?? 6000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const cards = this.page.frames().find((f) => !f.isDetached() && f.url().includes('/knowledge/cards'));
            if (cards) {
                const jobs = await cards.evaluate(() => Array.from(document.querySelectorAll('.ans-attach-ct')).map((ct) => {
                    const src = (ct.querySelector('iframe') || {}).getAttribute
                        ? ct.querySelector('iframe').getAttribute('src') || '' : '';
                    const kind = /modules\/video/.test(src) ? 'video' : /modules\/work/.test(src) ? 'work' : 'other';
                    return { kind, finished: ct.classList.contains('ans-job-finished'), isJob: !!ct.querySelector('.ans-job-icon') };
                })).catch(() => []);
                if (jobs.length) return jobs.filter((job) => job.isJob);
            }
            if (Date.now() >= deadline) return cards ? [] : null;
            await sleepFor([300, 700]);
        }
    }

    /* 视频所在 iframe 的外层 .ans-attach-ct 有没有 ans-job-finished */
    async videoJobFinished(frame) {
        try {
            const element = await frame.frameElement();
            return await element.evaluate((el) => {
                const ct = el.closest('.ans-attach-ct');
                return ct ? ct.classList.contains('ans-job-finished') : null;
            });
        } catch (e) {
            return null;
        }
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
        const atEnd = (state) => state && (state.ended || (state.duration > 0 && state.currentTime >= state.duration - 0.4));
        const before = await this.videoState(video);
        if (before && !before.paused && before.currentTime > 0) {
            this.log.note('视频已在播放');
            return true;
        }
        /* 播完的视频上 .vjs-play-control 的文字是"重播", 点下去会从头再放一遍 */
        if (atEnd(before)) {
            this.log.note('视频已经在结尾, 不去点"重播"');
            return false;
        }

        /* 判断"起来了没有"要看进度有没有走, 不能只看 paused: 起播后马上碰到视频内
         * 弹题、或者视频本身很短已经放完, 都会是暂停态。只看 paused 会误判失败,
         * 接着去点下一个按钮——放完的视频上那个按钮正是"重播"。 */
        const started = (after) => after && (!after.paused || after.currentTime > (before ? before.currentTime : 0) + 0.05);

        const attempts = [
            [SEL.bigPlayButton, () => video.frame.locator(SEL.bigPlayButton).first()],
            [SEL.playControl, () => video.frame.locator(SEL.playControl).first()],
            /* 播放器皮肤不一样时，点视频画面本身也是人会做的操作 */
            ['视频画面', () => video.locator],
        ];
        for (const [name, target] of attempts) {
            try {
                const now = await this.videoState(video);
                if (started(now)) return true;
                if (atEnd(now)) return true;    /* 上一次点击其实已经放完了, 别再点"重播" */
                const button = target();
                if (await button.count() === 0 || !await button.isVisible()) continue;
                this.log.note(`点击 ${name} 起播`);
                await this.pointer.click(button);
                await sleepFor([700, 1600]);
                if (started(await this.videoState(video))) return true;
            } catch (e) {
                this.log.trace(`点 ${name} 没成功:`, e.message);
            }
        }

        /* 兜底才用脚本调用。前面已经有过真实点击，所以这里通常不会被策略拦。 */
        const last = await this.videoState(video);
        if (started(last) || atEnd(last)) return true;
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

    /* 目录侧栏收起时目标项在视口外, 先点开侧栏——看不到目录时人也是这么做的 */
    async ensureCatalogVisible(locator) {
        const width = await this.page.evaluate(() => window.innerWidth);
        const visible = async () => {
            const box = await locator.boundingBox();
            return !!box && box.x >= 0 && box.x + box.width <= width;
        };
        if (await visible()) return true;
        const toggle = this.page.locator(SEL.catalogToggle).first();
        if (!await toggle.count() || !await toggle.isVisible()) return false;
        this.log.note('目录侧栏是收起的, 先点开');
        await this.pointer.click(toggle);
        await sleepFor([800, 1400]);   /* 侧栏有滑入动画 */
        return visible();
    }

    /* 点完目录项之后确认真的切过去了: 激活项变成了目标节 */
    async waitForSection(target, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const tree = await this.readTree();
            const current = tree.current;
            if (current && current.chapterIndex === target.chapterIndex && current.sectionIndex === target.sectionIndex) {
                return true;
            }
            await sleepFor([300, 600]);
        }
        return false;
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

        const name = target.title || `第${target.chapterIndex + 1}章第${target.sectionIndex + 1}节`;
        this.log.say(`切换到：${name}`);
        const locator = this.sectionLocator(target);

        /* 以前点完就当切过去了。实测目录侧栏收起时点击落在视口外, 页面纹丝不动,
         * 工具却每隔几秒重新"切换"一次同一节。现在点完必须确认激活项真的变了,
         * 不行就重试一次, 再不行就停下, 不原地打转。 */
        let moved = false;
        for (let attempt = 1; attempt <= 2 && !moved && !this.stopped; attempt += 1) {
            try {
                await this.ensureCatalogVisible(locator);
                await this.pointer.click(locator, { scrollAnchor: this.page.locator(SEL.tree) });
            } catch (e) {
                this.log.warn(`点目录里的「${name}」失败: ${e.message.split('\n')[0]}`);
            }
            moved = await this.waitForSection(target, this.config.sectionSwitchWaitMs);
            if (!moved && attempt === 1) this.log.warn('点完目录没有切过去, 再试一次');
        }
        if (!moved) {
            this.log.error(`点了目录里的「${name}」但页面没有切过去, 已停下。可能是平台弹了提示框或者目录结构变了, 请看一眼浏览器。`);
            this.stop('切换小节失败');
            return false;
        }
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

            /* .prev_title 在旧布局里是步骤名("视频"/"章节测验"), 但实测 mooc2 布局里
             * 它是小节标题, 靠它判断会全部落空。所以先看卡片里的任务点。 */
            const step = await this.currentStepTitle();
            const jobs = await this.readJobs();
            const pendingVideo = jobs ? jobs.some((job) => job.kind === 'video' && !job.finished) : false;
            const pendingOther = jobs ? jobs.filter((job) => job.kind !== 'video' && !job.finished).length : 0;
            if (jobs) {
                this.log.note(`本节任务点: ${jobs.map((job) => `${job.kind}${job.finished ? '✓' : '…'}`).join(' ') || '无'}`);
            }

            /* 有没完成的视频就多等一会儿等播放器装好；其它情况没必要干等 */
            const expectVideo = pendingVideo || step === '视频';
            const waitMs = expectVideo ? this.config.videoWaitMs : human.ms(this.config.stepProbeMs);
            let video = await this.findVideoWithWait(waitMs);
            if (this.stopped) return;

            if (video && (video.finished === true || (jobs && !pendingVideo))) {
                this.log.note('本节视频任务点已经完成, 不再重放');
                video = null;
            }

            if (!video && jobs && !pendingVideo) {
                /* 新布局: 视频要么没有、要么已完成, 剩下的是测验等非视频任务点 */
                const rest = pendingOther ? `还剩 ${pendingOther} 个非视频任务点(章节测验等)需要你自己完成` : '本节任务点已全部完成';
                if (!this.config.autoAdvanceNoVideo && pendingOther) {
                    this.log.warn(`本节没有待播的视频, ${rest}。已停下; 确认后加 --auto-advance-no-video 可自动跳到下一节。`);
                    return;
                }
                this.log.say(`本节没有待播的视频, ${rest}, 切到下一节`);
                if (!await this.gotoNextSection()) return;
                continue;
            }

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
