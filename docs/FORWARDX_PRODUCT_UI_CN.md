# ForwardX 产品视觉语言

> UI_HANDBOOK 回答「控件应该怎么画」。
> 这份文档回答「**ForwardX 的概念应该长什么样**」。

两份都要读，但顺序是这份在先：先确定你在画的是一个节点还是一条路径，再去
Handbook 查那个控件的尺寸。

---

## 一、问题不在 CSS

ForwardX 的后端已经是一套网络编排系统：

```
单机端口转发 · Tunnel · ForwardX V1/V2 · Multi-hop · Entry Group · Exit Group
Forward Chain · Failover Group · Multi-exit · Relay · Bandwidth Aggregation
DDNS Failover · Latency Probe · Topology · Traffic · Client Subscription
```

而前端主要还是一套 CRUD 管理后台。

这就是为什么把边距、圆角、字号全部调精确之后，界面依然缺一种产品级的分量感 ——
**用户看到的是卡片、输入框、Tab、按钮，而不是节点、链路、流向、健康、切换、策略。**

不是 CSS 不够漂亮。是业务模型没有映射成视觉模型。

一句话定目标：

> **Node 是点，Path 是线，Flow 有方向，Policy 决定路径，Health 决定颜色，Metric 负责反馈。**

---

## 二、六个概念 → 六种画法

| 概念 | 是什么 | 怎么画 | 组件 |
|---|---|---|---|
| **Node** | 一台机器、一个落地、一个中继 | 实心圆点 + 名字 + 注脚 | `PathNode` / `EntityHeader` |
| **Path** | 两个节点之间的关系 | 连线 | `PathEdge` / `NetworkPath` |
| **Flow** | 流量的方向 | 箭头、从上到下 / 从左到右的顺序 | `NetworkPath` |
| **Group** | 一组节点或一组线路 | 容器（缩进、分支符、浅色带） | `PathBranch` |
| **Policy** | 决定走哪条的条件 | 条件行 + 当前生效项高亮 | Phase 5 |
| **Health** | 现在好不好 | **颜色 + 线型**，不是文字 | `StatusDot` / `HealthBadge` |
| **Metric** | 数值反馈 | 数字大、标签和单位小 | `Metric` / `PathMetric` |

### 状态的画法是固定的

| 状态 | 节点颜色 | 连线 | 含义 |
|---|---|---|---|
| `healthy` | 绿 | 实线 | 在跑，探测通过 |
| `degraded` | 琥珀 | 实线 | 在跑，但指标越界 |
| `down` | 红 | 虚线 | 该跑没跑，或探测失败 |
| `standby` | 灰 | 虚线 | 按设计就没在跑：备线、手动停用 |
| `switching` | 路径青 | 脉冲 | 正在切换（唯一的瞬时态） |
| `unknown` | 灰 | 虚线 | **没有结论** |

判定统一在 `shared/networkHealth.ts`，面板、服务端摘要、Telegram 共用一份。

**`unknown` 单列一档是这里最要紧的约定。** 「没上报过」不等于「正常」——
把没有结论的东西显示成绿色，等于让一台已经失联的机器看起来健康。判定函数
拿不到数据一律回 `unknown`，空集合汇总同理。

有了这套规则，**主备、负载均衡、多出口、定时切换都不需要设计第二套 UI**：
备线就是灰点加虚线，切换的瞬间就是脉冲。

---

## 三、页面责任

导航结构不改 —— 它已经正确地对应了产品概念：

| 导航 | 概念 | 这一页负责回答 |
|---|---|---|
| 总览 | System | 有没有问题？现在跑得怎么样？哪里需要我处理？ |
| 主机管理 | Node | 我有哪些机器，它们各自什么状态 |
| 链路管理 | Path | 它们怎么连接，每段多快 |
| 转发规则 | Flow | 流量怎么走 |
| 订阅管理 | Delivery | 怎么交付给客户端 |

不要为了「显得高级」重新发明信息架构。保留名称，统一内部语言。

### 列表和详情各管各的

**列表负责看状态，详情负责看数据。**

上一版主机列表里同时塞了：状态、名称、Agent、IP、地区、计费、CPU、RAM、Disk、
延迟、当前流量、累计流量、uptime、操作 —— 一台机器接近一屏，50 台就是 50 屏。

列表只放能支撑「要不要点进去」这个决定的信息；其余全部进详情。

---

## 四、三种 Surface

| Surface | 是什么 | 画不画框 |
|---|---|---|
| **A** Page Section | 页面级大模块：系统状态、实时流量、需要关注 | 看情况 |
| **B** Entity | 一个真实业务对象：Host / Tunnel / Rule / Subscription | **画** |
| **C** Control | 输入框、Select、Segment、Button | 画 |

**Entity 内部的数据组不再用 Card。** 用间距、分隔线、字号、一条浅色带。

上一版最典型的「普通后台感」就是 Card 里面又 Card，里面再有小 Card ——
HostCard 一张卡里嵌了资源面板、流量面板、分栏盒三层框，而框本身不携带任何
信息，只是在重复画边界。

