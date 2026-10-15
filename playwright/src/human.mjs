/* ------------------------------------------------------------------
 * 随机化原语
 * 和浏览器内版本同一套思路：不写死毫秒数，所有等待、坐标、步数都从这里取。
 * 换到 Playwright 之后输入事件本身是可信的，但“节拍”依然是会被看出来的那一面——
 * 每 1000ms 整采一次进度、每节结束后恰好 1 秒点下一节，和合成事件一样显眼。
 * ------------------------------------------------------------------ */
import { randomInt, randomBytes } from 'node:crypto';

const unit = () => randomBytes(4).readUInt32BE(0) / 4294967296;

export const human = {
    float(min, max) {
        return min + unit() * (max - min);
    },
    int(min, max) {
        if (max <= min) return Math.round(min);
        return randomInt(Math.round(min), Math.round(max) + 1);
    },
    chance(probability) {
        return unit() < probability;
    },
    pick(list) {
        return list[this.int(0, list.length - 1)];
    },
    /* 以 base 为中心抖动，并留一条长尾：真人的间隔不会整齐落在同一个区间里 */
    spread(base, ratio = 0.35) {
        const value = base * this.float(1 - ratio, 1 + ratio);
        return this.chance(0.08) ? value * this.float(1.3, 2.1) : value;
    },
    /* spec 既可以是毫秒数，也可以是 [min, max] 区间 */
    ms(spec, ratio) {
        if (Array.isArray(spec)) return Math.round(this.float(spec[0], spec[1]));
        return Math.round(this.spread(Number(spec) || 0, ratio));
    },
    /* 标准正态，用来让落点集中在中心而不是均匀铺满整个元素 */
    gauss() {
        let u = 0;
        let v = 0;
        while (u === 0) u = unit();
        while (v === 0) v = unit();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    /* 在 [min, max] 内取一个靠中间的值 */
    centered(min, max) {
        const mid = (min + max) / 2;
        const value = mid + this.gauss() * ((max - min) / 6);
        return Math.min(max, Math.max(min, value));
    },
};

export const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, Math.round(ms))));

export const sleepFor = (spec, ratio) => sleep(human.ms(spec, ratio));
