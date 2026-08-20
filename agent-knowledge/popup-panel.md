# Popup 面板子系统（extension/popup/）

> popup 是扩展工具栏弹出窗，两个视图：**快捷方式（shortcuts）** 和 **打开的标签页（tabs）**。PR #42 的目标：与主页面行为对齐 + 修掉一批交互回归。

## 双视图与记忆

- `POPUP_VIEW_KEY = 'popupView'`：视图偏好，**双源同步**——首帧用 `localStorage`（快），随后 `loadPopupView()` 用 `chrome.storage.local` 读取权威值（配置导入/导出走 chrome.storage），不一致时**写回 localStorage** 防止两处永久分叉。
- `syncPopupView()`：切换 `is-active` 高亮与 `hidden` 面板，并控制入场动画。

## 动画契约（关键）

- `lastSyncedPopupView` 记录上次同步的视图；**只有视图真的切换**（`viewChanged`）才加 `is-entering` 动画类。
- **后台刷新（同视图重渲染）不加动画类，反而主动 `remove('is-entering')`**——否则残留的 `is-entering`（opacity:0）会让更新后的内容永久透明，这是当初"面板空白回归"的根因。
- 动画触发用双 `requestAnimationFrame` 后再加 `is-ready`，保证首帧内容先画出再动。
- 改 popup 渲染/刷新时务必保持这个契约：刷新绝不能重播入场动画。

## 尺寸与滚动

- `max-height: 520px`（原来恒 600px），内容少收缩、多撑满不溢出。
- 所有滚动容器统一隐藏滚动条（`scrollbar-width: none` + `::-webkit-scrollbar`），横向滚动保留但不可见。

## 打开的标签页视图（对齐主页面）

- **重复 URL 全显**：移除 popup 内组内去重，与主页面一致。
- 按主域归一分组（www 变体合并）；组顺序单次应用。
- 显示重命名分组标签（`groupLabelOverrides`）。
- Gmail 落地规则：关闭 Gmail 组用精确 URL 匹配（`closeTabsExact`），只关收件箱不关邮件线程。
- 刷新健壮性：后台刷新失败保留旧快照，不产生 unhandled rejection。

## 其他

- `popupView` 随配置导出/导入（config-sync.js 的 STORAGE_KEYS 覆盖）。
- popup 测试：`popup/popup.test.js` + `ui-regression.test.js`。
- popup 与 dashboard 共享的 helper 在 `ui-helpers.js`（ICONS、escapeHtml）；popup 不加载全部 dashboard 运行时，注意依赖边界。
