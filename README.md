# Makyek Portal — Docker 部署版

学生代码提交、编译和双程序对战测评平台。本仓库整合 Portal、Judge Daemon、Judge 和 libreversi，并补充 Docker Compose 部署、C11/C++17 编译、任务故障恢复和并发回归测试。

**项目不与 macOS 强绑定。** 应用和测评程序运行在 Linux 容器中，宿主机主要负责运行 Docker。macOS 通过 Docker Desktop 启动这些容器，Linux 服务器可通过 Docker Engine 和 Compose 启动同一套服务。

仓库内的 `makyek-mac`（Compose 项目名、npm 包名及测试镜像名）是历史命名，不代表只能运行在 Mac 上。目录名称不影响普通部署；暂不要只修改 Compose 项目名，否则使用固定镜像名的测试构建也需要同步调整。

## 部署范围与验证情况

| 宿主环境 | 当前情况 |
| --- | --- |
| macOS + Docker Desktop（Linux 容器） | 已在 Apple Silicon 本机验证编译、测评、故障恢复和资源限制 |
| x86_64 Linux + Docker Engine / Compose | 配置可沿用，无 macOS 专属运行依赖；尚未在独立 Linux 服务器实测 |
| ARM64 Linux | 应用镜像可按宿主架构构建，但 MongoDB 固定为 AMD64，需要配置跨架构模拟或适配数据库方案 |
| Windows | 未验证；不能使用 Windows 容器模式直接运行这套 Linux 容器配置 |

当前 `compose.yaml` 将 MongoDB 配置为 `mongo:4.4`、`platform: linux/amd64`。Apple Silicon 上的成功运行包含 Docker Desktop 的跨架构支持，不能直接据此认定原生 ARM64 Linux 也能开箱即用。

这是开发、课程演示和受控环境试用版本，不是已经通过公网生产安全认证的测评平台。运行可移植不等于不可信学生代码已被安全隔离。

## 服务组成

| 服务 | 职责 |
| --- | --- |
| `portal` | 页面、账户、提交、测评 API、排名及持久化任务调度 |
| `compiler` | 消费编译任务，使用 GCC / G++ 生成并上传压缩可执行文件 |
| `judge` | 消费对局任务，运行两份学生程序并回传胜负、摘要和日志 |
| `mongo` | 账户、提交、对局、任务表以及 GridFS 二进制和日志 |
| `redis` | 执行配额及重复扣减保护 |
| `rabbit` | 编译队列 `reversi_compile` 和测评队列 `reversi_judge` |

目录说明：

- [services/portal](services/portal)：Web 应用及任务调度。
- [services/jd](services/jd)：编译和测评 Worker。
- [services/judge](services/judge)：游戏裁判。
- [packages/libreversi](packages/libreversi)：本地游戏库。
- [examples/gomoku-client.c](examples/gomoku-client.c)：协议示例客户端。
- [scripts](scripts)：冒烟、并发与资源回归测试。

## 环境要求

计划面向 500 人以上部署时，先阅读 [生产就绪评估](docs/production-readiness.md) 和 [服务器压测手册](docs/load-testing.md)。仓库已准备独立 staging 配置、静态预检、容量估算和压测工具；这些准备不代表已经完成服务器实测或生产安全加固。

- 能运行本项目 Linux 镜像的 Docker 环境。
- Docker Compose V2，使用 `docker compose` 命令。
- 首次构建能访问 Docker 镜像源、npm 及依赖下载地址。
- 足够的 CPU、内存和磁盘，除应用容器外还需为数据库、队列、构建过程预留资源。

Linux 宿主机不需要安装 Docker Desktop；macOS 使用 Docker Desktop 的 Linux 容器环境。通过 Compose 部署时，**宿主机不必另装 Node.js、GCC、G++、MongoDB、Redis 或 RabbitMQ**，这些依赖由镜像提供。

当前镜像使用 Node 16、MongoDB 4.4、Redis 6 和 RabbitMQ 3.12。版本信息以 Dockerfile 和 Compose 文件为准；正式上线前应评估旧依赖的维护、安全和升级兼容性。

先确认命令可用：

```bash
docker version
docker compose version
```

## 快速启动

以下命令适用于配置满足要求的 Linux 服务器或 macOS Docker 环境：

```bash
git clone https://github.com/vapacity/sse2026-makyek-portal.git
cd sse2026-makyek-portal

docker compose config --quiet
docker compose up -d --build
docker compose ps
```

`up` 命令返回后仍需检查健康状态；首次构建和数据库初始化可能需要等待。默认启动六个应用/基础设施服务，不会启动带 `test` profile 的测试容器。

默认入口：

- Portal / 排行榜：<http://localhost:8888>
- 登录页：<http://localhost:8888/login>
- RabbitMQ 管理页：<http://localhost:15672>，演示凭据为 `root / local-rabbit`。

