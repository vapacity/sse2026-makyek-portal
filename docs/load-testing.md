# 服务器部署准备与压测手册

目标：64 核 / 256 GB RAM / 512 GB 系统盘 / 4096 GB 数据盘，500 名以上学生。本文是待执行方案，不是这台服务器的测试报告。先满足 [安全边界](production-readiness.md)：目前只能在隔离环境运行可信样例，不能把默认配置交给真实学生上传未知程序。

## 1. 先算任务规模，不直接开 500 人提交

500 个新用户在空测试环境首次各提交一次：124,750 场比赛、249,500 个回合。若 500 人已有旧的有效提交，再各提交一份，新提交仍会挑战其他人的可用版本，约为 249,500 场、499,000 个回合。页面访问并发、提交并发、编译并发和测评回合并发是四个不同指标。

```bash
node scripts/capacity-plan.js --students 500
node scripts/capacity-plan.js --students 500 --existing
# 改变假设，不会修改服务配置或执行任务
node scripts/capacity-plan.js --students 500 --parallelism 16 --round-seconds 2 --batch 128 --interval-seconds 1
```

默认单个 Portal 调度器每 3 秒最多处理 32 条任务，理论上约 10.7 次处理/秒，且处理还包含重试和完成清理。仅首次 249,500 个回合的一次投递，理想算术下界就约 6.5 小时；数据库扫描/发送确认/重试会进一步降低实际吞吐。默认测评并行数 2，同样不会因服务器有 64 核自动变快。

以每回合平均 2 秒、16 回合并行为例，纯计算算术下界约 8.7 小时；这不是实测，也不包含编译、排队、回写和数据库开销。必须先测实际平均及长尾回合时长，再决定是否改变赛制。

以每回合日志 128 KiB 假设，首次 500 人约产生 30.5 GiB 原始日志；若接近当前单回合 10 MiB 输出上限，约为 2.38 TiB，尚未包括索引、GridFS 元数据、历史版本、备份和其他数据。4 TB 不能当作无限空间。

## 2. 服务器检查与独立测试栈

先在服务器检查架构和真实挂载，不要只看磁盘标称容量：

```bash
uname -m
lscpu
free -h
lsblk -f
df -hT
docker version
docker compose version
```

若为 ARM64，还要解决 MongoDB AMD64 镜像的模拟/兼容性问题。以下假设你已确认 4 TB 数据盘挂载在 `/data`；如果不是，必须替换成真实的数据盘路径，不能把目录建在系统盘上后误以为已经使用数据盘。

```bash
findmnt --target /data
# 只有确认 /data 是预期数据盘后再执行
sudo mkdir -p /data/makyek-staging/{mongo,redis,rabbit,runtime}
sudo chown 1000:1000 /data/makyek-staging/runtime
export MAKYEK_STAGING_ROOT=/data/makyek-staging

node scripts/deployment-preflight.js --mode staging --compose deploy/compose.staging.yaml
docker compose -f deploy/compose.staging.yaml config --quiet
docker compose -f deploy/compose.staging.yaml up -d --build
docker compose -f deploy/compose.staging.yaml ps
```

使用 Bash 执行上述命令；其他 shell 的目录展开语法可能不同。数据库镜像入口负责初始化数据目录权限；若服务器启用 SELinux 等额外策略，需验证挂载权限，不能简单关闭系统安全机制来绕过。

测试栈固定使用项目名 `makyek-staging`、Portal `127.0.0.1:18888`、RabbitMQ 管理页 `127.0.0.1:15673`。与根目录 `compose.yaml` 是两套独立栈，**不要用 `-f compose.yaml -f deploy/compose.staging.yaml` 合并**；也不要改成和正式栈同一个项目名或同一数据目录。

它保留演示口令，仅限隔离的可信样例测试；不是生产配置。数据目录挂载解决 Mongo/Redis/队列/运行目录的位置，但 Docker 镜像、可写层和 Docker 日志仍在 Docker 的存储根目录；512 GB 系统盘也必须监控。不要在已有服务器上未经备份/维护窗口就迁移 Docker data-root。

基线容器上限为：Portal 4 CPU/4 GiB、Mongo 8 CPU/32 GiB（WiredTiger 缓存 16 GiB）、Redis 2 CPU/4 GiB（3 GiB noeviction）、Rabbit 2 CPU/4 GiB、Compiler 2 CPU/2 GiB、Judge 4 CPU/4 GiB。共约 22 CPU/50 GiB 上限，**不是已测出的最优分配或资源预留**，先留余量给系统、数据库和观测。Judge 仍然只运行 2 个并行回合。

