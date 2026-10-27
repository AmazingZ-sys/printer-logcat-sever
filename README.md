# 远程打印日志服务

Hono + TypeScript + SQLite：接收终端主动上报的打印调用、插件事件和异常，在中文网页中实时查看。单进程提供 API、SSE 和网页；Android 原生 logcat 需要客户端另行采集上报。

## 服务器部署：只需一份 docker-compose.yaml

服务器需要安装 Docker 和 Compose v2。将本项目的 [docker-compose.yaml](docker-compose.yaml) 单独复制到服务器任意空目录；无需源码、Dockerfile、Node.js 或 .env。

编辑 YAML 中的 `INGEST_TOKEN`、`VIEW_TOKEN`，分别设置至少 16 字符且不同的随机密钥（可用 `openssl rand -hex 32` 生成）。之后只运行：

```sh
docker compose up -d
```

Compose 直接拉取 `ghcr.io/amazingz-sys/printer-logcat-sever:latest` 并启动。访问服务器的 3000 端口，输入 `VIEW_TOKEN` 查看日志。终端只配置 `INGEST_TOKEN`，通过 `POST /api/logs` 上报。

**首次部署前须先完成下方的镜像发布。** 这里的镜像地址是本仓库配置的发布目标；仅创建 YAML 不会让远程镜像自动存在。首次发布成功后，若要服务器免登录拉取，需将 GHCR 包的可见性设置为 Public。

```sh
# 查看状态、健康与运行日志
docker compose ps
curl --fail http://127.0.0.1:3000/healthz
docker compose logs --tail=100 -f printer-logs

# 更新到已发布的最新版本（配置会检查并拉取镜像）
docker compose up -d

# 停止服务，保留日志数据
docker compose down
```

日志存放在 Compose 命名数据卷中。升级镜像、重建和停止容器保留日志；`docker compose down -v` 会删除数据。镜像以 `node` 用户（UID/GID 1000）运行，命名卷会初始化写入权限。默认保留 7 天、最多 100000 条，均可直接在 YAML 中调整。

| YAML 配置 | 说明 |
| --- | --- |
| `image` | 已发布的 GHCR 镜像；可将 `latest` 改为已发布的版本标签 |
| `ports: ["3000:3000"]` | 左边为服务器端口，例如改成 `"8080:3000"` |
| `environment.INGEST_TOKEN` | 上报密钥，至少 16 字符 |
| `environment.VIEW_TOKEN` | 查看密钥，至少 16 字符，须与上报密钥不同 |
| `environment.RETENTION_DAYS` | 日志保留天数，默认 7 |
| `environment.MAX_LOGS` | 最大日志条数，默认 100000 |
| `environment.CORS_ORIGINS` | 浏览器来源，默认 `*`，也可填写逗号分隔的明确来源 |

### 镜像发布（维护者）

[.github/workflows/docker-image.yml](.github/workflows/docker-image.yml) 配置了 GitHub Actions：先运行测试和类型检查，再为 `linux/amd64`、`linux/arm64` 构建并推送到 GHCR。发布任务使用 GitHub 自动提供的 `GITHUB_TOKEN`，不需要把个人 token 写进仓库。

- 推送 `main`：发布 `ghcr.io/amazingz-sys/printer-logcat-sever:latest`。
- 推送 `v*` 标签：发布相应版本标签。
- Actions 中手动执行发布流程：使用所选的 `main` 或版本标签。
- Pull Request：只做检查，不推送镜像。

第一次推送代码并等待 Actions 发布成功后，到 GitHub 用户的 Packages 页面找到 `printer-logcat-sever`，在 Package settings 中将可见性改为 Public，服务器即可匿名拉取。若选择保留私有包，服务器需要先用具有 `read:packages` 权限的账号登录 GHCR。

