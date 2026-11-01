# ICPC Live：中心、学校和直播端部署手册

本文按“中心服务器 → 各校 Hydro → 直播电脑”的顺序部署榜单、提交和判定数据直播，不要求摄像头、桌面采集或音频。首次部署从第 1 节开始；已有赛事先看[第 4 节](#4-已有中心升级与回退)。完整赛事规则见[中心运行手册](02-部署与赛时运行手册.md)，学校安装细节见[学校负责人指南](03-学校负责人部署.md)。

## 1. 分清三种机器

```text
甲校 Hydro + MongoDB + hydro-league-agent ─┐
乙校 Hydro + MongoDB + hydro-league-agent ─┼─ HTTPS/HMAC → 一个中心 Hub + SQLite
丙校 Hydro + MongoDB + hydro-league-agent ─┘                     │
                                                     HTTPS /api/live
                                                             ↓
                                                  ICPC Live → OBS → 直播平台
```

**学校侧安装的是 Hydro Agent，不需要每校再部署一个中心 Hub。** 各校在自己的 Hydro 建本地比赛和队伍账号，插件上报到同一中心；中心使用全局映射重新计分。选手电脑只访问本校 Hydro，学校服务器需要出站访问中心 HTTPS，不需要公开学校 MongoDB 或选手电脑。

| 角色 | 运行内容 | 持有的凭据 |
| --- | --- | --- |
| 中心服务器 | `league-hub`、SQLite、Nginx | 管理员令牌、各校 HMAC 密钥、直播只读令牌 |
| 每校 Hydro 服务器 | 已有 Hydro、MongoDB、学校插件 | 仅本校 `sharedSecret` |
| 管理机 | Excel 导入、管理和检查工具 | 私密配置主备份 |
| 直播电脑 | Node.js 启动器、Java、ICPC Live，按需 OBS | 仅直播配置中的 `creds.json` |

前提：

- 仓库工具使用 Node.js `22.5+`、npm；Docker 路径需要 Docker Engine 和 Compose v2。
- 学校插件兼容 `hydrooj@5.0.0-beta.9`。标准安装器另外要求 root 所有的 Hydro 数据目录和 PM2 布局，不适用于所有安装方式。
- 验证基线是官方 [ICPC Live v3.5.1](https://github.com/icpc/live-v3/releases/tag/v3.5.1)、Java 17、CLICS `2023_06`。换版本后重新验收。
- 所有服务器可靠校时；配置中的 ISO 时间包含时区。提交时间影响罚时和封榜，时钟也影响 HMAC 验证。
- 正式中心准备域名、HTTPS 证书和持久磁盘；只通过反向代理开放业务入口。

本功能需要**包含 `packages/league-hub/src/live.ts` 的源码/镜像**。旧 `v0.1.2` Release Hub 镜像没有 `/api/live`，只加环境变量不会获得新接口。包版本名仍可能是 `0.1.2`，因此部署记录还要保存源码 commit、镜像 ID 和包 SHA-256。

尚未合并时，从 GitHub PR 的 head 分支检出完整源码；合并后使用正式仓库中包含该功能的提交。`/source` 对应源码 ZIP 用于提供实际 Hub 的对应源码，**不是包含学校模拟环境的完整工作区**；构建学校插件、跑三校演示应使用完整仓库。

## 2. 首次部署 Linux 中心

以下使用 Bash，假设审核后的完整源码位于 `/opt/hydro-league-sync`。示例域名、路径和账号按实际环境替换。不要在学校生产测评机执行中心安装。

### 2.1 安装依赖并准备私密目录

```bash
cd /opt/hydro-league-sync
test -f packages/league-hub/src/live.ts
node --version
npm --version
docker version
docker compose version
npm ci
npm run build
npm run typecheck
npm test

PRIVATE_DIR=/srv/hydro-league/private
sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" "$PRIVATE_DIR"
umask 077
```

配置生成也可在管理机完成，再传到服务器。若服务器只接收预构建镜像和配置，不需要为了 Excel 导入安装 Node 工具链；但下面的管理脚本需要可用的 Node.js，或在管理机通过 SSH 隧道执行。

### 2.2 填写 Excel 并生成配置

复制 `templates/league-participant-template.xlsx` 为工作副本，填写“联赛配置、学校信息、队伍账号映射、题目映射”。表头和完整校验规则见[中心手册第 4 节](02-部署与赛时运行手册.md#4-excel-收集与配置生成)。至少复核：

- 中心联赛 ID、起止/封榜时间、罚时规则。
- 每校站点 ID、Hydro 域 ID、24 位本地比赛 ObjectId。
- 全局队伍 ID 到本地数字 UID 的映射，以及正式/打星属性。
- 每道全局题目到各校数字 PID 的映射，题包/Checker 哈希、时限和内存一致。

```bash
cd /opt/hydro-league-sync
PRIVATE_DIR=/srv/hydro-league/private
npm run import:config -- \
  /srv/hydro-league/source/league-participants.xlsx \
  "$PRIVATE_DIR" https://hub.example.edu
chmod 0700 "$PRIVATE_DIR" "$PRIVATE_DIR/site-configs"
chmod 0600 "$PRIVATE_DIR/.env.hub" "$PRIVATE_DIR"/*.json "$PRIVATE_DIR/site-configs"/*.json
```

| 输出 | 用途/接收者 |
| --- | --- |
| `hub-config.json` | 中心全量配置原件，含全局映射和各站点密钥；仅赛事管理员 |
| `site-secrets.json` | `admin_token`、`broadcast_token`、`sites` 密钥主备份；不发学校或直播端 |
| `.env.hub` | 中心启动环境，包括管理员、直播令牌及断联阈值 |
| `site-configs/<site-id>.json` | 每校只收到自己的文件 |
| `import-report.json` | 导入计数和警告，供管理员核对 |

同一输出目录再次导入会读取已有 `site-secrets.json`，保留现有管理员、学校和直播密钥；不要为了直播升级重新生成全部学校密钥。重导入会重写 `.env.hub`，额外手工添加的变量需另行保留。完整配置和填妥的 Excel 应加密备份，不提交 Git，不公开打印或分发。

### 2.3 构建并启动 Docker

本节统一使用 [`deploy/hub/compose.remote.yml`](../deploy/hub/compose.remote.yml)：服务名 **`hub`**、容器名 **`hydro-league-hub`**、固定持久卷 **`hydro-league-hub-data`**。它与 `compose.local.yml` 的 `league-hub` 服务和项目命名卷不同，不要混用。

```bash
cd /opt/hydro-league-sync
PRIVATE_DIR=/srv/hydro-league/private
IMAGE_TAG="hydro-league-hub:live-$(git rev-parse --short HEAD)"
docker build -f Dockerfile.hub -t "$IMAGE_TAG" .
printf '%s\n' "$IMAGE_TAG" > "$PRIVATE_DIR/image-tag"

hub_compose() {
  HYDRO_LEAGUE_IMAGE="$IMAGE_TAG" docker compose \
    --env-file "$PRIVATE_DIR/.env.hub" \
    -f deploy/hub/compose.remote.yml "$@"
}
hub_compose up -d hub
hub_compose ps
curl --fail --silent --show-error http://127.0.0.1:3000/healthz
```

远程 compose 的默认镜像标签仍是旧版，必须像上面一样指定新镜像。`pull_policy: never` 表示镜像须预先构建/导入。离线服务器可在构建机执行 `docker save "$IMAGE_TAG" | gzip > hub-live-image.tar.gz`，传输并校验 SHA-256 后在服务器执行 `gzip -dc hub-live-image.tar.gz | docker load`，再使用相同标签启动。

容器内数据库为 `/data/league-hub.sqlite`，宿主端口仅绑定 `127.0.0.1:3000`。首次未导入配置时，`/healthz` 正常、`/readyz` 返回 503 是预期行为。Docker `healthy` 不等于学校已经同步。

后续新开终端时需重新定义 `hub_compose` 函数，设置 `PRIVATE_DIR`，并用 `IMAGE_TAG=$(cat "$PRIVATE_DIR/image-tag")` 恢复部署标签。

### 2.4 导入中心配置

在中心主机通过回环访问管理员接口。以下从文件读取令牌，不将令牌放进命令参数或输出：

```bash
node --input-type=module - "$PRIVATE_DIR" <<'NODE'
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const directory = process.argv[2];
let secrets;
try { secrets = JSON.parse(await readFile(join(directory, 'site-secrets.json'), 'utf8')); }
catch { throw new Error('Unable to read private secrets JSON; inspect the local file'); }
const body = await readFile(join(directory, 'hub-config.json'), 'utf8');
const response = await fetch('http://127.0.0.1:3000/api/v1/admin/config', {
  method: 'PUT',
  headers: { authorization: `Bearer ${secrets.admin_token}`, 'content-type': 'application/json' },
  body, signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error(`Configuration import failed: HTTP ${response.status}`);
console.log('Hub configuration imported');
NODE
curl --fail --silent --show-error http://127.0.0.1:3000/readyz
hub_compose logs --tail 100 hub
```

`PUT /api/v1/admin/config` 是**全量替换**。遗漏旧站点会禁用该站点并清除中心密钥；不要拿单校文件或管理员 GET 的脱敏结果做 PUT。成功后 `/readyz` 应为 200。仅升级已有中心软件时通常不需要再次 PUT。

远程管理机可先执行 `ssh -N -L 3300:127.0.0.1:3000 hub-admin@HUB_SSH_HOST`，保持隧道打开，再把管理请求地址换成 `http://127.0.0.1:3300`。Nginx 公网入口有意拒绝管理员配置、封存和发布请求。

### 2.5 HTTPS 反向代理

域名 DNS 先指向中心，准备 Nginx、Certbot，放行 80/443，3000 不开放公网。以下假设使用 `/etc/nginx/conf.d/` 布局且没有同域名的重复 server 配置：

```bash
cd /opt/hydro-league-sync
DOMAIN=hub.example.edu
sudo install -d -m 0755 /var/www/acme
sed "s/hub.example.edu/$DOMAIN/g" deploy/nginx/hub.example.edu.acme.conf \
  | sudo tee /etc/nginx/conf.d/hydro-league.conf >/dev/null
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/acme -d "$DOMAIN"
sed "s/hub.example.edu/$DOMAIN/g" deploy/nginx/hub.example.edu.conf \
  | sudo tee /etc/nginx/conf.d/hydro-league.conf >/dev/null
sudo nginx -t
sudo systemctl reload nginx
sudo certbot renew --dry-run
curl --fail --silent --show-error "https://$DOMAIN/healthz"
curl --fail --silent --show-error "https://$DOMAIN/readyz"
```

`DOMAIN` 填实际 DNS 主机名。这些命令修改服务器副本，不修改仓库模板。模板使用 `http2 on`；旧 Nginx 若不支持，应按目标版本调整 HTTP/2 配置并确保 `nginx -t` 通过。续期后也须校验并 reload。

流式代理应使用 HTTP/1.1，关闭缓冲、不缓存或合并 NDJSON，并透传 Authorization。模板已设置 `proxy_buffering off`、120 秒读取超时；直播流无新事件时每 15 秒发送空行心跳。

## 3. 各学校操作

### 3.1 已安装学校：保持现有配置

本次直播接入不要求每校另建 Hub，也不要求更换现有 `sharedSecret`。已有学校插件正常同步时，中心升级后先直接联调。当前仓库 Agent 已有 `record/change` 进度与 `record/judge` 终态采集，这不是本次直播接口新增的学校功能。若某校安装了更早的终态采集版本，最终榜仍能接入，但评测中动画可能不完整；先核对该校包来源与采集能力，再决定是否在维护窗口更新。

学校域名、赛事和映射未变时保留原配置。只有新学校、缺少插件或确需更新的学校执行下面安装步骤。

### 3.2 赛事方准备学校安装包

每校仅接收本校 JSON、插件包、安装器及匹配的 SHA-256 清单。需要从当前完整源码制包时，在构建机执行：

```bash
cd /opt/hydro-league-sync
npm ci
npm run build
sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" /srv/hydro-league/delivery
npm pack --workspace hydro-league-agent --pack-destination /srv/hydro-league/delivery
cp deploy/school/install-beta9.sh /srv/hydro-league/delivery/
cd /srv/hydro-league/delivery
sha256sum hydro-league-agent-0.1.2.tgz install-beta9.sh > SHA256SUMS.txt
```

`npm pack` 执行插件 `prepack`：构建、生成源码归档、准备锁定运行依赖。若版本号已更新，同步使用实际输出的包名。不能仅凭文件名 `0.1.2` 识别内容；保存源码 commit 和校验值，通过受控渠道交给学校。

### 3.3 学校首次安装或更新包

先备份 Hydro MongoDB、addon、`addon.json` 和 PM2 配置，并选择维护窗口。标准安装器只支持 root + PM2 的 Hydro `5.0.0-beta.9`；非标准部署按本校已有 addon 管理流程操作，参见[学校指南](03-学校负责人部署.md)，不要尝试不匹配的 Hydro 命令。

假设交付物已在 `/srv/hydro-league-delivery/`：

```bash
cd /srv/hydro-league-delivery
sha256sum -c SHA256SUMS.txt --ignore-missing
AGENT_TGZ=$(realpath ./hydro-league-agent-0.1.2.tgz)
EXPECTED_SHA256=$(awk '$2 ~ /hydro-league-agent-0.1.2.tgz$/ {print $1}' SHA256SUMS.txt)
test "${#EXPECTED_SHA256}" -eq 64
sudo env HYDRO_LEAGUE_AGENT_SHA256="$EXPECTED_SHA256" \
  bash ./install-beta9.sh "$AGENT_TGZ"
```

只有插件包和安装器校验均为 OK 才安装。新自建包与安装器内置旧官方包哈希不同，须显式传入本次交付的已核对哈希，不能删除校验。安装器会备份、登记 addon、重启 PM2 和检查健康页；安装失败回退，不修改已有插件配置。

默认 Hydro 目录 `/root/.hydro`、PM2 进程 `hydrooj`、健康页 `http://127.0.0.1:8888/`。受支持布局的不同参数可通过 `HYDRO_HOME`、`HYDRO_PM2_PROCESS`、`HYDRO_HEALTH_URL` 传入。学校不执行中心 Docker 或中心全量配置 PUT。

### 3.4 核对域、比赛、队伍和题目映射

在 Hydro 现有插件配置入口的 **`hydro-league-agent` 作用域**填写赛事方发放的 JSON 字段。下例只是字段说明，不能直接复用账号、比赛 ID 或密钥：

```yaml
enabled: true
centerUrl: https://hub.example.edu
allowInsecureHttp: false
leagueId: league-2026
siteId: school-a
sharedSecret: <本校独立密钥>
contests:
  - domainId: contest-domain
    contestId: 0123456789abcdef01234567
    teamMapping:
      "1001": TEAM-A-001
      "1002": TEAM-A-002
    problemMapping:
      "101": problem-a
      "205": problem-b
```

| 字段 | 应填内容 | 常见误填 |
| --- | --- | --- |
| `centerUrl` | 同一个中心 HTTPS 根地址 | 本校 Hydro 地址、`/api/live`、本校 127.0.0.1 |
| `leagueId` | 中心联赛 ID | 本地比赛 ObjectId |
| `siteId` | 本校站点 ID，与中心一致 | 多校复用站点和密钥 |
| `domainId` | 本地比赛所在 Hydro 域 ID | 域的展示名称 |
| `contestId` | 本地比赛 URL 对应的 24 位 ObjectId | 比赛标题或中心联赛 ID |
| `teamMapping` 左侧 | 本地数字 UID，以字符串键填写 | 用户名、学号、队伍序号 |
| `teamMapping` 右侧 | Excel 全局队伍 ID | 未登记的自定义队名 |
| `problemMapping` 左侧 | 该域真实数字 PID | 比赛 A/B 题号或题目标题 |
| `problemMapping` 右侧 | Excel 全局题目 ID | 映射到不同题包的题目 |

不同学校允许本地 UID/PID 重复，中心用站点、域、比赛和本地 ID 区分。本校管理员从比赛 URL、账号详情和题目管理信息核对。中心 Excel 映射是权威：变更先修正完整 Excel/中心配置，再更新受影响学校文件，不能仅在插件侧随意改全局 ID。

### 3.5 重启与学校验收

标准 PM2 布局保存配置后执行：

```bash
pm2 restart hydrooj --update-env
pm2 logs hydrooj --lines 200
```

日志应出现 `Hydro League Agent enabled for site ...`，且无持续鉴权/TLS/映射错误。另开终端检查：

```bash
curl --fail --silent --show-error http://127.0.0.1:8888/ >/dev/null
curl --fail --silent --show-error http://127.0.0.1:8888/hydro-league-agent-source.zip >/dev/null
curl --fail --silent --show-error https://hub.example.edu/readyz
curl --fail --silent --show-error https://hub.example.edu/api/v1/leagues/league-2026/sites/status
```

本校应为 `ONLINE`；队列清空并等到下一次心跳后，`pending_events=0`、`rejected_events=0`、`watermark_consistent=true`。持续提交时 ACK 和下一次心跳之间可短暂出现水位不同，观察是否追平，不能只凭一帧判断丢失。

在专用测试比赛提交 CE、WA、AC，核对正确队伍/题目、CE 不罚、WA 罚次、AC 时间和重判；支持进度采集的安装再核对 PENDING/JUDGING → 终态。学校联赛视图路径：

```text
/d/<domainId>/contest/<contestId>/scoreboard/leagueboard
/d/<domainId>/contest/<contestId>/scoreboard/league-xcpcio
/d/<domainId>/contest/<contestId>/scoreboard/league-realboard
```

普通账号取得 public 数据，比赛管理员按 Hydro 权限取得 jury。原本地榜和已有 `realboard` 应继续可用。出现积压不要清空 `league.sync.outbox`，排查后等待 ACK/重传/reconciliation。

## 4. 已有中心升级与回退

保留原数据库、管理员令牌、各校 HMAC 和映射；只补充独立直播凭据并替换中心镜像。不要让所有学校重新配置或更新密钥。

### 4.1 确认原卷并备份

先确认实际 compose、服务名、容器和挂载卷。远程 compose 使用 `hub` / `hydro-league-hub-data`；本地 compose 使用 `league-hub` / 项目命名卷。直接换 compose 可能连到空新卷，应继续使用原部署或执行经过验证的数据迁移。

以下仅适用于原来已用远程 compose 的实例，沿用第 2 节变量和 `hub_compose` 函数：

```bash
docker inspect hydro-league-hub --format '{{json .Mounts}}'
OLD_IMAGE=$(docker inspect hydro-league-hub --format '{{.Image}}')
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_DIR="/srv/hydro-league/backups/$STAMP"
sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" \
  "$BACKUP_DIR" "$BACKUP_DIR/data" "$BACKUP_DIR/private"
printf '%s\n' "$OLD_IMAGE" > "$BACKUP_DIR/old-image-id"
hub_compose stop hub
hub_compose cp hub:/data/. "$BACKUP_DIR/data/"
cp -a "$PRIVATE_DIR/." "$BACKUP_DIR/private/"
hub_compose start hub
curl --fail --silent --show-error http://127.0.0.1:3000/readyz
```

SQLite 使用 WAL，停止 Hub 后复制整个 `/data`，包括存在的 `-wal`、`-shm`，不能只拷主库。备份窗口内学校 outbox 保留待发送事件；不要执行 `down -v`、删除队列或清空卷。

### 4.2 仅补直播令牌

新版导入器会自动生成 `broadcast_token`。已有赛事不必重新导入 Excel；以下脚本仅补充已有私密文件中的直播令牌，不改管理员、站点密钥和学校配置。若两个文件已经有不同直播令牌则停止核对：

```bash
node --input-type=module - "$PRIVATE_DIR" <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
const directory = process.argv[2];
const secretsFile = join(directory, 'site-secrets.json');
const envFile = join(directory, '.env.hub');
let secrets;
try { secrets = JSON.parse(await readFile(secretsFile, 'utf8')); }
catch { throw new Error('Unable to read private secrets JSON; inspect the local file'); }
const environment = await readFile(envFile, 'utf8');
const envToken = environment.match(/^HYDRO_LEAGUE_BROADCAST_TOKEN=(.*)$/m)?.[1].trim();
if (secrets.broadcast_token && envToken && secrets.broadcast_token !== envToken) {
  throw new Error('Existing broadcast tokens differ; reconcile them first');
}
const token = secrets.broadcast_token || envToken || randomBytes(32).toString('hex');
if (Buffer.byteLength(token, 'utf8') < 32 || /[\s#'"`$]/.test(token)) {
  throw new Error('Token must be at least 32 bytes and safe for an unquoted env file');
}
if (token === secrets.admin_token || Object.values(secrets.sites ?? {}).includes(token)) {
  throw new Error('Administrator, broadcast and school credentials must be independent');
}
secrets.broadcast_token = token;
const next = environment.split(/\r?\n/)
  .filter(line => !line.startsWith('HYDRO_LEAGUE_BROADCAST_TOKEN=')).join('\n').trimEnd()
  + `\nHYDRO_LEAGUE_BROADCAST_TOKEN=${token}\n`;
await writeFile(secretsFile, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
await writeFile(envFile, next, { mode: 0o600 });
console.log('Broadcast credential prepared; administrator and school credentials preserved');
NODE
```

脚本针对导入器生成的未加引号 `.env.hub` 格式。原环境若由 secret manager 管理，在原系统中增加等价变量，不另设冲突来源。Hub 从启动环境读取令牌，修改文件后需重建容器。直播凭据不得复用管理员或任一学校 HMAC；检查不通过时修正新增直播凭据即可，不需轮换原站点。

### 4.3 切换镜像

```bash
cd /opt/hydro-league-sync
IMAGE_TAG="hydro-league-hub:live-$(git rev-parse --short HEAD)"
docker build -f Dockerfile.hub -t "$IMAGE_TAG" .
hub_compose up -d --force-recreate hub
hub_compose ps
curl --fail --silent --show-error http://127.0.0.1:3000/readyz
```

执行第 5 节 `live:check`，确认旧学校重新 ONLINE、提交继续增长、原 public/jury 无回归，再用 `printf '%s\n' "$IMAGE_TAG" > "$PRIVATE_DIR/image-tag"` 保存新标签。原配置未变不必再次 PUT，更不要对已封存赛事 PUT。

回退前停止新实例并另存失败现场，在隔离实例用旧镜像与升级前整组备份验证。新版会扩展数据库表，不能假定任意旧版都能读取更新后的库。若升级后已收新事件，不得直接覆盖旧备份丢弃新增数据；先核对学校 outbox/reconciliation 恢复路线，再安排正式切回。

## 5. 直播端配置、Windows/Linux 启动与 OBS

### 5.1 管理员生成直播专用目录

下载官方可运行 JAR，并用 `java -version` 确认 Java 17 或兼容版本。在仓库根目录执行，Windows PowerShell 示例：

```powershell
$PrivateDir = 'C:\contest-private\league-2026'
npm run live:configure -- --hub-url https://hub.example.edu --hub-config "$PrivateDir\hub-config.json" --secrets-file "$PrivateDir\site-secrets.json" --output "$PrivateDir\icpc-live"
npm run live:check -- --hub-url https://hub.example.edu --hub-config "$PrivateDir\hub-config.json" --secrets-file "$PrivateDir\site-secrets.json"
```

Linux 管理机：

```bash
cd /opt/hydro-league-sync
PRIVATE_DIR=/srv/hydro-league/private
npm run live:configure -- --hub-url https://hub.example.edu \
  --hub-config "$PRIVATE_DIR/hub-config.json" --secrets-file "$PRIVATE_DIR/site-secrets.json" \
  --output "$PRIVATE_DIR/icpc-live"
npm run live:check -- --hub-url https://hub.example.edu \
  --hub-config "$PRIVATE_DIR/hub-config.json" --secrets-file "$PRIVATE_DIR/site-secrets.json"
```

`--hub-config` 可换成 `--contest-id league-2026`，二选一。填中心赛事 ID，不填学校比赛 ObjectId；工具自动转换不符合 CLICS ID 规则的中心 ID。`--hub-url` 填根地址，工具自动追加 `/api/live`。远程必须 HTTPS，本机可用 `http://127.0.0.1:3000`。未传 `--secrets-file` 时从环境变量 `HYDRO_LEAGUE_BROADCAST_TOKEN` 读取凭据。

输出目录必须不存在，不覆盖旧配置。产物包含：

- `settings.json`：`type=clics`、`feedVersion=2023_06`、`/api/live`、Basic 用户 `broadcast`。
- `advanced.json`：`unofficial` 组打星、不占正式名次。
- `creds.json`：仅直播只读令牌。
- `start.mjs`、`start.ps1`、`start.sh` 和使用说明。

只把这套目录给直播电脑，不发完整 `site-secrets.json`、`hub-config.json` 或学校密钥。`live:check` 只检查认证、资源与有限时长流式读取，不向 Hub 写数据。备用直播电脑可持有同样的直播目录。

### 5.2 启动 Live

Windows：

```powershell
node --version
java -version
node 'C:\contest-private\league-2026\icpc-live\start.mjs' --jar 'C:\icpc-live\live-v3-3.5.1.jar' --port 8080
```

Linux：

```bash
node --version
java -version
node /srv/hydro-league/private/icpc-live/start.mjs --jar /opt/icpc-live/live-v3-3.5.1.jar --port 8080
```

启动器从 PATH 查找 Java，使用独立配置，设置 `--no-auth` 且只绑定 `127.0.0.1`。保持终端运行，Ctrl+C 停止，不改为公网无认证监听。Live 在远程 Linux、OBS 在本机时，可建立 `ssh -N -L 8080:127.0.0.1:8080 live-operator@LIVE_HOST` 隧道，再使用本机 overlay 地址。

### 5.3 开启组件并加入 OBS

打开 `http://127.0.0.1:8080/admin`，选择并显示 **Scoreboard**，按需显示 **Queue**。真实比赛的普通启动器不会自动替操作员开启组件，本地演示命令会。

也可在 Live 本机执行：

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:8080/api/admin/scoreboard/show
Invoke-RestMethod -Method Post http://127.0.0.1:8080/api/admin/queue/show
Invoke-RestMethod http://127.0.0.1:8080/api/admin/scoreboard
```

Linux 用 `curl --fail -X POST http://127.0.0.1:8080/api/admin/scoreboard/show`，队列路径为 `/api/admin/queue/show`。这是 Live 组件接口，不是 Hub 管理接口。

先在浏览器确认画面，再给 OBS 添加“浏览器”源：

- URL：`http://127.0.0.1:8080/overlay?noStatus&teamMediaAudio=false`
- 宽、高：1920 × 1080。
- 需要透明背景时自定义 CSS：`#root > div { background: unset; }`。

观众直接看网页时也可用中心原有公开榜。OBS 推流平台、推流密钥及音视频场景由赛事方单独配置；数据接口本身不完成平台推流。

## 6. 赛时监控、封榜与成绩发布

公开监控入口：

```bash
curl --fail --silent --show-error https://hub.example.edu/api/v1/leagues/league-2026/sites/status
curl --fail --silent --show-error 'https://hub.example.edu/api/v1/leagues/league-2026/scoreboard?view=public'
```

学校默认约 2 秒 flush、15 秒心跳、5 分钟 reconciliation，直播流每秒检查变更；实际延迟还含评测、网络、Live/OBS，不能承诺固定一秒到屏。学校断联时继续保留已有成绩，通过中心状态页识别不完整；Live 画面不替代站点监控。

**封榜由 Hub 唯一执行。** `/api/live` 投射 public 数据：封榜后提交仍可见，最终判定隐藏；恰好封榜时刻的提交同样隐藏结果。历史重放也遵守当前可见性，不把裁判流混入直播。

直播资源的 `scoreboard_freeze_duration=0:00:00` 是防止 Live 二次封榜的兼容处理，真实冻结状态保留在 `state`。不要把数据源改成原 `/api`、使用 `jury` 凭据或另设 `freezeTimeSeconds`，否则可能提前展示裁判数据，或在中心发布后仍冻结。

结束、封存、公开是不同动作：

1. 到比赛结束时间，public 和直播继续冻结。
2. 确认全校补传、水位、quarantine/mapping audit 和成绩审核后执行 `finalize`，停止后续变更；它本身不解封直播。
3. 审核完需要公开时执行 `publish-results`；若配置 `unfreeze_at` 则按该时间公开，默认导入不自动解封。

下面在中心主机执行一次 `finalize`。审核完后另行将参数改为 `publish-results` 再执行，不把两步连成自动命令：

```bash
node --input-type=module - "$PRIVATE_DIR" finalize <<'NODE'
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const [directory, action] = process.argv.slice(2);
if (!['finalize', 'publish-results'].includes(action)) throw new Error('Invalid action');
let secrets, configuration;
try {
  secrets = JSON.parse(await readFile(join(directory, 'site-secrets.json'), 'utf8'));
  configuration = JSON.parse(await readFile(join(directory, 'hub-config.json'), 'utf8'));
} catch { throw new Error('Unable to read private JSON; inspect the local files'); }
const id = encodeURIComponent(configuration.contest.contest_id);
const response = await fetch(`http://127.0.0.1:3000/api/v1/leagues/${id}/${action}`, {
  method: 'POST', headers: { authorization: `Bearer ${secrets.admin_token}`, 'content-type': 'application/json' },
  body: '{}', signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw new Error(`${action} failed: HTTP ${response.status}`);
console.log(`${action} completed`);
NODE
```

未满足封存条件时返回 409；不要在直播操作中默认加 `force:true` 绕过。封存后不再接受配置或提交写入，CDP/Resolver 流程见[中心手册第 12 节](02-部署与赛时运行手册.md#12-xcpcio-json-与-resolver-cdp)。发布后核对 Hub `frozen=false` 和 Live 补齐判定，无需导入赛后 ZIP。

## 7. 故障定位

按学校采集 → outbox → Hub 站点/映射 → `/api/live` → Live 解析/组件 → OBS 逐段检查。

| 现象 | 检查与处理 |
| --- | --- |
| health 正常、ready 503 | 首次未导入配置，或误切到空 Docker 卷 |
| 直播 API 503 | 启动环境直播令牌未配置/为空；修改 env 后 recreate 容器 |
| 直播 API 401 | Basic 用户为 `broadcast`，密码为直播令牌；不是管理员或学校密钥 |
| 启动或配置提示凭据重复 | 直播、管理员和学校凭据须独立；纠正新增直播凭据即可 |
| 直播 API 404 / contests 空 | 查运行镜像、中心是否配置和中心赛事 ID；旧镜像无此接口 |
| 学校 OFFLINE | 查 Hydro 插件日志、出口 DNS/TLS、中心地址、时钟、站点和密钥；不需开放选手外网 |
| ONLINE 但缺队/题 | 查站点+域+比赛+UID/PID，完整 Excel，quarantine/mapping audit；不删原提交 |
| 网络恢复但积压 | 保留 outbox，等待重试/reconciliation；rejected 事件保留现场按原因处理 |
| 最终成绩正常但无进度动画 | 查该校实际包是否支持 `record/change` 进度采集 |
| live:check 正常但画面空 | Live 控制台显示 Scoreboard/Queue，核对 OBS URL、端口、尺寸 |
| 初载 No group for override | 组尚未载入时可短暂发生；加载后确认 advanced preview 中打星生效 |
| Live 延迟/断流 | 查 Nginx/CDN 缓冲、缓存和超时，确保 15 秒空行心跳通过 |
| 打星占正式名次 | 使用生成的 advanced.json，确认 unofficial 的 isOutOfContest=true |
| Hub 已发布、Live 仍冻结 | 使用 /api/live，删除另加的 freezeTimeSeconds 覆盖，检查日志后重连 |
| 8080 已占用 | 普通启动加 --port 8081，OBS 同步修改；三校演示按终端实际端口访问 |
| 公网管理员接口 404 | Nginx 有意禁止，改在中心回环或 SSH 隧道操作 |

API 根为 `/api/live`，包括 `/contests`、比赛资源与 `/access`，以及比赛下的 `teams`、`organizations`、`groups`、`problems`、`languages`、`judgement-types`、`submissions`、`judgements`、`runs`、`awards`、`state`、`scoreboard`、`event-feed`。断点快照可用 `event-feed?since_token=123&stream=false`。Basic `broadcast:<token>` 和 Bearer 直播令牌均只读，不授权管理、上报、裁判榜或 CDP。

## 8. 本地模拟和真实学校联调验收

### 8.1 单中心预览

在完整仓库完成 `npm ci`、`npm run build`，有可用 Java 后：

```powershell
npm run live:preview -- --jar 'C:\icpc-live\live-v3-3.5.1.jar'
```

Linux 换为 `--jar /opt/icpc-live/live-v3-3.5.1.jar`。它创建临时 Hub 和独立 Live 配置，自动显示榜单/队列，约每 5 秒新增模拟提交，不读取原 Live 配置或真实赛事。支持 `--port 8081`、`--no-open`，Ctrl+C 清理退出。

### 8.2 三校独立进程演练

```powershell
npm run live:multischool -- --jar 'C:\icpc-live\live-v3-3.5.1.jar'
```

启动一个本地 Hub、三个独立 Node 学校模拟器和 Live。每校 3 队、共 6 题，丙校第 3 队打星；每校独立 HMAC、source_seq 和磁盘 JSON outbox，通过实际 Agent `HttpHubTransport` 经 HTTP 上报，收到 ACK 后确认队列。

就绪后每 80 秒一轮：

| 秒数 | 动作与预期 |
| --- | --- |
| 0–20 | 三校 ONLINE，9 队显示，分别产生进度和最终判定 |
| 20 | 乙校模拟断网，本地继续评测并积压；甲、丙校继续更新 |
| 38 | 乙校重连补传，队列下降、水位追平，同一提交不重复 |
| 48 | 丙校历史 WA 重判为 AC，保持原提交 ID 和时间 |
| 80 | 开始下一轮 |

`/demo` 显示各校进程、队列和中心状态，并嵌入 Live。演示用 1 秒心跳、3/6 秒延迟/离线阈值，区别于生产默认值。自动记录一轮可用：

```powershell
npm run live:multischool -- --jar 'C:\icpc-live\live-v3-3.5.1.jar' --no-open --exit-after 65 --report-file 'C:\contest-private\three-school-report.json'
```

这不是三套真实 Hydro/MongoDB，不执行真实编译评测；它验证独立站点、鉴权、HTTP、ACK/补传、计分和 Live。正常自动退出或 Ctrl+C 会停止子进程并清理临时凭据；不要依赖强制关闭终端完成清理。

### 8.3 自动回归及真实比赛验收

常规运行 `npm run typecheck`、`npm test`。使用实际 JAR 验证整个直播链路：

```powershell
npm run test:live-runtime -- --jar 'C:\icpc-live\live-v3-3.5.1.jar' --evidence 'C:\contest-private\live-evidence.json'
```

可加 `--java <java可执行文件>`。它逐队对照解题数、罚时、名次和待判定，覆盖 CE/WA/AC、打星、同秒不同毫秒最后 AC、封榜前 1ms/精确边界/之后、重判、重连、封存与发布；结束后清理进程/临时凭据，不自动下载 JAR。普通 `npm test` 不要求 Java。

正式上线前，用独立测试中心/赛事和各校真实 Hydro 验收，不向正式比赛写测试提交：

1. 各校核对域、比赛 ObjectId、UID/PID，确认队伍/题目数量及归属完整。
2. 提交 CE、WA、AC，核对解题、罚时、时间和打星；支持进度采集的学校再检查评测中状态。
3. 短时阻断测试学校到测试 Hub 的链路，确认其他学校正常；恢复后无遗漏/重复、队列清零、水位一致。不关生产选手网络、不删 outbox。
4. 重判已有提交，确认全局身份和原时间不变，旧判定被替换。
5. 短测试赛设置封榜边界，对照 public/直播隐藏、jury 可见；封存仍冻结，发布后补齐。
6. 重启 Live、断开其数据连接、重启测试 Hub，确认重放恢复；普通学校账号不能取得 jury。
7. 保存中心镜像 ID、源码 commit、每校包 SHA-256、Live 版本、配置备份和验收记录，再安排正式部署。

上线后 `/source` 与学校 `/hydro-league-agent-source.zip` 应提供对应运行二进制的源码，保留 LICENSE、NOTICE 和上游归属。上游参考：[settings](https://github.com/icpc/live-v3/blob/v3.5.1/docs/settings.md)、[advanced](https://github.com/icpc/live-v3/blob/v3.5.1/docs/advanced.json.md)、[OBS](https://github.com/icpc/live-v3/blob/v3.5.1/README.md)。