Docker stdout 日志按 20 MiB × 5 文件轮转；应用 debug/error 文件日志分别轮转，不能用 stdout 轮转替代文件日志管理。轮转后的历史不完整，长时间测试需要另行归档关键错误和指标。

## 3. 先验证工具与功能，再测吞吐

```bash
node scripts/test-load-tools.js
```

此命令仅使用本机临时 HTTP 模拟服务，不连接真实应用或数据库。完整功能、并发竞态、资源限制的既有回归仍需先通过（README 的 `test:concurrency` / `test:resources`）；它们不能代替服务器容量测试。不要在正式数据库运行数据准备脚本。

## 4. 只读入口分阶段测试

在服务器本机先做低压基线：

```bash
mkdir -p .loadtest
node scripts/load-test.js --target http://127.0.0.1:18888/ \
  --stages 1,10,50 --duration 30 --think-ms 100 \
  --max-requests 10000 --report .loadtest/read-baseline.json
```

基线通过后，再分级到 `100,200,500`，必要时每级单独运行、保留新报告路径。脚本在单级超过 20% 错误（至少完成 20 次请求）时停止加压；单级不满足退出阈值，也不会进入下一等级。默认结束阈值为错误率 ≤1%、聚合 HTTP P95 ≤1500 ms，可按业务目标用 `--max-error-rate` / `--p95-ms` 调整；这些初始目标未经服务器验证，不代表 SLA。

这里的“500”是闭环虚拟用户数，不是固定 500 RPS。RPS 受延迟和 think time 影响。测试交替请求排行榜 `/` 和登录页 `/login`，检查 HTTP 状态和页面标记；不覆盖静态资源、浏览器渲染、真实登录吞吐或 WebSocket 推送。首次运行/缓存尚未就绪时不直接取结果作为容量上限；先预热并保存冷启动结果作为单独场景。

使用另一台压测机时，需要受控的测试网络或 SSH 隧道；对非本机地址必须加 `--allow-remote --confirm-staging`。经 SSH 隧道得到的容量包含隧道瓶颈，不能当作生产网络上限。压测机自己也可能先达到 CPU、带宽或文件描述符上限。

## 5. 准备少量专用账户

每轮使用新的 `load_*` 前缀。下面先创建 10 个，不直接创建 500 个；不改已有账户，不重复使用旧提交绕过限流：

```bash
mkdir -p .loadtest
umask 077
set -o noclobber
docker compose -f deploy/compose.staging.yaml exec -T \
  -e MAKYEK_LOADTEST_STAGING=yes \
  -e MAKYEK_LOADTEST_PREFIX=load_trial01 \
  -e MAKYEK_LOADTEST_COUNT=10 \
  portal node < scripts/seed-load-accounts.js > .loadtest/accounts-trial01.json
```

JSON 文件含测试账户密码，已由 `.gitignore` 和 `.dockerignore` 排除；仍应仅授权人员读取，不发送到聊天或公开报告。若命令失败，可能已经创建部分测试账户，先核对测试库，不要盲目覆盖文件或重复同一前缀。脚本通过确认变量防误操作，但不能自动证明目标容器不是生产库。

## 6. 真正的提交高峰与后台排空

```bash
node scripts/load-test.js --target http://127.0.0.1:18888/ \
  --scenario submit --confirm-staging \
  --accounts .loadtest/accounts-trial01.json --concurrency 5 \
  --max-wait 600 --poll-ms 2000 --report .loadtest/submit-trial01.json
```

脚本先完成这些用户的登录和 CSRF 获取，再按指定并发发送每用户一次提交，最后独立、限并发轮询最终状态。不会让“等待第一个用户测评完才提交下一个”掩盖提交峰值。登录接口自带约 1 秒延迟，预登录耗时包含在总流程时间中，提交窗口另行报告。

只有所有计划提交最终达到 `effective` 才通过；302 不是测评完成，CE/SE、被限流拒绝、登录跳转、状态缺失或排空超时均不能算有效吞吐。默认源码是仓库可信 C11 示例，可显式指定 `--source` 和 `--compiler gpp10cpp17` 测试 C++。

先做 5/10/20/50 人，再按实际排空时间决定 100/200/500。每个级别最好使用全新的测试实例/数据库；如果保留旧参与者，必须把历史对手计入任务预算，不能仍按空环境计算。

