/* ------------------------------------------------------------------
 * 平台差异
 * Node 和 playwright-core 本身跨平台，需要分平台处理的只有两件事：
 * Chrome 可执行文件的位置，和 profile 目录的写法。
 * ------------------------------------------------------------------ */
import { homedir } from 'node:os';
import { accessSync, constants } from 'node:fs';
import { join, posix, win32 } from 'node:path';

export const SIDE_PROFILE = 'xuexitong-chrome';

export function chromeCommand() {
    switch (process.platform) {
        case 'darwin':
            return '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"';
        case 'win32':
            return '"%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"';
        default:
            return 'google-chrome';
    }
}

export function sideProfilePath() {
    if (process.platform === 'win32') return `%USERPROFILE%\\${SIDE_PROFILE}`;
    return join(homedir(), SIDE_PROFILE);
}

/* 专用 profile 的真实路径（自动启动 Chrome 时用；上面那个是给人抄的命令） */
export function sideProfileDir() {
    return join(homedir(), SIDE_PROFILE);
}

/* 本机 Chrome 可能在的位置。Linux 上的是命令名，要去 PATH 里找 */
export function chromeCandidates(platform = process.platform, env = process.env, home = homedir()) {
    if (platform === 'win32') {
        const roots = [env.PROGRAMFILES || env.ProgramFiles, env['PROGRAMFILES(X86)'] || env['ProgramFiles(x86)'], env.LOCALAPPDATA]
            .filter(Boolean);
        return roots.map((root) => win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    if (platform === 'darwin') {
        const app = 'Google Chrome.app/Contents/MacOS/Google Chrome';
        return [posix.join('/Applications', app), posix.join(home, 'Applications', app)];
    }
    return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
}

/* 模拟别的平台时(单元测试)要用那个平台的分隔符, 不能用宿主机的:
 * Windows 上 delimiter 是 ';'、join 用 '\\', 拿来拆 Linux 的 PATH 会拆不开。 */
function pathUtil(platform) {
    return platform === 'win32' ? win32 : posix;
}

function executable(file) {
    try {
        accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
    } catch (e) {
        return false;
    }
}

/* 找到第一个存在的 Chrome。configured 是用户用 --chrome-path 指定的，优先用它 */
export function findChrome({ configured = '', platform = process.platform, env = process.env, exists = executable } = {}) {
    if (configured) return exists(configured) ? configured : null;
    for (const candidate of chromeCandidates(platform, env)) {
        const absolute = platform === 'win32' || candidate.includes('/');
        if (absolute) {
            if (exists(candidate)) return candidate;
            continue;
        }
        const path = pathUtil(platform);
        for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
            if (exists(path.join(dir, candidate))) return path.join(dir, candidate);
        }
    }
    return null;
}

/* 自动启动专用 Chrome 时的参数，和下面 chromeLaunchHint 让人手动敲的是同一组，
 * 只多了两个跳过首次运行引导的开关。没有任何自动化相关的参数。 */
export function dedicatedChromeArgs({ port, profileDir, mute = true, url = '' }) {
    return [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        ...(mute ? ['--mute-audio'] : []),
        ...(url ? [url] : []),
    ];
}

/* 给出当前平台下启动「可被接管的 Chrome」的完整命令。
 *
 * 这里刻意用一个独立的 --user-data-dir，而不是你平时的默认 profile。原因是个坑：
 * Chrome 已经在运行时，再执行一次 chrome --remote-debugging-port=9222 并不会
 * 开出调试端口——参数会被转交给已有实例，命令直接返回，端口上什么都没有。
 * 要么先把 Chrome 完全退出，要么像下面这样用另一个 profile 目录开一个独立实例。
 * 独立目录第一次需要登录一次学习通，之后登录态就一直留在那个目录里。
 *
 * --mute-audio 让这个专用实例整个不出声(页面读不到它)。脚本默认也会在播放器上
 * 静音，这一项是兜底: 实测在教室里外放过一次。 */
export function chromeLaunchHint(port) {
    const flags = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir="${sideProfilePath()}"`,
        '--mute-audio',
    ];
    if (process.platform === 'win32') {
        return `${chromeCommand()} ${flags.join(' ')}`;
    }
    return `${chromeCommand()} ${flags.join(' ')} &`;
}

export function describePlatform() {
    const names = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
    return names[process.platform] || process.platform;
}
