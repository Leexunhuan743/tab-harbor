# Tab Harbor Agent Knowledge Base

> 本目录是**仓库知识库**（已提交为仓库规范）：供后续 agent 修改 Tab Harbor 功能时快速建立上下文，随仓库版本化，所有协作者共享。
>
> 沉淀来源：PR #42「快捷链接/搜索引擎/popup 增强 + 审计修复批次」（已合并，merge `9504d6f`），以及对合并后代码的逐行审查。
> 最后更新：PR #42 合并后。

> **维护约定**：改动本目录内容后，保持文档与代码同步——函数/常量名、存储键、行为描述都必须与合并后代码一致（可用 `grep` 核对）；新增子系统时在索引表补一行。

## 使用方式

- 修改某个功能前，先读 `architecture.md`（总览）再读对应子系统的文档。
- 文档中的函数/常量名都是合并后代码里的真实符号，可直接 `grep` 定位。
- 测试命令：`node --test extension/*.test.js`（合并后 422 pass / 0 fail）。

## 文档索引

| 文件 | 内容 | 什么时候读 |
|---|---|---|
| `architecture.md` | 总体架构：模块边界、脚本加载顺序契约、存储键、消息流、运行上下文 | 任何改动之前 |
| `chrome-tab-groups.md` | Chrome 标签组子系统：镜像组 vs 用户组、指纹识别、持久化格式、同步流程 | 改 Chrome 组相关功能时 |
| `session-restore.md` | 会话恢复子系统：休眠化、窗口钉定、chromeGroupPlans、空白去重豁免 | 改保存/恢复会话时 |
| `drag-batch-interactions.md` | 拖拽/多选/批量子系统：选择模型、stale-retry、批量栏、重入锁 | 改桌面页交互时 |
| `popup-panel.md` | popup 子系统：双视图、动画契约、与主页面行为对齐 | 改 popup 时 |
| `audit-hardening.md` | 审计加固模式与已知边界：错误透出、配置导出、上下文失效恢复、已知 P2 缺陷 | 改可靠性/边界时 |
| `pr42-change-map.md` | PR #42 的 29 个提交按 6 大主题归类的地图 | 理解"为什么有这些代码"时 |

## 项目一句话定位

Tab Harbor 是一个**安静的浏览器工作台**（Chrome 新标签页扩展）：把打开中的标签、快捷链接、待读、轻量待办收进同一个本地优先的空间。设计气质：calm / literary / composed，拒绝 SaaS 后台感与装饰性噪音。

## 关键约定（来自 AGENTS.md，务必遵守）

1. 纯 HTML/CSS/有序 `<script>`，**无 bundler/ESM**；脚本加载顺序是运行时契约。
2. 顶层绑定可跨文件冲突；从 `globalThis` 解构时用文件级前缀别名。
3. `extension/app.js` 保持薄编排，不膨胀。
4. 脚本拆分后必查启动失败（`Identifier has already been declared`）。
5. UI 改动跑 `node --test extension/*.test.js`；启动/加载类改动还要真实浏览器验证。
6. 不依赖 hover 承载关键控件；键盘焦点必须可见；reduced-motion 用户不丢状态。