**在服务器上，localhost 指服务器本身，不是访问者的电脑。** 当前端口仅绑定 `127.0.0.1`，远程浏览器不能直接通过服务器 IP 访问。

个人远程验证可以保持端口不公开，通过 SSH 转发访问：

```bash
# 在自己的电脑上执行；替换登录用户和服务器地址
ssh -L 8888:127.0.0.1:8888 user@server
```

保持 SSH 连接，再在自己的电脑上打开 <http://localhost:8888>。

## 创建演示账户

新部署不会自动创建以下 Portal 账户。服务健康后执行：

```bash
docker compose exec portal npm run cli -- \
  DI.models.User.createUserAsync admin admin 000000 Admin admin

docker compose exec portal npm run cli -- \
  DI.models.User.createUserAsync student1 student1 001 Student1 student

docker compose exec portal npm run cli -- \
  DI.models.User.createUserAsync student2 student2 002 Student2 student
```

演示账户分别为 `admin / admin`、`student1 / student1`、`student2 / student2`。账户已存在时不要重复创建；真实使用时应替换这些演示用户名和密码。

## 提交与测评验证

1. 登录 `student1`，新建提交。
2. 编译器选择 **GCC (Linux, C11)**。
3. 粘贴 [gomoku-client.c](examples/gomoku-client.c) 的原始源码，不要粘贴带 Markdown 格式标记的代码。
4. 等待编译结束；没有有效对手时，该提交会直接生效。
5. 登录 `student2` 提交同一示例，验证两回合测评、最终状态和日志。

提交 C++ 代码时选择 **G++ (Linux, C++17)**。GCC 选项只用于 C11；包含 `iostream` 等 C++ 头文件的程序不能交给当前 GCC 配置编译。选错编译器产生的编译错误不会自动改判，需重新选择编译器提交。

当前裁判采用 12×12 连五规则，协议为：

```text
START black|white  -> OK
TURN               -> x y
PLACE x y
```

旧 `std-client` 的 8×8 跳棋协议与当前裁判不兼容。示例客户端只用于验证协议和链路，不是高水平棋力算法。

## 配置与重建

部署配置主要位于：

- [compose.yaml](compose.yaml)：镜像、端口、卷、服务依赖和资源限制。
- [services/portal/config-template.yaml](services/portal/config-template.yaml)：数据库、Redis、队列、会话密钥、API 凭据、比赛规则和任务调度。
- [services/jd/config-template.yaml](services/jd/config-template.yaml)：编译器、内部 API、Worker 并行数和运行目录。

Dockerfile 在构建时将 `config-template.yaml` 复制为容器内的 `config.yaml`。因此，修改本地被忽略的 `config.yaml` 不会覆盖镜像中的模板配置；修改模板后需要重新构建：

```bash
docker compose up -d --build
```

数据库和队列连接使用 Compose 内部服务名，例如 `mongo`、`redis`、`rabbit`、`portal`，不是宿主机的 `localhost`。

### Linux 服务器对外使用前

当前配置可以用来启动和验证，但不要原样开放到公网。至少需要：

- 替换 MongoDB、Redis、RabbitMQ、测评 API 的演示密码，以及 Portal 的 `secret`；Compose 和应用模板中的相关值必须同步。
- 修改 Portal 的 `host` 为实际访问域名或地址。
- 建立访问入口、防火墙和 HTTPS；可在宿主机通过反向代理访问 `127.0.0.1:8888`，并处理 WebSocket 转发。
- 保持 RabbitMQ 管理端口只对管理员可达，不公开数据库和 Redis 端口。
- 为学生程序补充独立沙箱和网络/文件系统隔离。
- 配置数据备份、日志管理、监控，并在目标服务器执行回归和容量测试。

HTTPS 反向代理并不等于应用已完整支持 HTTPS：当前代码中的部分绝对 URL 仍固定生成 `http://`。需要进一步核验和适配绝对链接、跳转及 WebSocket；目前没有完整的 HTTPS 部署验证记录。

**已有数据卷时，仅修改 MongoDB / RabbitMQ 初始化环境变量不会自动完成已有账户的密码轮换。** 必须同步修改实际账户凭据和客户端配置。不要为了更换密码直接删除数据卷。

## 并发与故障恢复

任务先持久化到 MongoDB，再通过 RabbitMQ 投递；后台默认每 3 秒扫描补齐未发送任务和未完成状态。

- 同用户提交使用串行锁及数据库唯一约束，防止并发重复提交。
- 任务采用至少一次投递语义；原子领取和运行令牌防止重复回写及旧领取者覆盖新结果，不承诺物理执行永远只发生一次。
- 编译领取默认 3 分钟过期，对局回合领取默认 10 分钟过期；领取过期后可重新投递恢复。
- 对局引用先保存到提交中，再发送任务，避免快速回写导致提交状态卡住。
- 真正的系统错误 `se` 仍需要管理员重测，不会无限重复运行有问题的任务。
- 执行配额支持幂等扣减，排名在数据库中聚合并缓存，避免每个 HTTP 请求加载全部对局。