发布状态可在 [GitHub Actions](https://github.com/AmazingZ-sys/printer-logcat-sever/actions) 查看；GHCR 包默认私有及匿名拉取规则见 [GitHub 官方说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

### HTTPS 与 Nginx

公网使用 HTTPS。将 [examples/nginx.conf](examples/nginx.conf) 中域名、证书与 upstream 地址改为实际值，关闭 SSE 代理缓冲并设置长连接超时。Nginx 在宿主机时连接 `127.0.0.1:3000`；同网络的 Nginx 容器可以连接 `printer-logs:3000`。

## 本地开发

需要 Node.js 20.19+ 和 npm；Docker 镜像使用 Node 22。本地首次安装若没有 SQLite 预编译包，需要 Python 3、make 和 C++ 编译器。

```sh
cp .env.example .env
# 编辑 .env 中的 INGEST_TOKEN 与 VIEW_TOKEN
npm ci
npm run dev
```

本地 Node 从 `.env` 读取配置，默认监听 3000，数据库为 `./data/logs.db`。`HOST`、`PORT`、`DB_PATH` 可以在 `.env` 修改；其他日志设置与 YAML 的环境变量同名。启动编译产物时请在仓库根目录执行，并保留 `public/`。

```sh
npm test
npm run typecheck
npm run build
npm start

# 本地镜像验证
# 构建依赖在目标 Linux 镜像内安装，预编译包不可用时自动从源码编译
docker build -t printer-logcat-server:local .
node scripts/smoke-docker.mjs
```

冒烟检查使用临时容器和数据卷，验证非 root 运行、鉴权、上报、SSE、重启持久化与正常停机，并自动清理测试资源。

## API 使用与过滤

下面命令假设当前 shell 已设置 `INGEST_TOKEN`、`VIEW_TOKEN`；环境值请使用自己的真实 token。`/healthz` 公开返回 `{"status":"ok"}`，其余日志 API 均要求对应凭据。

```sh
export BASE_URL=http://127.0.0.1:3000

# 单条上报，成功返回 201 与 {"accepted":1,"ids":[...]}
curl --fail-with-body "$BASE_URL/api/logs" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"deviceId":"terminal-001","level":"info","tag":"printer","message":"打印请求已交给插件","jobId":"job-001","data":{"stage":"accepted","code":0}}'

# 批量上报：一个批次最多 100 条，请求体最多 256 KiB；整体校验、原子写入
curl --fail-with-body "$BASE_URL/api/logs" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"logs":[{"deviceId":"terminal-001","message":"开始调用"},{"deviceId":"terminal-001","level":"warn","message":"检查打印机状态"}]}'

# 读取历史，结果按服务端 id 从大到小排列
curl --fail-with-body --get "$BASE_URL/api/logs" \
  -H "Authorization: Bearer $VIEW_TOKEN" \
  --data-urlencode 'deviceId=terminal-001' \
  --data-urlencode 'level=error' \
  --data-urlencode 'q=缺纸' \
  --data-urlencode 'limit=100'

# SSE：afterId=0 请求仍在保留范围内的日志，按 id 从小到大补发
curl --no-buffer --fail-with-body "$BASE_URL/api/logs/stream?afterId=0" \
  -H "Authorization: Bearer $VIEW_TOKEN"
```

输入必填 `deviceId`、`message`；可选 `level`（`debug` / `info` / `warn` / `error`，默认 `info`）、`tag`（默认 `printer`）、`jobId`、`sessionId`、`timestamp`（ISO 时间字符串）、`data`（JSON）。服务端增加递增 `id`、`receivedAt`；缺少 `timestamp` 时使用接收时间，缺少可选字符串时返回 `null`。

历史与 SSE 共用以下过滤参数，多个条件同时满足才返回：

| 参数 | 含义 |
| --- | --- |
| `deviceId`、`level`、`tag`、`jobId` | 字段精确匹配 |
| `q` | 在 `message` 与序列化 `data` 中按字面搜索关键词 |
| `from`、`to` | 服务端 `receivedAt` 的 ISO 时间范围，不使用终端时间 |
| `limit` | 仅历史查询，默认 100，最多 200 |
| `beforeId` | 仅历史查询，查询该 ID 之前的旧记录 |
| `afterId` | 仅 SSE，补发该 ID 之后的记录；省略则从连接时最新位置开始 |

历史响应为 `{logs, hasMore, nextBeforeId, latestId}`，`latestId` 是查询时全局最新 ID。用它建立 SSE 可接住历史查询与连接之间的新日志；重连时使用最后收到的日志 ID，客户端按 ID 去重。SSE 依次有 `ready`、`log` 和定期 `heartbeat` 事件。过期或超出数量限制的记录已经删除，游标不能恢复这些记录。错误响应为 `{"error":"..."}`，常见状态为 400、401、413 或 500。

## 接入 jy-uni-terminal

复制 [examples/remote-logger.ts](examples/remote-logger.ts) 到终端项目，例如 `src/libs/remote-logger.ts`。该文件为普通 TypeScript，定义了最小 `uni.request` 接口，不引入额外依赖。为每台终端提供稳定的 `deviceId`，会话可使用本次启动生成的 `sessionId`；终端只配置 `INGEST_TOKEN`，不要向终端分发 `VIEW_TOKEN`。移动端应用内的 token 仍可能被提取，应按部署需要轮换并限制服务入口。

```ts
import { createRemoteLogger } from '@/libs/remote-logger';

export const printerLogger = createRemoteLogger({
  baseUrl: 'https://logs.example.com',
  ingestToken: '<your-ingest-token>',
  deviceId: 'terminal-001', // 替换为终端自己的持久化设备标识
  sessionId: `boot-${Date.now()}`,
});
```

在 Android 启动初始化中**仅订阅一次**打印插件事件（当前终端接口位于 `src/libs/printer/index.ts` 的 `onPrinterEvent`，本次检查约第 627 行）；不要在页面每次进入时反复订阅。按项目现有导入方式取得 `onPrinterEvent` 后，将下面回调接入既有启动流程：

```ts
import { onPrinterEvent } from '@/libs/printer';

onPrinterEvent((event) => {
  if (event.type !== 'event') return; // ready 是订阅就绪事件
  const eventCode = Number(event.code); // 插件可能返回数字或字符串
  // code=0 表示已发送，1 表示 error，2 表示 warn；code=10 可能没有 jobId。
  printerLogger.log({
    level: eventCode === 1 ? 'error' : eventCode === 2 ? 'warn' : 'info',
    tag: 'printer.event',
    message: event.message || '收到打印插件事件',
    jobId: event.jobId === undefined ? undefined : String(event.jobId),
    data: { eventType: event.eventType, code: event.code },
  });
}, (error) => printerLogger.error(error, { tag: 'printer.listener' }));
```

在真实业务打印入口的 `try/catch` 处记录请求与异常。底层 `callNative` 位于同一文件（本次检查约第 222 行）；`accepted` / `code=0` 只能说明请求被接收或已发送，不能作为纸张实际打印完成的证明。示例中的 `actualPrintCall`、`jobId` 应替换为项目真实调用与任务号：

```ts
printerLogger.log({ tag: 'printer.call', message: '准备调用打印插件', jobId });
try {
  const result = await actualPrintCall();
  printerLogger.log({
    tag: 'printer.call',
    message: '打印请求已被接收，等待插件后续事件',
    jobId,
    data: { stage: 'accepted' },
  });
  return result;
} catch (error) {
  // 仅取 code/message/status/requestId/jobId；保留原业务异常处理。
  printerLogger.error(error, { jobId, tag: 'printer.call' });
  throw error;
}
```

上报使用独立 `uni.request`，不要复用会注入业务 token 的 `UniRequestHelper`。helper 默认每秒最多发一批 20 条、请求超时 2.5 秒、待发队列最多 200 条（另有最多 20 条正在发送）；队列满时丢弃最旧待发记录。网络失败、408、429 与 5xx 最多重试两次，等待 2 秒、4 秒再发；其他错误丢弃该批，避免错误凭据无限重试。所有发送都异步进行，失败不抛入打印流程、不写自身日志，`flush()` 也遵守退避。`stats()` 可读取本地丢弃数量；应用退出或网络长期不可用时允许丢失日志，服务不承诺遥测可靠送达。超时后重试也可能造成重复记录。

helper 将消息截断为 2000 字符，并只发送白名单上下文（`eventType`、`code`、`status`、`requestId`、`stage`、`durationMs`），不要上传原始 PDF、完整打印参数、用户隐私或业务认证头。Android 真机不能用 `localhost` 指向开发机；请用可访问的局域网地址或 HTTPS 域名，并按 uni-app 发布环境配置网络域名和证书。

## 数据与运行边界

仅运行一个服务副本；SQLite WAL 数据库在本地数据卷中，不用于多容器或多机器共享写入。默认保留 7 天、最多 100000 条，按 `receivedAt` 在启动、定时及写入过程中执行清理。错误的终端时间不会改变保留期限。日志不是打印结果的唯一凭证，也不替代业务状态核验。

备份前先停止服务，再备份整个数据卷；运行中直接复制单个 `logs.db` 可能遗漏 WAL 中的数据。恢复时保持数据目录属主可被容器 UID/GID 1000 写入，再启动服务。升级镜像、重启容器与 `compose down` 不会主动删除命名卷；要释放数据请先确认备份，再处理数据卷。
