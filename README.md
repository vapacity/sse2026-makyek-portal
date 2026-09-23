# Makyek macOS local edition

这是从原 Makyek Portal、Judge Daemon、Judge 和 libreversi 整理出的独立兼容仓库。上游仓库保持不变；本仓库只做运行于 Apple Silicon macOS 所需的小幅改动。

## 能做什么

- 在 Docker Desktop 中启动 Portal、MongoDB、Redis 和 RabbitMQ。
- 在 Linux ARM64 容器中使用 GCC 编译 C 程序，或使用 G++ 编译 C++17 程序。
- 消费原有 `reversi_compile`、`reversi_judge` 队列。
- 使用原 Judge 运行两份学生程序并回传胜负与日志。
- 保留原有 12×12、输出 `x y` 的裁判协议。

## 安全边界

这是本机开发和课程演示版本，不是面向公网的不可信代码沙箱。Worker 以非 root 用户运行，并应用 Docker 的 capability、进程数和 `no-new-privileges` 限制，但学生程序仍与 Worker 共享容器网络。不要在保存敏感信息的机器上运行未知代码，也不要直接开放到公网。

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
