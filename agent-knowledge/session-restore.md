# 会话恢复子系统（tab-sessions.js + dashboard-runtime.js）

> PR #42 的另一个核心：恢复的标签以**休眠状态**启动，恢复的 Chrome 组**钉到目标窗口**，组颜色持久化。

## 数据模型（tab-sessions.js）

- 会话保存为 `savedTabSessions`（chrome.storage.local），含 tabs 与 groups。
- 组 key 前缀：`MANUAL_GROUP_PREFIX = '__session_group__:'`、`CHROME_GROUP_PREFIX = '__chrome_group__:'`。
- **每个会话组记录 `chromeGroupColor`**（PR #42 新增字段，`normalizeSavedGroup` / 序列化全链路透传）——恢复时重建同色组。
- `normalizeString` 对所有输入字段做清洗（trim + 安全化）。

## 恢复流程（restoreSavedTabSession）

```text
runWithSuppressedRefresh(async () => {
  openSavedTabsInCurrentWindow/NewWindow  → 每个 tabs.create 后 discardRestoredTabAfterCommit
  runtimeCreateRestoredSessionGroups       → { state, chromeGroupPlans }
  restoreChromeGroupsForSession(plans, windowId)
  saveSessionGroups(nextSessionGroups)
  renderDashboard()
})
```

### 休眠化（关键，`discardRestoredTabAfterCommit`）

- 恢复即休眠：`tabs.create` 后轮询 `chrome.tabs.get`（100ms，15s 兜底），**等 URL 提交**（非空、非 about:blank、非 chrome://newtab）后立刻 `discardTab`。
- 必须在导航提交后 discard——Edge 上在导航 pending 时 discard 会**取消导航并重置为 about:blank**，保存的 URL 丢失。
- 效果：页面不完整渲染（首字节后即休眠），大会话恢复不爆 CPU/内存，激活时才真正加载。
- 轮询风暴：恢复 N 个标签 = N 个并发轮询循环（最多 15s），大量会话时有资源压力（已知 P2 优化点，见 audit-hardening.md）。

### Chrome 组重建（restoreChromeGroupsForSession）

- `tab-sessions.js` 把 `__chrome_group__:` 组解析为 **plans**（title/color/有序 tabIds）——原生组 id 会话内有效，不能复用，必须重建。
- 重建用 `chrome.tabs.group({ tabIds, createProperties: { windowId } })` **显式钉到目标窗口**（否则 Chrome 默认在调用者窗口建组，恢复时会跨窗口闪跳）。
- 目标窗口已有同名组时自动加 `" (2)"` 后缀独立重建，不并入旧组。
- 一个 URL 在 tabUrls 出现一次但可能对应恢复出的多个 tab，全部进组（`restoredByUrl` 消费语义）。
- 创建/更新失败：`console.warn` 不中断整体恢复。

### 刷新抑制（runWithSuppressedRefresh）

- 恢复会产生大量 tabs-changed 事件 → debounced renderDashboard 反复重绘。整个恢复包在 `runWithSuppressedRefresh` 里，事件回显被压制，恢复流程自己显式渲染一次。
- `__suppressAutoRefreshUntil` 是 2s 抑制窗口；`runWithSuppressedRefresh` 用 try/finally 保证必清零。

## 空白新标签去重豁免（background.js）

- `closeDuplicateNewTabs()` 只在 `tabs.onCreated` 触发，收集空白新标签（chrome://newtab、扩展页、空 URL）关到只剩 1 个。
- **grace 期**：`createdRecentlyAt` Map 记录新建时间，5 秒内（`NEW_TAB_GRACE_PERIOD_MS`）豁免；`tab.discarded` 永远豁免。
- 目的：保护恢复批次——批量 tabs.create 的标签 URL 未提交时看着像"误开的一堆空白页"，不能被去重误杀。
- **已知边界缺陷（P2，暂不修）**：grace 只豁免不补查，快速连开空白页时"开第二个自动清第一个"的体验丢失（实测确认主流场景由页面内 `closeTabOutDupes` 兜底，日常不受影响）。`createdRecentlyAt` Map 条目在 discarded 早退分支不会 delete，长期运行轻微累积。

## 幽灵 chip 防护（tabs.onReplaced）

- OAuth/重定向/预渲染会让 tab 被替换为新的 id（`tabs.onReplaced`）。background 新增监听并广播；dashboard 侧清理该 tab 的会话分配。
- 休眠/关闭前先 `chrome.tabs.get` 校验存活（stale-retry 系列 helper），对幽灵 id 走"已关闭"提示而非静默失败。
- `sleepTabsByIds` 返回 `{discarded, failed, skippedActive, stale, resultsByTabId}` 细分状态。

## 会话恢复入口统一

- `openSessionPickerForTabs(tabIds, source)` 统一了单标签/选中/整组的会话选择器入口（PR #42 重构）。
- 恢复模式：`runtimeGetSavedSessionRestoreMode()` → 'current-window' | 'new-window'。
