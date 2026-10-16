/* ------------------------------------------------------------------
 * 配置
 * 时间相关的值要么是基准毫秒（实际执行时抖动），要么是 [min, max] 区间。
 * 没有一个是“照着这个数准点执行”的。
 * ------------------------------------------------------------------ */
export const defaults = {
    mode: 'connect',                    /* connect | launch */
    cdpPort: 9222,
    profileDir: '.chrome-profile',      /* 仅 launch 模式使用 */
    url: '',
    logLevel: 'quiet',                  /* silent | quiet | normal | verbose */

    /* 播放 */
    playbackRate: 1,                    /* 默认不改倍速 */
    playbackRateJitter: 0,
    allowScriptedPlay: true,            /* 真实点击起播失败时才退回 video.play() */
    mute: true,                         /* 起播前静音, 一点声音都不出; --no-mute 关掉 */
    resumeWhileHidden: true,
    autoAdvanceNoVideo: false,
    maxSections: 0,                     /* 0 = 不限 */
    maxChapterTestTries: 3,
    maxStepSwitchTries: 4,

    /* 节奏 */
    startupDelayMs: [1200, 5500],
    treeTimeoutMs: 30000,
    actionTimeoutMs: 15000,             /* 单个 Playwright 操作的上限，默认是不限 */
    pollIntervalMs: 1200,
    videoWaitMs: 8000,              /* 等播放器把 video 元素装出来 */
    jobsWaitMs: 6000,               /* 等卡片 frame 里的任务点装出来 */
    sectionSwitchWaitMs: 8000,      /* 点完目录后等激活项变过去 */
    guardNoProgressMs: 8000,
    resumeCooldownMs: 2500,
    sectionPauseMs: [2600, 9000],
    sectionLoadMs: [2600, 4800],
    videoProbeMs: [400, 900],           /* 等播放器时的重试间隔 */
    stepProbeMs: [600, 1400],           /* 非视频步骤上看一眼有没有视频 */
    stepSwitchWaitMs: [1800, 3400],     /* 点完视频页签之后等页面切过去 */
    testPeekMs: [1600, 4600],           /* 测验页上“看一眼”再点下一步 */
    testAdvanceWaitMs: [1900, 3400],
    longBreakChance: 0.12,
    longBreakMs: [20000, 70000],
    idleActivity: true,
    idleActivityMs: [18000, 55000],
};

const NUMBERS = new Set([
    'cdpPort', 'playbackRate', 'playbackRateJitter', 'maxSections', 'maxChapterTestTries',
    'treeTimeoutMs', 'pollIntervalMs', 'guardNoProgressMs', 'resumeCooldownMs', 'longBreakChance',
    'maxStepSwitchTries', 'videoWaitMs', 'actionTimeoutMs', 'jobsWaitMs', 'sectionSwitchWaitMs',
]);
const FLAGS = new Set([
    'allowScriptedPlay', 'resumeWhileHidden', 'autoAdvanceNoVideo', 'idleActivity', 'mute',
]);

const camel = (name) => name.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

export function parseArgs(argv) {
    const options = {};
    let check = false;
    let inspect = false;
    let help = false;

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (token === '--help' || token === '-h') { help = true; continue; }
        if (token === '--check') { check = true; continue; }
        if (token === '--inspect') { inspect = true; continue; }
        if (token === '--launch') { options.mode = 'launch'; continue; }
        if (token === '--connect') { options.mode = 'connect'; continue; }
        if (!token.startsWith('--')) throw new Error(`无法识别的参数: ${token}`);

        const body = token.slice(2);
        const eq = body.indexOf('=');
        let name = camel(eq >= 0 ? body.slice(0, eq) : body);
        let value = eq >= 0 ? body.slice(eq + 1) : null;

        let negated = false;
        if (name.startsWith('no') && name.length > 2 && name[2] === name[2].toUpperCase()) {
            const candidate = name[2].toLowerCase() + name.slice(3);
            if (FLAGS.has(candidate)) {
                name = candidate;
                negated = true;
            }
        }

        if (FLAGS.has(name)) {
            options[name] = negated ? false : (value === null ? true : value !== 'false');
            continue;
        }
        /* 先确认参数名认识，再去取值——否则打错一个名字只会说“缺少取值” */
        if (!(name in defaults)) throw new Error(`无法识别的参数: ${token}`);
        if (value === null) {
            value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${token} 缺少取值`);
            i += 1;
        }
        if (NUMBERS.has(name)) {
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) throw new Error(`参数 ${token} 需要是数字，拿到的是: ${value}`);
            options[name] = parsed;
            continue;
        }
        options[name] = value;
    }
    if (options.mode && !['connect', 'launch'].includes(options.mode)) {
        throw new Error('--mode 只能是 connect 或 launch');
    }

    return { config: { ...defaults, ...options }, check, inspect, help };
}

export const helpText = `
用真实输入事件驱动学习通课程播放（Playwright 版）

用法
  node run.mjs [选项]

浏览器接入
  --connect               连接已在运行的 Chrome（默认，特征最低）
  --cdp-port <端口>       CDP 端口，默认 9222
  --launch                让脚本自己启动本机 Chrome
  --profile-dir <目录>    launch 模式的 profile 目录，默认 .chrome-profile
  --url <地址>            没有打开着的课程页时用它打开

行为
  --check                 只做特征自检并退出，不动课程进度
  --inspect               只读检查课程页结构(目录、学习步骤、播放器、弹出物)，
                          适配页面改版时先跑它；不点击、不播放
  --no-mute               起播时不静音（默认静音：起播前就把播放器设成静音，不会外放）
  --playback-rate <倍速>  默认 1（不写 playbackRate）
  --playback-rate-jitter <幅度>
  --max-sections <n>      最多播放多少节，默认不限
  --auto-advance-no-video 没有视频的小节直接跳过（默认停下）
  --no-idle-activity      关掉播放期间的指针微动
  --no-resume-while-hidden  页面在后台时不去动播放状态
  --no-allow-scripted-play  禁止退回 video.play()，只用真实点击
  --poll-interval-ms <ms> 进度轮询基准间隔，默认 1200
  --log-level <档>        silent | quiet | normal | verbose

先这样启动 Chrome（复用你平时的 profile，登录态都在）：
  google-chrome --remote-debugging-port=9222 --restore-last-session
在里面打开课程播放页，然后：
  node run.mjs
`.trim();
