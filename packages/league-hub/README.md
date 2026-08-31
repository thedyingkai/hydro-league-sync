# Hydro League Hub

中心服务负责接收各学校 Hydro 插件上报的终态评测记录，持久化到 SQLite，按统一映射重新计算 ACM/ICPC 榜单，并直接托管固定版本、二次开发的 XCPCIO Board scoreboard-only fork，同时提供 ICPC Contest API event-feed 与 CDP 导出。

## 本地运行

要求 Node.js 22.5 或更新版本。服务使用 Node 22 自带的 SQLite，启动脚本已包含当前 Node 22 所需的 `--experimental-sqlite` 参数。

```powershell
$env:HYDRO_LEAGUE_ADMIN_TOKEN = "replace-with-a-long-random-token"
npm run dev --workspace @hydro-league-sync/league-hub
```

默认地址是 `http://127.0.0.1:3000`，不会监听局域网或公网地址。生产环境必须显式配置反向代理、HTTPS、管理员令牌和独立站点密钥。

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `HYDRO_LEAGUE_HOST` | `127.0.0.1` | 监听地址 |
| `HYDRO_LEAGUE_PORT` | `3000` | 监听端口 |
| `HYDRO_LEAGUE_DATABASE` | `./data/league-hub.sqlite` | SQLite 文件 |
| `HYDRO_LEAGUE_ADMIN_TOKEN` | 未设置 | 至少 32 个 UTF-8 字节的中心管理员凭据；管理 API 用 Bearer，中央 ICPC Tools 可用 Basic 用户名 `jury`；未设置时管理 API 禁用 |
| `HYDRO_LEAGUE_DELAYED_AFTER_MS` | `45000` | 站点进入 `DELAYED` 的时限 |
| `HYDRO_LEAGUE_OFFLINE_AFTER_MS` | `180000` | 站点进入 `OFFLINE` 的时限 |
| `HYDRO_LEAGUE_AUTH_CLOCK_SKEW_MS` | `300000` | HMAC 时间戳容差 |

## 权限边界

- 公开榜、学校状态和公开 submissions 增量可匿名读取。
- `view=jury`、ICPC Contest API、event-feed 和 CDP 导出必须使用站点 HMAC、中心管理员 Bearer，或中央 ICPC Tools 的 Basic（用户名 `jury`，密码为管理员令牌）。Basic 只允许经 HTTPS 使用。
- 管理配置与 quarantine/mapping audit 只接受中心管理员 Bearer。
- 学校浏览器不应直接连接中心服务；学校 Hydro 插件在确认本地比赛管理员权限后，以站点服务凭证代理 jury 请求。
- 上报事件由共享协议的 strict schema 校验。源码、测试数据、任意 `payload`、运行输入输出等字段会被拒绝且不会持久化。

## 核心 API

| 方法与路径 | 权限 | 说明 |
| --- | --- | --- |
| `GET /healthz`、`GET /readyz` | 匿名 | 存活与就绪检查 |
| `PUT /api/v1/admin/config` | 管理员 | 全量导入联赛、站点、队伍、题目和权威映射 |
| `GET /api/v1/admin/config` | 管理员 | 读取脱敏配置，站点密钥只返回 `has_secret` |
| `GET /api/v1/admin/quarantine` | 管理员 | 未映射事件及原因 |
| `GET /api/v1/admin/mapping-audit` | 管理员 | 客户端全局 ID hint 与权威映射不一致审计 |
| `POST /api/v1/sites/:siteId/events:batch` | 站点 HMAC | 幂等批量 upsert，返回 canonical ACK/high watermark |
| `POST /api/v1/sites/:siteId/snapshot` | 站点 HMAC | 分块全量对账；`snapshot_id + chunk_index` 幂等 |
| `POST /api/v1/sites/:siteId/heartbeat` | 站点 HMAC | 更新活跃状态、本地积压和拒绝事件数 |
| `GET /api/v1/leagues/:leagueId/scoreboard?view=public\|jury` | 公开/受限 | 统一榜单 |
| `GET /api/v1/leagues/:leagueId/xcpcio.json?view=public\|jury` | 公开/受限 | XCPCIO all-in-one JSON；由共享协议转换器生成 |
| `GET /api/v1/scoreboard/xcpcio.json` | 匿名 | Hub 根榜的固定 public XCPCIO 数据源；拒绝全部 query，不能切换 jury |
| `GET /api/v1/leagues/:leagueId/submissions?view=public\|jury&cursor=N` | 公开/受限 | cursor 增量；公开视图不会泄漏封榜后 verdict |
| `GET /api/v1/leagues/:leagueId/sites/status` | 匿名 | `ONLINE/DELAYED/OFFLINE`、最后同步时间及未映射数 |
| `POST /api/v1/leagues/:leagueId/finalize` | 管理员 | 赛后显式封存；默认要求所有站点完整，可明确 force |
| `POST /api/v1/leagues/:leagueId/publish-results` | 管理员 | Resolver 滚榜完成后发布公共最终榜 |
| `GET /api/v1/leagues/:leagueId/cdp.zip` | 受限 | Resolver 用 CDP/event-feed 压缩包 |
| `GET /api/contests/:contestId/event-feed` | 受限 | ICPC Contest API 2023-06 NDJSON event-feed |
| `GET /source` | 匿名 | AGPL 对应源码 ZIP；固定白名单排除数据库、环境文件与运行时密钥 |

`GET /` 只重定向到自托管 XCPCIO wrapper，不包含 Hub 自制的排名表。学校连接状态通过严格的可选 `league_status` 扩展进入 XCPCIO fork，排名表、计分展示、筛选和响应式布局仍由 XCPCIO 实现。

站点 HMAC 头名称与签名算法均来自 `@hydro-league-sync/protocol`。签名覆盖原始 URL（含 query）与原始请求体；时间戳使用 Unix 秒，每个请求必须使用新的 nonce。

## 计分与封榜

- 采用 ACM/ICPC 计分；`COMPILE_ERROR`、系统错误、格式错误、忽略和取消不计罚次。
- 正式队伍参与排名；打星队显示成绩但 `rank` 为 `null`，不挤占正式名次。
- 公开榜在 `freeze_time` 后隐藏结果；默认持续冻结，直到封存和 Resolver 滚榜完成后由管理员调用 `publish-results`。
- 未映射事件持久化到 quarantine，不进入正式榜。客户端提供的全局 ID 只是 hint，中心始终以导入映射为权威。
- 配置导入是全量替换语义：新配置遗漏的旧站点会被禁用并清除站点密钥；snapshot 只做幂等补齐和高水位对账，不自动删除历史提交。
- 任一站点 `DELAYED/OFFLINE`，或心跳报告本地待发送/拒绝事件非零时，继续发布榜单并返回受影响学校及“当前名次可能不完整”的提示。

ICPC Contest API 的 notification token 持久化在 SQLite append-only 日志中。重判会以相同 submission/judgement ID 追加更新通知，Resolver 使用旧 `since_token` 重连时不会漏掉当前重判结果。

## 验证

```powershell
npm run typecheck --workspace @hydro-league-sync/league-hub
npm test --workspace @hydro-league-sync/league-hub
```

测试覆盖 HMAC/重放防护、批次幂等与 source sequence、高水位 ACK、CE 不罚时、正式/打星排名、封榜隔离、站点状态、未映射隔离、cursor 增量、Contest API 与 CDP ZIP。
