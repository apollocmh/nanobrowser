# Chromium 80 内部版本

## 已确认的产品约定

- 旧版使用 Manifest V2，最低内核 80；新版使用 Manifest V3，最低 Chrome 125。单个 MV2 包不能覆盖已停止支持 MV2 的现代 Chrome。
- 内部旧版验收程序：`D:\Software\Chrome\Chrome80\app\chrome.exe`，文件产品为 Ungoogled Chromium 80.0.3987.149，不能将它写成 Google Chrome 80 验证。
- 扩展本身运行 Agent 和浏览器控制，只通过 `chrome.debugger` 访问 CDP；Puppeteer 是唯一 frame 管理器。不需要本地服务或外部 CDP 端口。
- Chrome 80 用独立伴随窗口承载聊天和审批，窗口按目标标签页绑定。旧版没有浏览器原生标签组，以内部会话标签列表和徽标保留管理能力。
- 名称、Logo、图标、颜色、链接、评分、统计和卸载问卷由 `src/brand.ts` 构建配置控制。默认知安大模型、使用中国科学院信息工程研究所官方标识、无评分/统计外发/卸载问卷；不是运行时换肤。
- 不更改已有存储键；不同扩展 ID 的数据不自动共享。更换安装身份前应导出需要保留的会话。

## 构建和安装

开发环境使用 Node 24 和 `package.json` 固定的 pnpm，内部用户不需要安装 Node。

```powershell
pnpm install --frozen-lockfile
pnpm build:mv2
pnpm build
pnpm zip:mv2
pnpm zip
```

旧版在扩展管理页加载 `dist-mv2`，新版加载 `dist`。使用独立测试 profile 验证升级，避免覆盖用户真实浏览器数据。现代 Chrome 的 MV2 限制不是扩展可以绕开的功能。

若本机 SWC 报缓存 ACL 校验失败，应使用当前用户拥有且祖先目录可信的独立缓存；不要禁用权限校验或扩大用户目录权限。本次开发使用的缓存为：

```powershell
$env:SWC_NATIVE_BINDING_CACHE = Join-Path $env:USERPROFILE '.nanobrowser-swc-cache'
```

## 架构与安全决策

- 旧 `chrome.debugger` 子会话通过非扁平 `Target.sendMessageToTarget` 信封转发，递归解包响应和事件。传输层只维护 session 路由，不维护平行 frame 注册表。
- 旧布局指标统一转换为 CSS 指标，区分浏览器 zoom 与设备像素比例；原 AX 捕获必须核实文档 backend identity。同进程 iframe 不得复用主文档 AX 树。
- 普通观察和视口截图仍保持只读。**经用户明确授权，旧版完整截图可临时调整视口**，在调整期间重新捕获和遮盖敏感字段，完成后恢复视口与滚动。页面对 resize 的脚本响应无法回滚，结果必须说明机制；恢复或遮盖失败不返回图片。
- 手势绑定会话、标签页、文档代次和原始节点。真实输入派发后不重试。Stop、超时、导航、detach 和关页取消手势；清理释放不能造成额外 drop。
- 虚拟鼠标只订阅真实派发通道。pending 分配序号，终态复用同一序号；旧文档和旧序号不能重建覆盖层。截图通过同一装饰隐藏/恢复边界，不在图片里保留 AI 鼠标和边框。
- 保留 Ask/Auto/站点规则、用户专属步骤、页面内容边界和秘密值遮盖。不得为了兼容旧浏览器跳过校验。

## 验证方法与证据

```powershell
pnpm autorun 'host-connection,compatibility,gestures,virtual-mouse' --mv2 --headful --chrome 'D:\Software\Chrome\Chrome80\app\chrome.exe'
pnpm lint
pnpm type-check
pnpm test
```

Chrome 80 必须有窗口运行：旧 Headless 不支持真实扩展。运行器使用隔离临时 profile，所有浏览器启动保留 `--use-mock-keychain`；结果及图片在 `fixtures/.results`。检查记录实际浏览器路径和 user agent，超时也保留已收到的阶段和检查结果。

本地模型 fixture 只证明可重复的 Agent 工具流程；不等同真实模型服务商连通性。没有可用服务或凭据时该项必须标为未测试。

### 当前验证状态（2026-10-21 收尾）

以下均为本机真实浏览器与真实扩展运行的检查结果；构建成功和单元测试不替代浏览器验证。

