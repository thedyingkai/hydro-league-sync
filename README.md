# Hydro League Sync

Hydro League Sync 把多所学校各自部署的 Hydro 比赛可靠汇总为一份 ACM/ICPC 联赛榜。学校机房可以继续隔绝外网；只有各校 Hydro 服务器向中心 Hub 上报评测元数据，选手在本校 Hydro 页面查看缓存后的统一榜单。

## 功能

- 学校端持久 outbox、断线重传、心跳和全量 reconciliation，网络中断不丢提交。
- 中心按提交重新计分，不拼接各校名次；CE 不计罚次，打星队展示但不占正式名次。
- public 封榜与 jury 实时视图严格隔离；学校断联时继续展示已有数据并标注榜单可能不完整。
- 复用自托管的 XCPCIO Board scoreboard-only fork，提供 `leagueboard` 与 `league-xcpcio`。
- 复用 HandsomeRun Hydro Realboard 的动画和队列模型，提供 `league-realboard`，不覆盖现有 `realboard`。
- 赛后导出符合 ICPC Contest API `2023-06` 的 Contest Data Package，供 ICPC Tools Resolver 使用。
- Excel 一次生成 Hub 全量配置、每校独立 HMAC 密钥、队伍 UID 映射和题目 PID 映射。

## 组件

- `packages/hydro-league-agent`：面向 `hydrooj@5.0.0-beta.9` 的学校端插件。
- `packages/league-hub`：Fastify + SQLite 中心服务。
- `packages/protocol`：事件协议、HMAC、ACM 计分和 XCPCIO 转换。
- `tools/config-import`：Excel 校验和私密配置生成器。
- `templates/league-participant-template.xlsx`：赛事信息空白模板。
- `deploy/school/install-beta9.sh`：标准 root + PM2 Hydro beta9 安装脚本。
- `deploy/nginx`：公开 HTTPS 反向代理示例。

数据链路：

```text
Hydro record/judge
  -> 本地 MongoDB outbox
  -> 站点独立 HMAC 批量上报
  -> Hub SQLite 幂等存储与统一计分
  -> public/jury、XCPCIO、Contest API、CDP
  -> 学校 Hydro 同源代理和缓存
```

插件只上传榜单必需的评测元数据，不上传代码、测试数据、编译器输出、运行输入输出或账号密码。

## 赛事方部署

要求 Node.js `22.5+`、npm；Docker 部署还需要 Docker Engine 与 Compose v2。

```powershell
git clone https://github.com/thedyingkai/hydro-league-sync.git
Set-Location hydro-league-sync
npm ci
npm run build
npm run typecheck
npm test
```

填写 [参赛信息模板](templates/league-participant-template.xlsx)，然后生成配置：

```powershell
$Workbook = 'C:\contest-private\league-participants.xlsx'
$PrivateDir = 'C:\contest-private\league-2026'
$CenterUrl = 'https://hub.example.edu'

npm run import:config -- $Workbook $PrivateDir $CenterUrl
```

生成目录含管理员令牌、站点密钥和账号映射，必须放在受限私密目录中。不要提交、截图或公开其中的 `.env.hub`、`site-secrets.json`、`hub-config.json` 和 `site-configs/*.json`。

启动本地 Hub：

```powershell
docker compose --env-file "$PrivateDir\.env.hub" -f .\compose.local.yml up --build -d
Invoke-RestMethod http://127.0.0.1:3000/healthz
```

Hub 启动后，使用管理员 Bearer 把完整 `hub-config.json` 全量 `PUT` 到 `/api/v1/admin/config`。配置成功后 `/readyz` 必须返回 200。公网部署应让 Hub 继续只监听回环地址，由 HTTPS 反向代理对外服务；管理配置、封存和发布接口只通过 SSH 隧道或受控管理网络访问。

正式中心可直接加载 Release 中的离线 Docker 镜像归档，不需要在服务器重新构建：

```bash
gzip -dc hydro-league-hub-0.1.0-linux-amd64.docker.tar.gz | docker load
HYDRO_LEAGUE_IMAGE=hydro-league-hub:0.1.0 \
  docker compose --env-file .env.hub -f deploy/hub/compose.remote.yml up -d
```