---

## 五、操作

**一级操作最多两个，其余收进 `···`。**

上一版每张卡底部常驻五个图标（波形、诊断、刷新、编辑、垃圾桶）。问题不是图标
丑，是用户必须记忆每个图标是什么意思 —— 而十二条规则就是六十个图标，那一片
图标本身成了页面上最吵的东西。

菜单里顺序固定，**破坏性操作永远最后、永远红色、永远隔一条线**。这个排序由
`partitionEntityActions` 强制，不依赖调用方自己记得 —— 忘一处的后果是有人误删。

---

## 六、颜色只用语义名

组件里只许出现这两组名字：

```
--fx-healthy / --fx-warn / --fx-down / --fx-standby / --fx-path / --fx-delivery
--fx-network-active / -standby / -degraded / -down / -path / -path-muted
--fx-health-good / -warning / -critical
```

**不许出现 `emerald-500`、`#10b981` 这种。** 调色板颜色说的是「好看」，
语义名说的才是「这是什么」。

图表同理，走 `lib/chartPalette`。前四位刻意绑定状态色 —— 图表里的绿必须是
列表里的绿，否则同一份数据在两个地方是两种颜色。

---

## 七、组件清单

已落地（PR 1）：

```
shared/networkHealth.ts          状态词汇表，前后端共用
components/network/StatusDot     StatusDot · HealthBadge
components/ConnectionPath        PathNode · PathEdge · PathMetric
                                 PathStatus · PathBranch · PathPreview
                                 （默认导出保留旧的 steps API）
components/entity/EntityCard     EntityCard · EntityHeader · EntityBody
                                 EntityDivider · EntityFooter · EntityTag
components/entity/Metric         Metric · MetricGroup · ResourceMeter
components/entity/EntityActions  EntityActions · partitionEntityActions
lib/chartPalette                 图表色板
```

待建：`AppShell`、`PageHeader`、`SectionHeader`、`Sparkline`、`SegmentControl`、
`BottomSheet`、`Drawer`、`OfflineState`、Route Policy 一族。

---

## 八、推进顺序

不要一口气改几万行。每个 PR 只动一层。

| PR | 内容 | 状态 |
|---|---|---|
| 1 | **UI Architecture**：Entity 系列、Path 系列、Health、Metric、色板、本文档。**不大改视觉** | ✅ |
| 2 | **Hosts 2.0**：列表压缩、Summary/Detail 分离、离线态改善、统一 ActionMenu | |
| 3 | **Links 2.0**：TunnelCard / ChainCard / GroupCard / Topology，Tunnels.tsx 拆分到 `features/links/` | |
| 4 | **Rules 2.0**：Rule 从配置卡变成 Flow 卡，创建流程改渐进式披露 | |
| 5 | **Dashboard 2.0**：Health / Traffic / Attention 三段，减少饼图和孤立统计卡 | |
| 6 | **Route Policy**：主备、多线路、定时、自动故障切换、手动、恢复，统一进策略 UI | |
| 7 | Subscription / Settings 迁移 | |
| 8 | **CSS 债清理**：删 legacy override、宽泛选择器、重复样式 | |

**CSS 清理放最后**，不是因为不重要，而是一开始大删很容易引入全站回归 ——
等页面都迁到明确的 class 之后再删，删的是确定没人用的东西。

---

## 九、已知债务

这些是明确看到但本轮没动的，记下来免得以为已经处理了：

- **`workspace.css` 里的宽泛选择器**。`[class*="rounded-"][class*="border"]` 和
  `.workspace-main > .route-content-enter > div > .space-y-6 > * + *` 这类规则
  今天解决了密度问题，但以后加一个业务组件可能莫名其妙被全局 CSS 改掉。
  目标是把 CSS 从「猜 DOM」变成「设计系统 API」：`fx-page` / `fx-section` /
  `fx-entity-card` / `fx-entity-body` / `fx-entity-footer` / `fx-path` 这类明确
  的类名。PR 8 做。
- **`Home.tsx` 里还有 `bg-emerald-500` 的小圆点和徽标**。图表色已经收口，这些
  装饰性的点要等 Dashboard 2.0 换成 `StatusDot`。
- **`Tunnels.tsx` / `Rules.tsx` 是巨型文件**，几乎承载了各自全部业务 UI。
  拆分到 `features/` 在 PR 3 / PR 4。
- **移动端顶栏承担了身份 + 主操作 + 全局操作三件事**，因为正文 H1 在手机上被
  隐藏了。目标形态是 `☰  链路管理  ＋`：右上角只放当前页的主操作，搜索回到
  内容区，主题进账户菜单。
- **桌面端仍是响应式缩放，不是 Master–Detail**。Hosts / Links / Rules 都应该是
  左列表右详情，这比把每张卡做得越来越复杂效果好得多。
- **Globe 是 wow factor，不该承担运维主操作**。链路页最终应有「列表 / 拓扑 /
  地图」三视图，列表是高频管理，拓扑才是生产力。