默认 `--pair-budget 5000` 会阻止过大的“新用户初始配对估计”。500 个测试账户至少需要显式批准 `--pair-budget 124750`，但这个估计不是硬性的队列限额，已有历史参与者可使实际比赛更多。不要在前级未排空时直接放开该限制。`--max-wait` 最大允许一天；超过等待时间只把测试判为失败，不会取消队列中的工作。

报告包含计划/实际尝试/接受/最终有效数、提交窗口、端到端完成时间分位数和匿名提交 ID，不包含密码、Cookie、CSRF 或源码。报告使用新文件路径，拒绝覆盖旧文件。由于按周期轮询，端到端时间是客户端观测值，含轮询和请求调度误差，不是精确的回合 CPU 时间。

## 7. 同步采集指标和判断瓶颈

在另一个终端（保持同一 `MAKYEK_STAGING_ROOT`）启动：

```bash
node scripts/collect-load-metrics.js --compose deploy/compose.staging.yaml \
  --duration 600 --interval 10 > .loadtest/metrics-trial01.jsonl
```

采集项目容器 CPU/内存、累计 Block I/O、RabbitMQ ready/unacked/consumer。它不抓取应用密码和完整配置，也不访问其他项目容器；RabbitMQ CLI 兼容性和 Docker 权限需在服务器实际验证。指标查询本身有开销，采样是顺序执行，按实际时间戳分析，不假设严格等间隔。

同时由运维记录主机 CPU、负载、内存、磁盘剩余、磁盘时延/IOPS、容器重启/OOM，以及 MongoDB 查询延迟/连接数和索引表现。该采集器不代替数据库监控。检查 Mongo 中 pending/compiling/running/effective/CE/SE 数量、任务表未完成数与最老任务年龄；不要只看 RabbitMQ ready=0，因为工作可能仍在任务表、编译、运行或等待回写。

判定实例：

- HTTP 快、任务积压上涨：先检查投递批次/扫描耗时、编译消费者、测评吞吐和回写，不要只加 Portal CPU。
- CPU 空闲、投递慢：当前 `tasks.batchSize` / `tasks.interval` 和顺序数据库扫描可能是瓶颈；先测每 tick 耗时与实际投递速率。
- Mongo/磁盘忙、CPU 尚有余量：先优化读写/索引/日志保留，不能只提高并发。
- 错误增多、OOM、磁盘达到预设水位（例如剩余低于 20%，需按实际安全余量调整）：停止新增压力、保留现场，不能继续下一档。

调参每次只变一个变量：先 Judge 并行 `2 → 4 → 8 → 16` 并同步提高其 CPU、内存、进程限额；再独立测编译器副本；最后单独评估调度批次/间隔（如 batch 32/64/128、interval 3000/1000 ms），观察数据库和任务完成清理开销。具体数值只是试验阶梯，不是已验证配置。改 Worker/Portal 模板要重建镜像；多个项目复用同名镜像时要安排维护和固定镜像版本，避免误更新其他栈。

## 8. 故障与停压测

在小数据集上另做：编译中重启 Compiler、对局中重启 Judge、回写时短暂中断网络/Portal，再验证过期任务恢复、最终状态、配额幂等和旧回写拒绝；不要在第一轮 500 人满负载时做故障注入。编译领取默认 3 分钟、回合默认 10 分钟，必须留足恢复观察窗口。

Ctrl+C 停止客户端新请求/轮询，但已接受的后台任务仍会执行。需要冻结测试现场时，只针对独立测试栈停止控制面和 Worker：

```bash
docker compose -f deploy/compose.staging.yaml stop portal compiler judge
```

保留数据库、Redis、RabbitMQ 和报告进行分析；恢复后持久化任务会继续处理。不要单独清空 RabbitMQ 队列或只删提交文档来“清理”，这会破坏状态一致性。本工具不自动清库、不删除正式数据、不修改真实学生账户；采用数据盘 bind 目录的测试栈即使删除 Docker 卷声明，也不会自动删除宿主机目录内的数据。

## 9. 每轮结果表

记录提交 SHA/镜像、硬件与架构、阶段、账户数/历史参与者、客户端并发、Worker 并行/副本、任务调度参数、HTTP P95/P99/错误率、有效提交数、端到端 P95、任务/队列峰值、停止发压到排空的耗时、系统资源峰值、日志增长和故障恢复结果。注明是否通过 SSH 隧道、是否与服务同机发压。

通过标准要由课程要求确定：例如允许学生等待几分钟/几小时、是否需要全量赛制。500 人网页访问成功并不能证明 25 万回合能在教学要求内完成；对这台机器的“生产可用”结论必须等实测和安全阻断项整改后再给出。