反向代理示例位于 `deploy/nginx`。先使用 ACME-only 配置签发证书，再切换到 HTTPS 配置；完整顺序见[部署与赛时运行手册](docs/02-部署与赛时运行手册.md#14-https备份与密钥轮换)。

## 学校负责人部署

每所学校需要三份公开 Release 文件和一份私密配置：

1. `hydro-league-agent-0.1.0.tgz`。
2. `install-beta9.sh`。
3. `SHA256SUMS.txt`。
4. 赛事方单独生成的本校 `site-configs/<site-id>.json`。该文件含本校 HMAC 密钥，不得转发给其他学校。

当前发布严格兼容 `hydrooj@5.0.0-beta.9`。先备份 Hydro 数据库、`addon.json`、现有 Addon 目录和 PM2 配置，并确认服务器可访问赛事中心 HTTPS。标准 root + PM2 安装可执行：

```bash
sudo -i
sha256sum hydro-league-agent-0.1.0.tgz
bash /path/to/repository/deploy/school/install-beta9.sh \
  /absolute/path/hydro-league-agent-0.1.0.tgz
```

脚本会先核对 Release 包 SHA-256 和宿主机 `hydrooj@5.0.0-beta.9`，备份旧状态、使用包内锁定的纯 JavaScript 运行依赖、确认插件内没有第二套 Hydro 或 React、登记 Addon、重启 PM2 并检查本机健康页。安装过程不访问 npm registry。安装器不修改已有插件配置；首次安装在没有配置时保持禁用，升级时保留原配置。安装失败时脚本恢复原 Addon 注册和目录。非标准 Hydro 用户、非 root 安装或非 PM2 进程请按 [学校端插件说明](packages/hydro-league-agent/README.md) 手工完成同样步骤。

将本校 JSON 内容写入 Hydro 的 `hydro-league-agent` 插件配置范围。配置结构如下，实际值必须以赛事方发放文件为准：

```yaml
hydro-league-agent:
  enabled: true
  centerUrl: https://hub.example.edu
  allowInsecureHttp: false
  leagueId: league-2026
  siteId: school-a
  sharedSecret: <赛事方发放的本站密钥>
  contests:
    - domainId: contest-domain
      contestId: 0123456789abcdef01234567
      teamMapping:
        "1001": TEAM-001
      problemMapping:
        "1": problem-a
```

保存配置并重启 Hydro 后，应完成以下验收：

```bash
pm2 restart hydrooj --update-env
curl -f http://127.0.0.1:8888/
curl -f http://127.0.0.1:8888/hydro-league-agent-source.zip
```

- Hydro 日志出现 `Hydro League Agent enabled for site ...`，没有持续鉴权或 TLS 错误。
- 中心站点状态变为 `ONLINE`，`pending_events=0`、`rejected_events=0`，水位一致。
- 比赛的 `leagueboard`、`league-xcpcio`、`league-realboard` 均可访问。
- 普通账号只能看到 public 视图；比赛管理员可看到 jury 视图。
- 原有本地榜和原 `realboard` 继续可用。

不要手工清空 `league.sync.outbox`。断网期间提交会保留并自动重传；出现 rejected 事件时应保留现场，由赛事方根据中心返回原因处理。

## 文档

- [完整部署与赛时运行手册](docs/02-部署与赛时运行手册.md)
- [学校负责人部署指南](docs/03-学校负责人部署.md)
- [设计与规则说明](docs/01-方案确认.md)
- [插件配置与可靠性模型](packages/hydro-league-agent/README.md)
- [Hydro 5.0.0-beta.9 兼容依据](packages/hydro-league-agent/docs/HYDRO-5.0.0-beta.9.md)

## 本地验证

```powershell
npm ci
npm run typecheck
npm test
```

Hub 公开页是 `http://127.0.0.1:3000/`，健康检查为 `/healthz`，配置后的就绪检查为 `/readyz`。

## 许可证与对应源码

项目采用 AGPL-3.0-only。`LICENSE`、`NOTICE` 和各 package 的 NOTICE 记录许可证与上游归属。Hub 通过 `/source` 提供对应源码 ZIP；学校插件通过 `/hydro-league-agent-source.zip` 提供对应源码。修改后投入网络服务时，必须重新构建并公开与实际运行二进制完全对应的完整源码，同时保留上游版权和许可证。