- Chromium 80（Ungoogled 80.0.3987.149，MV2，有窗口）：`host-connection`、`compatibility`、`compatibility-diagnostics`、`virtual-mouse`、`zoom-coordinates`、`companion-window` 通过；`gestures` 为 **partial**——滑块、自定义排序、canvas、分阶段输入、Stop、敏感目标取消通过，原生 HTML5 拖放按能力探测明确标为 **unsupported**，且在按下前拒绝、不派发 `mousedown`（`fixtures/.results/2026-10-21T04-34-40-260Z-host-connection+compatibility+compatibility-diagnostics+gestures+virtual-mouse+zoom-coordinates+companion-window.json`）。
- Chromium 80 的 1.25 倍缩放：`compatibility` 的完整截图底部哨兵与视口/滚动恢复通过（`04-32-01-358Z-compatibility.json`）；`zoom-coordinates` 记录真实命中与截图证据。
- Chromium 80 设置、欢迎与语音：`ui-compatibility`、`languages`、`welcome`、`voice` 通过（`04-35-48-933Z-ui-compatibility+languages+welcome+voice+save-file.json`；`save-file` 不是已注册检查名，未运行）。`panel-save` 单跑通过（`04-38-48-954Z-panel-save.json`）；`downloads-measure` 在组合中通过。真实用户浏览器中下载/保存可能要求用户确认，这是浏览器行为，检查不绕过。
- Chrome for Testing 125.0.6422.141（MV3，有窗口）：`host-connection`、`compatibility`、`compatibility-diagnostics`、`gestures`、`virtual-mouse`、`zoom-coordinates` 通过（`04-32-49-091Z-host-connection+compatibility+gestures+virtual-mouse+zoom-coordinates+companion-window.json`；`companion-window` 明确不适用于 MV3）。1.25 倍缩放下 `compatibility` 与 `compatibility-diagnostics` 通过（`04-31-43-747Z-compatibility+compatibility-diagnostics.json`）。`ui-compatibility`、`languages`、`welcome`、`voice` 通过（`04-40-44-345Z-ui-compatibility+languages+welcome+voice.json`）。
- Chrome for Testing 155.0.8059.84（MV3，有窗口）：`compatibility`、`gestures`（含 OOPIF 原生拖放与途中取消）、`virtual-mouse`、`zoom-coordinates` 通过（`04-44-02-173Z-compatibility+gestures+virtual-mouse+zoom-coordinates.json`）。
- 单元测试：894 通过、4 跳过、0 失败；`pnpm lint`、`pnpm type-check` 通过。
- 安装包：`dist-zip/internal-browser-assistant-0.3.0-mv2.zip`（MV2，Chrome 80+）与 `dist-zip/internal-browser-assistant-0.3.0-mv3.zip`（MV3，Chrome 125+）。

本轮收尾修复的真实回归：

- Chrome 125+ 的页面缩放：`Page.captureScreenshot` 的 clip 以缩放后的像素为准，此前完整截图只覆盖页面左上角约 1/1.25，底部哨兵为白。现在按 `visualViewport.zoom` 换算；Chrome 80 仍由浏览器自行换算，避免双重缩放。
- Chrome 155 把 `all:initial !important` 展开到 `pointer-events`，使虚拟鼠标宿主变成命中目标。现在对 `all` 简写不设 important，显式属性保持 important；装饰层仍不可命中、不可访问。
- 转录端点固定为官方 URL；进程环境中的 `OPENAI_BASE_URL` 等变量不再可能把用户密钥发往未配置的第三方地址。

未测试 / 保留限制：

- 真实模型服务商连通性未测试：没有可用凭据。fixture 模型只验证可重复的工具流程。
- Chromium 80 原生 HTML5 拖放不支持（CDP 在 Chromium 117 才具备受控拖放），这是协议边界；不伪造 DOM `drop`。
- 需要真实服务或额外环境的其余检查（如 `llm-live`、`eval`）不在本轮范围。

### 品牌与虚拟鼠标（2026-10-21 更新）

- 应用名改为“知安大模型”。工具栏和扩展图标使用中国科学院信息工程研究所官方徽标，设置页与欢迎页使用官方横版标识；官方源文件为 `https://iie.cas.cn/images/iie_logo_20260317.png`，构建资源在 `public/brand/`。
- 虚拟鼠标不再绘制移动轨迹或滚动路径。它只在最后一次点击坐标显示一个鼠标指针图标，点击时播放波纹；图标保持到下一次点击、Stop、页面导航或截图隐藏。移动和滚动事件不生成装饰。

实机验证：

- Chromium 80：`virtual-mouse`、`welcome`、`languages`、`ui-compatibility`、`companion-window` 通过（`05-18-23-881Z-virtual-mouse+welcome+languages+ui-compatibility+companion-window.json`）；装饰截图证据 `05-18-49-390Z-virtual-mouse-2.png` 显示图标停在点击坐标，移动到别处后不跟随。
- Chrome 125：`virtual-mouse`、`welcome`、`languages`、`ui-compatibility` 通过（`05-17-56-682Z-virtual-mouse+welcome+languages+ui-compatibility.json`）。
- Chrome 155：`virtual-mouse` 通过（`05-19-13-134Z-virtual-mouse.json`）。

## 一手参考

- Chrome MV2 时间表：https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline
- 扩展 debugger 子会话：https://developer.chrome.com/docs/extensions/reference/api/debugger
- Chromium 80 协议：https://raw.githubusercontent.com/chromium/chromium/80.0.3987.149/third_party/blink/public/devtools_protocol/browser_protocol.pdl

