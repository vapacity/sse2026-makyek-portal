# Makyek macOS local edition

这是从原 Makyek Portal、Judge Daemon、Judge 和 libreversi 整理出的独立兼容仓库。上游仓库保持不变；本仓库只做运行于 Apple Silicon macOS 所需的小幅改动。

## 能做什么

- 在 Docker Desktop 中启动 Portal、MongoDB、Redis 和 RabbitMQ。
- 在 Linux ARM64 容器中使用 GCC 编译 C 程序，或使用 G++ 编译 C++17 程序。
- 消费原有 `reversi_compile`、`reversi_judge` 队列。
- 使用原 Judge 运行两份学生程序并回传胜负与日志。
- 保留原有 12×12、输出 `x y` 的裁判协议。

## 安全边界

这是本机开发和课程演示版本，不是面向公网的不可信代码沙箱。Worker 以非 root 用户运行，并应用 Docker 的 capability、进程数、CPU、内存和 `no-new-privileges` 限制。Linux 下学生程序额外限制地址空间、CPU 时间和派生进程；但仍与 Worker 共享容器网络和文件系统。不要在保存敏感信息的机器上运行未知代码，也不要直接开放到公网。

## 要求

- Apple Silicon 或 Intel Mac
- Docker Desktop
- 第一次构建时可以访问 npm 和 Docker Hub

## 启动

先打开 Docker Desktop，确认引擎已经启动，然后执行：

```bash
cd /Users/zwj/Desktop/程序设计范式2026/makyek-mac
docker compose up -d --build
docker compose ps
```

Portal 地址：<http://localhost:8888>

RabbitMQ 管理页：<http://localhost:15672>，本地账户为 `root` / `local-rabbit`。

## 创建账户

创建管理员：

```bash
docker compose exec portal npm run cli -- \
  DI.models.User.createUserAsync admin admin 000000 Admin admin
```

至少创建两个学生账户，才能生成两两对局：

```bash
docker compose exec portal npm run cli -- \
  DI.models.User.createUserAsync student1 student1 001 Student1 student

docker compose exec portal npm run cli -- \
  DI.models.User.createUserAsync student2 student2 002 Student2 student
```

登录后可提交 [`examples/gomoku-client.c`](examples/gomoku-client.c) 验证完整链路。第一次提交没有对手时会直接生效；第二个用户提交后会产生比赛任务。

提交 C++ 代码时，在页面中选择 **G++ (Linux, C++17)**。已有的 GCC 选项仍用于 C11 代码；先前选错 GCC 而产生的编译错误不会自动改判，需重新提交并选择 G++。

Docker 镜像会使用仓库内的 `config-template.yaml` 生成配置，确保重新克隆后也有同样的编译选项。

## 检查状态

```bash
docker compose ps
docker compose logs -f portal compiler judge
```

RabbitMQ 中 `reversi_compile` 和 `reversi_judge` 队列正常情况下会被 Worker 很快消费。

## 停止

保留数据库：

```bash
docker compose down
```

如果明确要删除所有本地测试数据，再执行：

```bash
docker compose down --volumes
```

## 本机裁判冒烟测试

安装过各子项目依赖并完成构建后，可以不启动数据库直接验证裁判协议：

```bash
npm run smoke:judge
```

测试会编译两份 ARM64 示例程序，运行一场完整对局，并检查退出码和摘要文件。

## 并发与故障恢复

保持原队列名、学生协议和两回合赛制；新增数据库持久化任务表，默认每 3 秒扫描恢复一次。任务可能重复投递，但编译/回合只有一个领取者，旧领取者不能覆盖重试后的结果。编译领取默认 3 分钟过期，回合领取默认 10 分钟过期；服务重启后，过期任务自动重新投递。真正的系统错误 `se` 仍需管理员重测，不会无限重复运行有问题的任务。

默认测评并行数是 2，可在 `services/jd/config-template.yaml` 的 `match.parallelism` 中调整。编译器容器限 2 CPU / 1 GiB，测评容器限 4 CPU / 2 GiB，Portal 限 2 CPU / 1 GiB。提高并行数时必须同步提高测评容器内存和 CPU，避免容器 OOM。模板修改后需要重新构建镜像。

完整回归（先启动 MongoDB、Redis、RabbitMQ）：

```bash
npm run test:concurrency
npm run test:resources
```

测试使用随机命名的独立 MongoDB 数据库、独立 RabbitMQ vhost 和测试用户的配额键；正常结束或断言失败时都会清理，不修改现有账户、提交或正式队列。并发测试包含 32 路提交、重复领取、过期领取恢复、消息发送失败、两个回合同步回写、重复配额扣减，以及真实 C11/C++17 编译和测评全链路。资源测试覆盖内存限额、禁止 fork、无换行输出洪泛、进程清理。

这些是功能和竞态回归，不是千人容量认证。两两全量比赛仍有 O(N²) 的任务数量；本次用分批创建、受控投递和 MongoDB 排名聚合控制瞬时负载，没有改变原赛制。扩大到数百/上千人时，还需要分组赛或抽样赛方案、独立沙箱及真实容量压测。

## 与上游相比的改动

- 用 Babel CLI 替代 Gulp 3 的服务端转译流程。
- Portal 的 Gulp 调整为 Gulp 4 可解析写法。
- 本地 `libreversi` 作为仓库内依赖，不再构建时访问 GitHub。
- `lzma-native` 更新到可在 Node 16/ARM64 构建的版本。
- Windows TDM-GCC 命令改为 Linux GCC，不再生成 `.exe`。
- Windows `winc.exe` 沙箱在本地版中关闭。
- 改用 MongoDB 驱动内置 GridFS，避免旧版 `gridfs-stream` 在 Node 16 下上传编译产物时误报 404。
- 增加完整 Compose、健康检查、非 root Worker 和本地示例客户端。

## 规则与旧学生模板

当前 Judge 是 12×12 连五规则，学生程序协议为：

```text
START black|white  -> OK
TURN               -> x y
PLACE x y
```

旧 `std-client` 的 8×8 跳棋协议与当前 Judge 不兼容，请不要直接提交旧模板。