默认测评并行数为 2，可通过 `services/jd/config-template.yaml` 中的 `match.parallelism` 调整。

当前容器上限：

| 容器 | CPU 上限 | 内存上限 |
| --- | --- | --- |
| Portal | 2 CPU | 1 GiB |
| Compiler | 2 CPU | 1 GiB |
| Judge | 4 CPU | 2 GiB |

上限不是独占资源预留，也不是吞吐量承诺。调整并行数时，需要同步评估 CPU、内存和 Worker 的实际限制，避免容器 OOM。

两两全量比赛仍产生 O(N²) 的任务数量。本次改动控制瞬时负载，没有改变赛制，也没有完成千人容量认证；大规模使用仍需评估分组赛、抽样赛或其他调度方案。

## 回归测试

推荐使用 Docker 测试，不依赖宿主机安装 Node.js。先启动基础设施：

```bash
docker compose up -d mongo redis rabbit
docker compose build portal compiler
docker compose --profile test build tests

# 并发、故障恢复及真实编译/测评链路
docker compose run --rm --no-deps tests

# Linux 资源限制与进程清理
docker compose run --rm --no-deps tests node /workspace/scripts/test-resources.js
```

如果宿主机安装了 npm，也可使用等价快捷命令：

```bash
npm run test:concurrency
npm run test:resources
```

并发测试覆盖 32 路同用户提交、重复领取、过期领取恢复、消息发送失败、并行回写、重复配额扣减、排名缓存，以及真实 RabbitMQ、C11/C++17 编译、测评和日志回传。资源测试覆盖内存限额、禁止 fork、无换行输出洪泛、stderr 排空和进程清理。

测试使用独立的随机命名 MongoDB 数据库、RabbitMQ vhost 和测试用户配额键，不复用正式提交或正式队列。正常结束及断言失败时会尝试清理；强制终止进程或基础设施不可用时可能残留测试数据。

当前并发脚本使用演示 MongoDB / RabbitMQ 管理凭据，权限用于创建和删除测试数据库与 vhost。**若已轮换部署密码，需要同步调整测试脚本的连接凭据，或在独立演示环境运行；不要为运行测试恢复服务器的默认密码。**

### 原生裁判冒烟测试（可选）

仅当需要脱离 Docker 单独调试裁判时使用。宿主机需有 Node.js、C 编译器，以及已安装依赖、完成构建的 Judge 项目：

```bash
npm run smoke:judge
```

脚本通过宿主机的 `cc` 编译两份程序，运行一场对局并检查摘要；生成的是宿主机架构的可执行文件，不固定为 ARM64。该测试不能替代容器内编译、队列和 API 的完整链路验证；macOS 原生运行也没有 Linux 的 `prlimit` 保护。

## 日志、更新与数据保留

查看状态与日志：

```bash
docker compose ps
docker compose logs --tail 100 portal compiler judge
docker compose logs -f portal compiler judge
```

获取代码更新并重建：

```bash
git pull --ff-only
docker compose up -d --build
```

更新前检查本地配置改动并备份数据；有本地改动或配置冲突时，不要直接覆盖。

停止服务并保留数据卷：

```bash
docker compose down
```

持久化卷包含 MongoDB、Redis、RabbitMQ 和 Worker 运行目录。备份数据库时还需要覆盖 GridFS 中的编译产物和日志，而不只是账户、提交等普通集合。

**只有明确要清空整套部署的数据时才执行下面的命令；它会删除此 Compose 项目的数据卷，包括账户、提交、二进制、日志和队列数据：**

```bash
docker compose down --volumes
```

## 安全边界

Worker 以非 root 用户运行，启用了 capability 限制、`no-new-privileges`、进程数及容器 CPU / 内存限制。Linux 学生程序还有地址空间、CPU 时间和派生进程限制，裁判会约束输出并清理子进程。

这些是资源和可靠性保护，**不等于完整沙箱**。当前 `sandbox: null`，学生程序仍与 Worker 共享容器网络和文件系统，缺少逐任务隔离；不要在保存敏感信息的环境中运行未知程序，也不要将当前默认配置直接公开为不可信代码执行服务。

## 与上游相比的主要改动

- 整合独立部署仓库，保留上游源仓库不变。
- 服务端通过 Babel CLI 转译，Portal 前端构建兼容现有镜像环境。
- `libreversi` 使用仓库内依赖；`lzma-native` 调整为可在当前 Node / ARM64 镜像中构建的版本。
- Windows TDM-GCC 编译配置替换为 Linux GCC / G++，支持 C11 和 C++17。
- 不再依赖 Windows `winc.exe`；补充 Linux 资源限制，但未实现完整沙箱替代。
- 使用 MongoDB 驱动内置 GridFS，修复旧上传依赖在当前 Node 环境下的问题。
- 增加持久化任务、原子领取、幂等回写、故障恢复、批量限流和回归测试。
