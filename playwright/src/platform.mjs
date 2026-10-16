/* ------------------------------------------------------------------
 * 平台差异
 * Node 和 playwright-core 本身跨平台，需要分平台处理的只有两件事：
 * Chrome 可执行文件的位置，和 profile 目录的写法。
 * ------------------------------------------------------------------ */
import { homedir } from 'node:os';
import { join } from 'node:path';

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
