# dsh-drag-out

把对话末尾的**交付物卡片直接拖到别的应用里**——微信、Word、资源管理器、剪贴板之外的任何能接收文件的地方。

不复制、不中转、不打开文件夹：拖出去的就是磁盘上那个真实文件。

```
对话末尾的产物卡片
┌──────────────────────────────────────────────┐
│ 🖼  final.png   final frame      ⠿ 拖出  ↗   │
└──────────────────────────────────────────────┘
                                  按住往左拖 →
```

## 安装

```sh
dsh plugin add github:RDYRD/dsh-drag-out
```

装完**完全退出 DSH 再启动**——插件加载器只热更 `cordis.patch.yml`，不重载已经加载的 JS。

## 为什么需要它

DSH 的产物卡片点击后只在侧边栏预览。要给微信发图、往 Word 里插图、拖进别的目录，
原来的唯一路径是「打开文件位置 → 再拖一次」。这个插件在卡片右侧加一个抓手，
按住它往目标应用一拖即可。

## 使用

1. 让 DSH 在对话里交付文件（产出的图片、文档、模型等都算）。
2. 对话末尾的产物卡片右侧会出现 **⠿ 拖出** 按钮。
3. **按住**它，移动鼠标（超过 4px 即进入拖拽），拖进微信 / Word / 资源管理器 / 邮件……
4. 松开，完成。

点一下不会打开预览，也不会误触发——只有真的按住并移动才开始拖。

## 只做桌面应用

浏览器标签页里看不到这个按钮。原生文件拖拽需要 Electron 的
`webContents.startDrag`，浏览器没有等价能力（HTML5 拖拽只能拖「下载链接」，
拖进微信会变成一条消息而不是文件）。插件在 `window.dshDesktop?.fileDrag`
不存在时直接不渲染，所以浏览器里界面完全不变。

## 原理（三段，没有黑魔法）

1. **坐标 → 路径**：卡片给的 `actionUrl` 里带着 `sessionId / seq / index`。
   插件的 Host 端路由 `GET /api/drag-out.resolve` 走
   `sessionQuery.readEvent` + `workspaceFiles.stat`，把这三个坐标还原成
   磁盘绝对路径（和官方「打开方式」按钮同一套鉴权栅栏）。
2. **路径 → 资源地址**：还原出的绝对路径被编成
   `dsh-resource://file/session/<sessionId>/<逐段编码的路径>`。桌面壳只对
   **Session 范围**的地址放行，所以相对路径、跨 Session 的路径都过不去。
3. **资源地址 → 原生拖拽**：浏览器半把地址交给
   `window.dshDesktop.fileDrag.prepare()`，桌面壳校验文件确实是该 Session 里的那个
   普通文件、大小与哈希未变，再借 `getFileIcon` 取图标生成拖拽句柄；
   指针一移动就 `start(handle)` 交给系统，落点应用收到的是真实文件。

整个过程只读：不复制、不改名、不移动、不进回收站。

## 边界

- **文件必须还在**。拖出前桌面壳会重新 stat + 校验哈希；文件被删或被改，
  卡片会显示「拖出失败」而不是拖出一个旧副本。
- **大文件会慢一点**。`prepare` 阶段要读一遍文件算 sha256，几百 MB 的视频
  按下时会有可感知的等待（按钮显示「准备中…」）。
- **跨应用限制来自系统**，不来自插件：某些应用（只收文本输入框的聊天窗口）
  本来就不接收文件拖放。
- **只在桌面应用里出现**，且需要 DSH ≥ 0.2 的桌面壳（`dshDesktop.fileDrag`）。

## 升级 / 卸载

```sh
dsh plugin update dsh-drag-out    # 或重新执行一次 add
dsh plugin remove dsh-drag-out
```

也可以走插件管理器（`plugin_manager` 的 `install_bundle` / `remove_bundle`）。改过
`lib/*.js` 之后同样要**完全退出 DSH 再启动**才生效——加载器只热更
`cordis.patch.yml`。

## 开发

```powershell
node test\probe-host.mjs     # Host 路由：坐标→地址的解析与错误码
node test\probe-client.mjs   # 客户端 bundle：加载、注册、渲染、一次完整手势
```

两个探针都只跑假环境，不碰真实文件，也不启动 DSH。真机行为（拖进微信是否
得到图片）必须手动验证。

## 文件

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | Host 半：`GET /api/drag-out.resolve`，坐标 → Session 资源地址 |
| `lib/client.js` | 浏览器半：`deliverables.file.actions` 里的拖出抓手 |
| `cordis.patch.yml` | bundle 补丁：把 `dsh-drag-out` 的 Host 行插进 profile |
| `test/probe-*.mjs` | 假环境探针 |
