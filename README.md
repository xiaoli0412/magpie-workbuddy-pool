# magpie-workbuddy-pool

把 **WorkBuddy / CodeBuddy 账号池**导入 [magpie（喜鹊）](https://usemagpie.ai)，落成 magpie **原生**登录态，按 **大陆 / 港澳台 / 国际** 分区管理；带**健康检测**、**自动续期**、**页面内直接导入**；与「成长计划 / 任务签到」积分插件共用同一份登录态。

不新造供应商、不写第二个网关、不碰别人的插件。

---

## 它解决的问题

magpie 的一个 provider 本来就能挂多个账号：第一个存键 `<provider>`，第二个起存键 `<provider>#<摘要>`。
所以账号池该做的只有一件事——**按这个形状写进 magpie 自己的登录态库**。

```
~/.config/magpie/plugin-auth.json
  workbuddy#adcf2e8   { accountId: "CN-181****2421",  domain: "www.codebuddy.cn" }
  workbuddy#c5ea34a   { accountId: "HMT-519****4    domain: "www.codebuddy.cn" }
  workbuddy-ai#…      { accountId: "INTL-…",          domain: "www.workbuddy.ai" }
```

于是：

* magpie 的供应商页把它们当**原生账号**显示、轮换、限额、失败转移；
* 任何读同一份登录态的插件（成长计划、任务签到）自动看到它们；
* 不改别人的插件，也不怕社区插件升级覆盖。

实测：

```
$ magpie plugin list
  workbuddy (WorkBuddy, 19 models)  signed in as CN-181****2003
  page  WorkBuddy 账号池 (reads nothing)
  tools magpie-workbuddy-growth-_wb_growth

$ magpie provider test workbuddy
  ✓ chat       4374 ms · hy4-preview

$ magpie tool …_wb_growth --action daily
  账号 a1b2c3d4… 每日活跃：已上报（连登 1 天）      ← 10 个账号全部上报成功
```

---

## 区域：先说清楚哪部分是真的

WorkBuddy 服务端只有**两套构建**，magpie 里就是两个 provider：

| provider | 构建 | API |
|---|---|---|
| `workbuddy` | 中国构建（CodeBuddy 计划） | `https://copilot.tencent.com/v2` |
| `workbuddy-ai` | 国际构建 WorkBuddy AI | `https://www.workbuddy.ai/v2` |

**大陆与港澳台走的是同一套中国构建。** 这一点有实测依据，不是推断：

```
POST /v2/billing/meter/get-user-resource   （唯一暴露地理字段的接口）
大陆池账号  → Region=ap-others  Zone=ap-others-4  RegionId=47
港澳台池账号 → Region=ap-others  Zone=ap-others-4  RegionId=47     ← 完全相同
```

所以本插件的三档是这么定义的，且**在界面里如实标注依据**：

| 分区 | 含义 | 判定依据（按可靠度） |
|---|---|---|
| **大陆** | 中国大陆构建账号 | 导出 `domain` 是 `*.codebuddy.cn` / `*.workbuddy.cn`；11 位 `13x–19x` 手机号 |
| **港澳台** | 中国构建、港澳台号段或港澳台池导出 | 导出里的池标签（如 `origin: "wb852"`）；8 位号码（港澳）；10 位 `09…`（台湾） |
| **国际** | 国际构建账号 | 探针被 `www.workbuddy.ai` 接受；`domain` 是 `*.workbuddy.ai` / `*.codebuddy.ai` |

> **"港澳台"是账号归属标签，不是独立服务区域。** 目前没有任何公开实现（含 4 个主流 2API 项目）建模过港澳台区域；积分包的 `Zone` 也只有 `ap-others` 一类。本插件把它作为**可核对、可手工修正**的标签，而不是编造一个不存在的端点。
> 判不出来时给 **未知**，不硬塞进大陆——判错的代价比留白大。

详细视图里每个账号都能看到它的 `origin / domain / 来源文件`，以及检测时间。

---

## 安装

```bash
# 从 GitHub（本仓库即插件）
magpie plugin add github:<owner>/magpie-workbuddy-pool

# 或本地目录
magpie plugin add D:\path\to\magpie-workbuddy-pool

# 成长计划的工具本体（若还没装，入口包不会自动带出工具）
magpie plugin add npm:magpie-workbuddy-growth-core
```

装好后侧栏 **插件 → WorkBuddy 账号池**。

---

## 用

### 1. 页面里直接导入（推荐）

打开页面 → 展开「导入账号」→ 粘贴导出 JSON，或选择文件（可多选）→ **导入到喜鹊**。

页面把这次导入写进本插件的 options（页面唯一被允许的写通道），插件在下次加载时应用、清空滞留项、刷新快照，页面自动重载显示结果。全程不需要 AI 介入，也不需要命令行。

> 页面运行在沙盒 iframe（`connect-src 'none'`，无网络、无文件系统），所以数据来自插件生成的 `page/data.js`——**只有元数据，不含任何令牌**。

### 2. 命令行导入

```bash
bun tools/import.mjs              # 导入并实测每个账号
bun tools/import.mjs --dry        # 只看结果，不落盘
bun tools/import.mjs --no-probe   # 离线，仅按导出信息判区域
```

把导出文件丢进 `%USERPROFILE%\.config\magpie\workbuddy-pool\` 也可以，CLI 与页面共享同一套导入逻辑（`lib/importer.mjs`）。
不限文件数、不限每文件账号数；数组 / `{accounts:[…]}` / 单对象都认；同 `uid` 多份只留活得最久的那份。

**幂等**：重复导入不多出账号；token 变了原地更新；池里已消失的账号会被清理——**只清理本插件写的**，别人的登录态一根汗毛不动（有测试覆盖）。
写盘前自动备份 `plugin-auth.json.pool.bak`。

### 3. 检测与续期

* **健康检测**：插件加载时（3 小时节流）逐个向 WorkBuddy 验证，结果写进快照；页面用「可用 / 失效 / 登录态缺失 / 检测失败 / 待实测」呈现，过期时间临近会变琥珀色。
* **自动续期**：剩余 < 36 小时的账号用 `POST /v2/plugin/auth/token/refresh` 续期并写回（6 小时节流 + 进程锁，避免重复花掉同一个 refresh token）。WorkBuddy 的 access token 是 **28 天**，日常开着 magpie 就不会掉线。
* `bun tools/verify.mjs [--refresh]` 可随时手动核对全部账号。

### 4. 和成长计划插件

`magpie-workbuddy-growth-core` 直接读 `plugin-auth.json`，筛选条件是：

```js
key.startsWith("workbuddy") && !key.startsWith("workbuddy-ai") && auth.access && !auth.enterpriseId
```

本插件写的键名、字段、以及"不写 `enterpriseId`"完全符合，所以导入后立即可用：

```
wb_growth {action:"status"}   盘点任务树
wb_growth {action:"task"}     点亮并领取
wb_growth {action:"daily"}    每日活跃（点亮连登）
wb_growth {action:"travel"}   猫猫旅行
wb_growth {action:"streak"}   连登补签 / 兑换 / 抽奖
```

只想跑部分账号用 `--uid <前缀>`。

---

## 关于签到，需要如实说明的三件事

| 供应商 | 状态 | 原因 |
|---|---|---|
| WorkBuddy（大陆） | ✅ 可用 | 成长计划插件覆盖任务/连登/旅行/每日活跃；已实测 10/10 账号上报成功 |
| CodeArts / MiniMax / Qoder CN / Trae CN / 商汤小浣熊 | ✅ 可用 | magpie 内置签到，`plugin-checkin.json` 有成功记录 |
| **Qoder** | ⚠️ 厂商限制 | `ineligible`：Qoder 只给「它自己客户端识别到的设备」发积分。装了 Qoder 桌面/CLI 或设置 `QODER_RUNTIME_INFO` 才能签到。本机有 Qoder 数据目录但无 runtime-info 可执行文件 |
| **商汤 SenseNova** | ⚠️ 无可修 | 上游没有每日签到接口，插件也未实现 `auth.checkin`；额度不显示同理（该插件未实现 `auth.usage`） |
| **JoyCode** | ⚠️ 账号问题 | `provider test joycode` → `403 访问受限，请联系管理员开通`：账号未被京东侧开通，与本插件无关 |

本插件不谎称修好了这些：它们不在本插件的写入路径上，改它们要 patch 第三方插件。

---

## 不做什么（以免变成第二个网关）

* 不新造 provider id、不改模型名（`cn:` 前缀那套是网关做法，会污染模型选择器）。
* 不自己实现账号轮换 / 冷却 / 限额——magpie 的 Routing 页已经在做，重复实现会与它的 rests/sticks 打架。
* 不接管会话头、不改写提示词——那是社区 `workbuddy` 插件的地盘。

---

## 文件

```
index.mjs              插件入口：消费页面导入 → 健康检测 → 续期 → 刷新快照（不声明 provider，故零冲突）
lib/pools.mjs          读池、归一化、去重、账号键名
lib/region.mjs         区域判定（构建 → 大陆/港澳台/国际）
lib/importer.mjs       唯一的导入实现（CLI 与插件共用）+ 健康判定
lib/store.mjs          登录态读写（原子写 + 备份）
lib/wb.mjs             WorkBuddy API：探针 / 续期 / 积分 / 模型
lib/snapshot.mjs       快照（仅元数据）
lib/options.mjs        页面 → 插件的信箱（plugins.json 的 pendingImport）
tools/import.mjs       导入 CLI
tools/verify.mjs       验证 CLI
tools/test-*.mjs       四套测试
page/                  界面
```

## 测试

```bash
bun run test
```

* `test-import` — 区域归属、幂等、所有权隔离、秒→毫秒、accountId 必须 ASCII（否则 HTTP 头无法 pin 账号）
* `test-page` — 快照解析、分组、健康折叠、搜索、双语、无令牌外泄
* `test-assets` — 页面完整性、沙盒合规（无内联脚本/样式/外部源）、清单与入口
* `test-roundtrip` — **页面 → options → 插件** 真实往返

## 回滚

```bash
copy %USERPROFILE%\.config\magpie\plugin-auth.json.pool.bak  %USERPROFILE%\.config\magpie\plugin-auth.json
magpie plugin rm github:<owner>/magpie-workbuddy-pool
```

## 许可

MIT
