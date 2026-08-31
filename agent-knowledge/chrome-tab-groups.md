# Chrome 标签组子系统（chrome-tab-groups-sync.js）

> 本子系统是 PR #42 的核心之一：把 Chrome 原生标签组变成工作台的一等公民，同时让扩展的"镜像组"与"用户自建组"互不干扰。

## 两类组的概念

| 概念 | 说明 | 处理方 |
|---|---|---|
| **镜像组（managed mirror）** | 扩展根据域名卡片自动创建/维护的 Chrome 组，title 由 `getGroupTitle` 生成，受 `syncChromeTabGroups` 管理 | 扩展主动 push |
| **用户自建组（user group）** | 用户在浏览器标签条上手动建的组 | 扩展只读展示为卡片（`queryUserChromeGroups`），绝不 push |

## 关键 API（合并后代码真实符号）

- `syncChromeTabGroups(domainGroups)`：根据 domainGroups 计算 desired 状态，创建/更新/删除镜像组，跳过 `isManual`/`isChromeGroup` 组与 `__session_group__:`/`__chrome_group__:` 前缀组。
- `queryUserChromeGroups(windowId)`：返回该窗口内**未被扩展管理**的原生组（含 title/color/collapsed/minIndex/tabIds），按标签条位置排序。
- `getManagedChromeGroupIds()`：所有受管镜像组 id 集合。
- `loadPersistedChromeGroupMap()` / `persistChromeGroupMap()`：镜像组持久化到 `chromeTabGroupsMeta`。
- `reorderGroupedTabs(chromeGroupId, desiredTabIds, windowId)`：把原生组内标签重排为 desired 顺序；以 **live query 的 windowId 为准**（调用者传的可能过期）；只移动确实在组内的 id；失败 `console.warn` 不静默。
- `collapseChromeTabGroupsInWindow` / expand：只作用于受管镜像组，**不碰用户组**。
- `isGroupIdentityFree(title, color, windowId, currentGroups)` / `pickUncollidingGroupColor(...)` / `currentMappingCandidates(...)`：身份指纹工具。

## 持久化格式（重要）

`chromeTabGroupsMeta` 的格式是 **`{ groupKey: { windowIdStr: { title, color } } }`**（PR #42 从旧的扁平 `{groupKey:{title,color}}` 迁移）。

- 匹配规则：**window + title + color** 三元指纹。重启后 Chrome 重发 groupId，但同窗口内 title/color 保留。
- 兼容：旧扁平快照（无 `title`/`color` 字段在 windowId 层）回退为 `{ any: stored }`，跨窗口匹配。
- **歧义保护**：同窗口出现多个同 title+color 组时，优先复用本次会话已建立的映射（`currentMappingCandidates`），否则跳过自动绑定并 `console.warn`，绝不猜测——防止把用户组误标为镜像。
- 创建新镜像前检查指纹是否已被占用（`isGroupIdentityFree`），撞色则换 palette 颜色（`pickUncollidingGroupColor`）。

## 事件订阅与静默

- `muteChromeGroupEvents()`：短期静默（`chromeEventMuteUntil` 时间戳），防止扩展自己的写操作回显成事件循环。
- `shouldIgnoreChromeEvent()`：只检查静默窗口，**不检查同步开关**——即使 push 关闭，dashboard 仍需实时识别用户组卡片（live 识别）。
- 订阅通道 `subscribeToChromeTabGroupChanges`：dashboard 侧据此触发重渲染。

## Dashboard 侧集成（dashboard-runtime.js）

- `buildDomainGroups` 调用 `queryUserChromeGroups`，把用户组渲染为 `__chrome_group__:<id>` 前缀的卡片，**置于排序卡片之前**（跟随标签条顺序）。
- 用户组卡片不进入持久化顺序：`persistGroupOrder` / `buildPersistentGroupOrderReplacingKey` / `saveGroupTabRowOrder` 都过滤 `__chrome_group__:` key。
- **C7 安全网**：快照里已报告在未受管原生组中的标签，即使 `queryUserChromeGroups` 失败也绝不推入 domain 镜像（`chromeGroupsQueryFailed` 分支）。
- 失败状态：`getChromeGroupsLastError()` 透出诊断，仅整组查询失败且无任何组返回时弹节流 toast（15s 窗口），单组查询失败不误报"没有组"。
- 卡片样式：`chrome-group-card` class + `--chrome-group-color` CSS 变量；Chrome 132+ 自定义颜色为 `#rrggbb` 直接透传。

## 拖拽与 Chrome 组的交互

- **拖入用户组卡片** = `groupTabsWithStaleRetryIntoGroup` 加入原生组（失败则 toast 中止，不静默清会话分配），随后 `reorderGroupedTabs` 同步完整落点顺序。
- **从用户组卡片拖出** = 先 `ungroupTabsWithStaleRetry` 解组再移动。
- **新建手动组** 时，所有当前在 Chrome 组里的选中标签先解组（C23）。

## 已知限制 / 注意

- `reorderGroupedTabs` 的 `createProperties.windowId`（会话恢复用）需要 Chrome 111+；低版本会忽略该参数。
- 镜像组 title+color 是身份指纹的一部分，**palette 顺序必须保持稳定**（注释明确警告），改 `GROUP_COLORS` 顺序会导致重启后镜像重影/误绑。
- 会话恢复的 `__chrome_group__:` 组重建逻辑见 `session-restore.md`，由 `tab-sessions.js` 生成 plans、`dashboard-runtime.js` 执行。
