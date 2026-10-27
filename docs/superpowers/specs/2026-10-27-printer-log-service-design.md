# 远程打印日志服务设计

目标：让 jy-uni-terminal 主动上报打印插件调用、原生事件和错误，在本服务中持久保存，并通过网页实时排查。当前仓库实现服务、可复制的客户端示例和 Docker 部署文件；不修改相邻 terminal 仓库，不声称自动采集 Android logcat。

采用单进程 Hono + TypeScript + Node.js + SQLite。HTTP JSON 单条/批量上报，SQLite WAL 持久化，SSE 从数据库按递增 ID 推送，断线按 ID 补发。相比 JSON 文件便于检索，相比外部数据库便于单容器部署。

日志字段：deviceId、level（debug/info/warn/error）、tag、message、jobId、sessionId、timestamp（客户端 ISO 时间）、data（JSON 上下文）；服务端生成 id 和 receivedAt。校验整个批次后原子插入，最多 100 条、请求最多 256 KiB。历史按 id 倒序，以 beforeId 分页；按设备、级别、tag、jobId、关键词和服务端接收时间过滤。

POST /api/logs 使用 INGEST_TOKEN；GET /api/logs 与 GET /api/logs/stream 使用 VIEW_TOKEN，Authorization: Bearer。两种 token 至少 16 字符且不同；启动时验证。网页凭据只放当前页面内存，使用 fetch 流携带 Authorization，不把密钥放 URL。静态页面可公开加载，日志数据均需鉴权。GET /healthz 仅返回健康状态。

网页提供中文实时日志台、过滤、历史分页、暂停/继续、断线重连、日志详情及当前已载入日志 JSON 导出。初始历史查询返回 latestId，用作 SSE 游标，避免查询与连接之间丢日志；客户端按 ID 去重并限制显示数量，服务端顺序等待写流，避免积压内存。

默认保留 7 天、最多 100000 条，按服务端接收时间清理，启动、定时和写入时执行相关限制。Docker 多阶段构建，原生依赖在目标 Linux 镜像内安装（预编译包优先，源码编译兜底），非 root 运行，挂载 /app/data，提供独立 docker-compose.yaml（只引用 GHCR 镜像，无 build/源码/.env 依赖）、GitHub Actions 多架构镜像发布流程、健康检查和 Nginx SSE 代理示例。部署限单副本，本地 SQLite 不用于多容器共享。

验证：真实 SQLite 的上报/过滤/分页/重启持久化/清理测试，鉴权、无效 JSON、批量原子性、体积限制、实时推送、游标补发和断开清理；TypeScript 编译；运行进程 HTTP 测试；在 Docker daemon 可用时构建并运行容器。
