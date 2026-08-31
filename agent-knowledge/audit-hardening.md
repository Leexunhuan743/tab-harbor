# 审计加固模式与已知边界

> PR #42 的"看不见的保障"层。改可靠性/边界代码前先读这里，避免重新踩坑。

## 已确立的加固模式（保持这些约定）

### 1. 错误不静默吞掉
- Chrome API 调用失败要么 `console.warn`（带可诊断信息），要么透出到 toast；**绝不 catch 后假装成功**。
- `chromeGroupsLastError` 模式：查询失败保留诊断，dashboard 仅在"整组查询失败且无任何返回"时弹节流 toast（15s 窗口），单组失败不误报。

### 2. 配置导出完整性
- `config-sync.js`：`chrome.storage.local.get(keys[])` 对未设置的键返回 `undefined` 而非缺席；导出时**显式序列化为 null**（`value === undefined ? null : value`），导入端才能把缺失键重置为默认。不要退回 `key in data` 判断（恒为 true，会导致 JSON.stringify 丢弃键）。

### 3. 关闭标签永不误关窗口
- 所有批量关闭走 `closeTabsSafely` → `ensureWindowsKeepLastTab(allTabs, toCloseIds)`：剔除每个窗口的最后一根独苗。**不要直接 `chrome.tabs.remove(toClose)`**。

### 4. 扩展上下文失效自动恢复
- `isExtensionContextInvalidated(err)` 匹配 "Extension context invalidated"；`recoverFromInvalidatedExtensionContext()` 只 reload 一次（防循环）。挂在刷新 catch + `unhandledrejection` 监听上。
- 扩展更新后打开的旧页面会变僵尸，这个机制保证自动重绑。

### 5. 重入锁
- `batchActionInFlight` / `cardActionInFlight` / `pageChipCommitInFlight`：异步操作进行中忽略重复触发。模式：`if (flag) return; flag = true; try {...} finally { flag = false; }`。

### 6. 刷新抑制统一
- 优先 `runWithSuppressedRefresh(task)`（try/finally 必清 `__suppressAutoRefreshUntil`）；手写 `= Date.now()+2000` / `= 0` 清零易漏（提前 return 分支会泄漏 2s 抑制窗口）。**新代码一律用封装**。

### 7. 副作用已发生 ≠ 失败
- 例：`mergeTabsIntoChromeGroup` 组已创建但 rename 失败 → 返回 `{updated:false}`，调用方仍清理会话分配、仍提示"已合并但命名失败"，而不是"创建失败"。
- 会话清理（saveSessionGroups）失败但 Chrome 组已建 → 明确 toast `toastBatchMergeCleanupFailed`，不假装没发生。

### 8. stale-retry
- 对 tab id 批量 API（group/ungroup/close/discard）先用 `tabs.get` 校验存活，失效 id 剔除后重试一次；全死/全活则原样抛错。渲染与点击之间的竞态不该让整批失败。

## 已知 P2 边界缺陷（暂不修，改动相关代码时注意）

1. **`chromeGroupColor` 注入面**（buildPageChipHtml）：`#` 开头的颜色值未经格式校验直接进 `style="--chrome-group-color:..."`，来源含配置导入路径。建议 `^#[0-9a-fA-F]{6}$` 正则校验（`sanitizeChromeGroupColor`）。
2. **恢复轮询风暴**：`discardRestoredTabAfterCommit` 每标签 100ms 轮询 × N 标签 × 最长 15s，大会话（50+ 标签）时大量 `tabs.get`。优化方向：单个 `tabs.onUpdated` 集中消费 + 15s 兜底。
3. **`__suppressAutoRefreshUntil` 魔法字符串**：散落多处、语义弱。长期应收敛为带深度的作用域工具（`withSuppressedRefresh`）。
4. **`createProperties.windowId` 需 Chrome 111+**：低版本 `tabs.group` 忽略该参数，恢复的组可能落回调用者窗口。低优先级。
5. **AGENTS.md 的 lat.md 工作流未落地**：PR #42 在 AGENTS.md 追加了 lat.md 知识库指令，但仓库无 `lat.md/` 目录、无依赖。改 AGENTS.md 前先确认是否要启用 lat 体系。

## 已修复（原 P2 → 现状）

1. **grace 期空白去重缺口**（background.js，已修复）：`closeDuplicateNewTabs` 现由 `tabs.onCreated`、`tabs.onUpdated`（URL 变为 new-tab 时）与 grace 到期补查（`scheduleGraceExpiryCheck`，5s+200ms）共同触发；`onRemoved` 清理 `createdRecentlyAt` 与 `graceTimers`。带重入锁（`duplicateCloseInFlight` + 计数）合并并发调用。配套：`isNewTabBlank` 归一化 URL（剥离 `?focus=1` 查询串），使 focus-redirect 后的页面仍被识别。**立即关闭语义**：URL 已是明确 new-tab 页（`chrome://newtab/` 或扩展页）的标签不受 grace 豁免——Ctrl+T 重复页立即关闭；grace 豁免只作用于 URL 为空/未提交的标签（保护会话恢复批量创建）。
2. **`createdRecentlyAt` Map 轻微泄漏**（background.js，随 1 修复）：`onRemoved` 与 grace timer 均删除条目。

## 性能注意点

- `closeTabsByUrlsSafely` 非 exact 分支用 `targetHostnames.includes(tabHostname)`（O(n·m)），close-all 场景明显；可改 Set。
- `queryUserChromeGroups` 对每组串行 `await chrome.tabs.query`；组多时可 `Promise.all`。
- `buildDomainGroups` 每次渲染都调用 `queryUserChromeGroups`（tab change 300ms debounce 期间高频）；注意不要在热路径加同步 API。
- 移除过整窗重排（`reorderWindowTabsByDesiredOrder` 已删）：卡片顺序跟随 Chrome 组条顺序，窗口布局交还用户。
