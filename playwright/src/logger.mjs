/* 日志分档，默认只打印关键状态。和浏览器内版本保持一致的理念：
 * 输出本身没必要刷屏，排障时再调高。 */
const LEVELS = { silent: 0, quiet: 1, normal: 2, verbose: 3 };

export function createLogger(level = 'quiet') {
    const rank = LEVELS[level] ?? LEVELS.quiet;
    const stamp = () => new Date().toTimeString().slice(0, 8);
    const write = (min, stream, args) => {
        if (rank < min) return;
        stream(`[${stamp()}]`, ...args);
    };
    return {
        level,
        say: (...args) => write(LEVELS.quiet, console.log, args),
        note: (...args) => write(LEVELS.normal, console.log, args),
        trace: (...args) => write(LEVELS.verbose, console.log, args),
        warn: (...args) => write(LEVELS.silent + 1, console.warn, args),
        error: (...args) => console.error(`[${stamp()}]`, ...args),
    };
}
