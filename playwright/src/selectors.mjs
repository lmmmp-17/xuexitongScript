/* 页面选择器集中在这里，和浏览器内版本用的是同一套。
 * 平台改版时只需要动这个文件。 */
export const SEL = {
    tree: '#coursetree',
    /* 目录侧栏的展开/收起按钮。收起时整个侧栏 position:fixed 滑到视口右边外面,
     * 只有这个按钮露在视口右上角(实测) */
    catalogToggle: '#selector .switchbtn',
    chapter: '#coursetree > ul > li',
    section: '.posCatalog_select:not(.firstLayer)',
    sectionName: '.posCatalog_name',
    activeSection: '.posCatalog_active',
    stepTab: '.prev_white',
    stepTitle: '.prev_title',
    testNext: '#prevNextFocusNext, #right1, .nextChapter',
    video: 'video#video_html5_api, video[id*="video_html5"]',
    bigPlayButton: '.vjs-big-play-button',
    playControl: '.vjs-play-control',
};

export const ALLOWED_HOSTS = ['chaoxing.com'];

export function isAllowedUrl(url) {
    try {
        const { protocol, hostname } = new URL(url);
        if (protocol !== 'https:' && protocol !== 'http:') return false;
        const host = hostname.toLowerCase();
        return ALLOWED_HOSTS.some((base) => host === base || host.endsWith(`.${base}`));
    } catch (e) {
        return false;
    }
}
