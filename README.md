# 学习通刷课脚本

自动播放学习通课程视频、放完自动切到下一节。fork 自 [chaolucky18/xuexitongScript](https://github.com/chaolucky18/xuexitongScript)，这个分支在原来的油猴脚本之外加了一个 **Playwright 版**：用你自己的 Chrome，点击是浏览器生成的真实输入，窗口可以放到后台。

两个版本：

| | Playwright 版（推荐） | 油猴 / 控制台版 |
| --- | --- | --- |
| 在哪 | [`playwright/`](playwright/) | [`userscript/`](userscript/) |
| 需要装什么 | Node.js + 一个 npm 包 | 什么都不用装 |
| 点击是否可信（`isTrusted`） | 是 | 否，页面一查就知道 |
| 窗口放到后台 | 不受影响 | 会被页面发现失焦，只能事后把视频按回去 |

---

## 快速开始（Playwright 版）

### 0. 准备

- **Node.js 20 或更新**：终端里 `node -v` 能看到版本号即可。没有的话去 [nodejs.org](https://nodejs.org/) 装 LTS 版。
- **Google Chrome**：用你电脑上装的那个，不需要另外下载浏览器。
- 下载这个仓库：

  ```bash
  git clone https://github.com/lmmmp-17/xuexitongScript.git
  ```

### 1. 安装依赖

```bash
cd xuexitongScript/playwright
npm install
```

只会装 `playwright-core`（约 5MB），不下载浏览器。

### 2. 启动一个专用的 Chrome

脚本要通过调试端口 9222 接管 Chrome，所以 Chrome 得用下面的命令启动。按你的系统选一条：

```bash
# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/xuexitong-chrome" --mute-audio &

# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/xuexitong-chrome" --mute-audio &
```

```bat
:: Windows（cmd）
"%ProgramFiles%\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\xuexitong-chrome" --mute-audio
```

这三个参数的作用：

- `--remote-debugging-port=9222`：开调试端口，脚本从这里接管。
- `--user-data-dir=...`：用一个**单独的 profile 目录**，和你平时用的 Chrome 分开。不加的话，如果平时的 Chrome 已经开着，这条命令只会在原来的窗口里多开一个标签，**调试端口不会打开**。单独的目录第一次需要登录一次学习通，之后登录状态会一直保留。
- `--mute-audio`：这个 Chrome 整个不出声。脚本本身也会在播放前静音，这一项是双保险。

### 3. 登录并打开课程

在刚打开的 Chrome 窗口里：

1. 登录学习通；
2. 进入要刷的课程，点开**任意一节**，进到播放页（地址里带 `/mycourse/studentstudy`）。

从哪一节开始，脚本就从哪一节往后走。

### 4. 运行

回到终端，在 `playwright/` 目录下：

```bash
node run.mjs --max-sections 1     # 第一次建议先只跑一节，看看是否正常
node run.mjs                      # 一直跑到课程结束
```

按 `Ctrl+C` 停止。只会停脚本，不会关掉浏览器。

脚本会做这些事：

- 读左侧目录，跳到下一个**还有待完成任务点**的小节。已完成的、没有任务点的小节直接越过，不算任务点的视频不播。
- 先静音，再真实点击播放按钮；暂停了会恢复；放完停几秒再切下一节，偶尔会停得久一点。
- 遇到章节测验之类的非视频任务点，默认**停下来**等你处理，不会跳过。确认可以跳过的话，加 `--auto-advance-no-video`。

### 5. 常用参数

| 参数 | 作用 |
| --- | --- |
| `--max-sections <n>` | 播完 n 节就停 |
| `--auto-advance-no-video` | 没有待播视频的小节直接跳到下一节（默认停下） |
| `--playback-rate <倍速>` | 默认 1，也就是不改倍速 |
| `--no-mute` | 不静音 |
| `--log-level verbose` | 显示全部细节，排查问题时用 |
| `--inspect` | 只读查看当前页面的结构，不点击、不播放 |
| `--check` | 特征自检，不动课程进度 |
| `--help` | 列出全部参数 |

### 运行期间注意

- 浏览器窗口可以放到别的窗口**后面**，或者挪到另一个桌面，不影响播放。但**不要最小化**，也不要在同一个窗口里切到别的标签页，否则页面会变成后台状态。
- 脚本运行时，别在那个 Chrome 窗口里动鼠标。想用电脑就把它放到后面。
- 用完把这个 Chrome 关掉。调试端口开着时，本机的任何程序都能控制这个浏览器。

### 遇到问题

| 现象 | 处理 |
| --- | --- |
| `连不上 http://127.0.0.1:9222` | 第 2 步的 Chrome 没有用调试端口启动。把那个 Chrome 完全关掉，再用第 2 步的命令重新打开 |
| `没有找到打开着的课程播放页` | 先在那个 Chrome 里点进课程的某一节播放页，再运行 |
| 停下来说"还剩 N 个非视频任务点" | 章节测验等需要你自己完成；完成后重新运行，或者加 `--auto-advance-no-video` |
| `点了目录…但页面没有切过去` | 平台可能弹了提示框，看一眼浏览器，处理掉再重新运行 |
| 页面改版、脚本找不到东西 | 先跑 `node run.mjs --inspect` 看真实结构，再带着输出提 issue |

更多技术细节（为什么这么做、还能被什么查出来、测试怎么跑）见 [`playwright/README.md`](playwright/README.md)。

---

## 目录结构

```
xuexitongScript/
├── README.md               ← 你正在看的：快速开始 + 总览
├── playwright/             Playwright 版（推荐）
│   ├── README.md           技术说明：原理、焦点模拟、检测面、测试
│   ├── run.mjs             入口：node run.mjs
│   ├── package.json
│   ├── src/
│   │   ├── course.mjs      课程流程：读目录、选下一节、起播、监控、切节
│   │   ├── browser.mjs     连接 / 启动 Chrome
│   │   ├── pointer.mjs     真实指针：贝塞尔轨迹、点击、滚轮
│   │   ├── environment.mjs 焦点与生命周期模拟（窗口放后台不触发 blur）
│   │   ├── selectors.mjs   页面选择器，平台改版时只改这里
│   │   ├── config.mjs      默认配置与命令行参数
│   │   ├── inspect.mjs     --inspect 只读检查
│   │   ├── diagnose.mjs    --check 特征自检
│   │   ├── human.mjs       随机化（等待时长、落点）
│   │   ├── platform.mjs    三平台差异（Chrome 路径、profile 目录）
│   │   └── logger.mjs
│   └── tests/              单元测试 + 用真实 Chrome 跑的端到端测试
├── userscript/             油猴 / 控制台版
│   ├── README.md           用法与实现说明
│   ├── v3_optimized.js     唯一源码（控制台粘贴版）
│   ├── v3_optimized.user.js  油猴版，由 build.mjs 生成，不要手改
│   ├── build.mjs
│   └── tests/
├── legacy/                 上游的旧脚本（v2.js、xuexitong.js），不再维护
└── docs/
    └── ISSUES_REVIEW.md    上游 issue 的整理
```

## 另一个版本：油猴 / 控制台版

不想装任何东西时用它：把 [`userscript/v3_optimized.js`](userscript/v3_optimized.js) 粘贴到课程播放页的控制台执行，或者在 Tampermonkey 里导入 [`userscript/v3_optimized.user.js`](userscript/v3_optimized.user.js)。完整说明见 [`userscript/README.md`](userscript/README.md)。

它的点击是页面脚本合成的，`event.isTrusted` 恒为 `false` 且无法伪造；窗口失焦后页面也能察觉。页面只要检查这两点，油猴版就藏不住，这时请用 Playwright 版。

## 测试

```bash
# Playwright 版
cd playwright
npm run test:unit       # 不需要浏览器
npm test                # 单元 + 端到端（需要本机装了 Chrome）

# 油猴版（改了 v3_optimized.js 之后）
node userscript/build.mjs
node userscript/tests/verify-v3.mjs
node userscript/tests/humanize-smoke.mjs
```

## 免责声明

本项目仅用于脚本调试、前端自动化研究和页面行为分析，请遵守目标平台的使用规定。
