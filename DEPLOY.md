# 公网部署说明（Railway）

目标：把这个原型部署成一个可以让老师打开的网页，同时让数据组可以通过受保护的 API 上报批次。

当前项目目录是：

```text
prototype/proto
```

## 部署前准备

1. 把 `prototype/proto` 放进一个你自己的 GitHub 仓库。最简单的做法是新建一个仓库，例如 `trade-data-operations`，然后只上传这个目录里的文件。
2. 确认仓库根目录能直接看到 `package.json`、`server.mjs`、`index.html` 和 `data.json`。
3. 不要把真实 API Key、账号密码或真实敏感数据提交到 GitHub。

## Railway 网页操作

1. 登录 Railway，选择 **New Project → Deploy from GitHub repo**。
2. 授权 GitHub 后选择你的仓库，点击部署。
3. 打开生成的服务，进入 **Settings → Networking → Generate Domain**。生成的 `https://...up.railway.app` 就是给老师访问的网页地址。
4. 进入 **Variables**，添加：

```text
NODE_ENV=production
DATA_DIR=/data
INGEST_API_KEY=自己生成的一串长随机字符
```

不要把 `INGEST_API_KEY` 发在公开群聊或写进代码。它只给需要上报数据的成员/程序使用。

5. 进入服务设置的 **Volumes**，添加一个 Volume，挂载路径填：

```text
/data
```

这样 `data.json` 和上传的 CSV 才能在服务重新部署后继续保留。没有 Volume 时，服务的本地文件不适合作为长期数据保存。

6. Railway 重新部署完成后，打开公网域名。健康检查地址是：

```text
https://你的域名.up.railway.app/api/health
```

看到包含 `"status":"ok"` 的 JSON，就说明服务正常。

Railway 支持从 GitHub 仓库部署；如果仓库是大项目而 `prototype/proto` 只是子目录，需要在服务 Settings 中把 **Root Directory** 设置为 `/prototype/proto`。本项目已在子目录内提供 `package.json` 和 `railway.json`，Root Directory 设置正确后会自动使用 `npm start` 启动。Railway 的配置文件路径在 monorepo 中要特别留意，详见官方文档。

## 给老师看什么

只把生成的网页域名发给老师，例如：

```text
https://你的域名.up.railway.app
```

网页可以公开查看；不要把 `INGEST_API_KEY` 发给老师，除非他也需要提交数据。

## 给数据组什么

把公网 API 地址和密钥通过私下渠道提供给负责采集的人。JSON 批次上报：

```sh
curl -X POST https://你的域名.up.railway.app/api/batches \
  -H 'Content-Type: application/json' \
  -H 'X-Ingest-Key: 你的密钥' \
  -d @batch.json
```

CSV + manifest 上报：

```sh
curl -X POST https://你的域名.up.railway.app/api/batches/csv \
  -H 'X-Ingest-Key: 你的密钥' \
  -F 'manifest=@comtrade-cn-vn-2024.manifest.json;type=application/json' \
  -F 'file=@comtrade-cn-vn-2024.csv;type=text/csv'
```

接口字段以 [API.md](./API.md) 为准，批次 JSON 结构以 [HANDOFF-SCHEMA.md](./HANDOFF-SCHEMA.md) 为准。

## 出现问题时看哪里

- 页面打不开：Railway 服务的 **Deploy Logs**，确认是否看到 `Data operations service listening`。
- `/api/health` 失败：看服务是否部署成功，以及 Railway 是否正确提供了 `PORT`。
- 上报返回 401：检查请求头是否是 `X-Ingest-Key`，值是否和 Railway 的 `INGEST_API_KEY` 完全一致。
- 上报返回 503：生产环境没有配置 `INGEST_API_KEY`。
- 重启后数据不见：检查 Volume 是否挂载到 `/data`，并确认 `DATA_DIR=/data`。

## 当前原型的限制

它适合本周演示和小规模交接，不是生产系统：没有用户登录、角色权限、数据库事务、多人并发控制、自动备份或大文件存储。若后续长期运行，应把 `data.json` 和上传文件迁移到正式数据库/对象存储，并保留 API 鉴权。