本仓库任务要求中文沟通、PowerShell 语法、先获取上下文再实施并归档重要决策。本次没有可调用的 Memory、Sequential Thinking 或 Context7 服务；本文件保留可复用的项目知识，不声称调用了不存在的服务。

## 真实拖拽的协议边界与验证记录（2026-10-21）

**Chromium 80 的原生 HTML5 拖放未达成。** Windows 上原生 `draggable` 拖动会进入操作系统拖放循环，实机验证中预发送整段鼠标路径、释放和 CDP Escape 也无法可靠结束；`Runtime` 调用被阻塞。失败证据为 `fixtures/.results/2026-10-21T01-53-00-367Z-gestures.json`（90 秒超时）。纯扩展 CDP 不能将 DOM 合成 `drop` 冒充真实支持。

- Chromium 的原生 CDP 拖放实现来自 [2023-06-28 官方提交 b75ccd7](https://chromium.googlesource.com/chromium/src/+/b75ccd76cbdd53677d4455b2d5722796b8839a1e)。进一步读取发行标签源码确认：[116.0.5845.96](https://raw.githubusercontent.com/chromium/chromium/116.0.5845.96/content/browser/devtools/protocol/input_handler.cc) 没有 `DragController` / `CancelDragging`，[117.0.5938.62](https://raw.githubusercontent.com/chromium/chromium/117.0.5938.62/content/browser/devtools/protocol/input_handler.cc) 已具备。不能仅按提交日期推断最低发行版本为 116。
- Host 通过 `CdpPort.capabilities.nativeDrag` 告知核心该能力，核心不读取浏览器全局对象。旧内核在原生源节点按下前返回 `NOT_INTERACTABLE`，包括默认可拖动的链接、图片和可拖动祖先；页面在按下后才打开 `draggable` 的情况也会在后续输入前检查。旧版另外安装受信任 `dragstart` 阻断守卫，防止鼠标处理器临时启动无法控制的原生拖放。
- 自定义 mouse/pointer 排序、滑块、canvas、分阶段按下/移动/释放继续发送真实 CDP 输入。新敏感目的地取消手势，不在持键时等待审批；取消释放在所有 frame 的守卫下发送。新版使用 `Input.cancelDragging` 取消已开始的原生拖动，不以鼠标释放提交 drop。
- Chromium 80 最新结果：`fixtures/.results/2026-10-21T02-01-40-770Z-gestures.json`，状态 **partial**，滑块、自定义排序、canvas、分阶段输入、跨会话排斥、Stop、敏感目标取消通过；原生 HTML5 明确为 **unsupported**，且断言拒绝前没有派发 `mousedown`。
- Chrome for Testing 125.0.6422.141：`fixtures/.results/2026-10-21T01-58-23-365Z-gestures.json`，真实原生拖放、分阶段原生拖放、拖动途中取消无 drop、同 iframe 及主文档到 iframe 拖放通过。
- Chrome for Testing 155.0.8059.84：`fixtures/.results/2026-10-21T01-59-39-474Z-gestures.json`，还通过跨站 OOPIF 内及主文档到 OOPIF 的原生拖放，事件均为 `isTrusted`，最终业务计数符合预期；新敏感目标取消没有激活目标。
- 手势状态与 probe 定向单元测试共 19 项通过。未将纯函数/fixture 模型结果当成真实浏览器原生拖放证据。

## Chromium 80 同进程 iframe 的 AX 完整性修复

Chromium 80 的 `Accessibility.enable` 只为 CDP session 的根文档保留 AXContext；同进程子文档每次 `getPartialAXTree` 使用临时上下文，相同 DOM backend 节点的 AX nodeId 会跨响应变化。因此不能直接按 AX nodeId 拼接这些响应。[80 版原始实现](https://raw.githubusercontent.com/chromium/chromium/80.0.3987.149/third_party/blink/renderer/modules/accessibility/inspector_accessibility_agent.cc) 的 `getPartialAXTree`、`EnableAndReset` 和 `CreateAXContext` 体现这一生命周期差异。

- `capturePartialDocumentAX` 依赖稳定的 browser backend DOM identity 合并跨响应别名，保留首次返回的真实 AX nodeId，角色、名称、属性仍来自浏览器 AX 协议。父链响应不能覆盖已展开的完整子列表。
- 对明确属于其他文档、被 DOM identity scope 排除的 AX 节点单独记录排除身份；它们不算缺失响应。未知且无法展开的 childId 仍使 capture 失败，查询、时间和节点上限不放宽。
- 实机证据：`fixtures/.results/2026-10-21T02-09-58-841Z-compatibility+observe-tools.json` 中 `compatibility` 通过，两帧各有独立真实 button ref、可信点击分别改变各自文档状态；`observe-tools` 已通过 Embedded 子文档读取和截图，之后遇到既有陈旧工具错误断言（未将整项标为通过）。`02-09-26-118Z-compatibility-diagnostics.json` 记录完整 form 子文档 Coupon / SPRING 内容。
