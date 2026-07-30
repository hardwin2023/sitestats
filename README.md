# SiteStats · 轻量可复用站点访问统计

> 零第三方服务、可整体搬运的访问统计组件。**智能安装器一条命令接入**——
> 它替你探测环境、协商端口、部署文件、插入埋点、配置 nginx、并自检全链路。
> 从仪表盘一路下探到每一条访问的 IP 与 User-Agent。

```
 访客浏览器                 你的服务器
 ┌──────────┐  POST /api/ss/report   ┌──────────────────────┐
 │  ss.js   │ ─────────────────────▶ │  nginx  location ^~  │
 │ 自动上报  │   (含 UA / 设备 / 屏幕) │  /api/ss/  (最高优先) │
 └──────────┘                        └──────────┬───────────┘
      ▲ 整页加载 + SPA 路由自动统计              │ proxy :3881
      │                                          ▼
      │                              ┌──────────────────────┐
      │  GET /api/ss/summary         │  stats.mjs (Express) │
      └────────────────────────────  │  · 服务端补 IP/地域    │
        首页挂件(仅数字,不含明细)      │  · UA→系统/浏览器      │
                                     │  · 落盘 server/data/  │
                                     └─────────────────────┘
                                                │
                          ┌─────────────────────┼─────────────────────┐
                          ▼                     ▼                     ▼
                  visits.json            auth.json            ss-admin.html
                  访问明细+IP            后台密码哈希          仪表盘 + 明细钻取
                  (仅登录后台可见)        (全设备通用)          (15s 自动刷新)
```

## 特性

**采集与识别**
- 🌐 **真实 IP**：服务端从 `X-Forwarded-For` 取真实地址；`STORE_IP=false` 一键切回"不存 IP"
- 🗺️ **三级地域**：离线 GeoIP → 国家 / 省 / 市，中国细化到省市；不依赖在线服务
- 🖥️ **设备指纹**：UA 解析操作系统（含版本）与浏览器（含版本，识别微信/夸克/UC 等）
- 🔁 **SPA 自动统计**：拦截 `pushState/replaceState` + `popstate`，单页应用只嵌一行

**后台与钻取**
- 📊 **仪表盘**：PV/UV、来源、设备、24h 时段、停留、热门页面、地域聚合，15 秒自动刷新
- 🔍 **明细钻取**：「当日 / 历史明细」下探到每条访问——IP（点击复制）、国家·省·市、系统、浏览器、屏幕、来源、停留；表头排序、搜索、筛选、行展开看完整 UA、分页、CSV 导出
- 👁️ **登录体验**：密码框眼睛图标；服务端密码鉴权，一个密码全设备通用

**工程**
- 🤖 **智能安装器**：探测环境/端口/webroot/nginx，自动插埋点，可选自动配 nginx（备份+校验+回滚），装完自检
- 🔌 **接口隔离**：`/api/ss/` 用 `location ^~` 最高优先级，永不与项目 `/api/` 冲突
- 📦 **数据落盘 JSON**：备份只需拷目录；提供 JSON/CSV 导出

## 目录结构

```
sitestats/
├─ install.py              ★ 智能安装 / 迁移 / 自检脚本
├─ package.json
├─ server/
│  ├─ stats.mjs            统计服务端（端口 3881，前缀 /api/ss/）
│  └─ data/                运行后自动生成（visits.json / auth.json，已 gitignore）
├─ public/
│  ├─ ss.js                前端埋点（自动上报 + SPA 路由 + 聚合函数）
│  └─ ss-admin.html        统计后台（仪表盘 + 明细钻取 + 服务端密码）
├─ nginx-sitestats.conf    nginx 接入片段（手动配置用，与安装器内置一致）
├─ examples/
│  └─ widget.html          可选：首页"今日访问"挂件
├─ .gitignore
└─ README.md
```
## 不用安装器：手动挂接（4 步）

> 不想跑 `install.py` 也没关系，下面 4 步即可完整接入。
> 而对"要统计的页面"而言，**真正要做的只有第 4 步那一行 `<script>`**——其余都是服务器侧的一次性配置。

### 1. 启动统计服务

    cd sitestats
    npm install
    pm2 start server/stats.mjs --name sitestats && pm2 save   # 推荐：pm2 常驻
    # 没有 pm2 时：nohup node server/stats.mjs > server/stats.log 2>&1 &

服务默认监听 `127.0.0.1:3881`。改端口：`SS_PORT=9000 node server/stats.mjs`（记得同步改第 3 步的 `proxy_pass`）。

### 2. 复制两个静态文件到网站根目录

    cp public/ss.js public/ss-admin.html /你的网站根目录/

使 `https://你的域名/ss.js` 与 `https://你的域名/ss-admin.html` 可被访问。

### 3. 配置反向代理（nginx 示例）

在**每个** server 块顶部加入下面片段，然后 `nginx -t && systemctl reload nginx`：

    location ^~ /api/ss/ {
        proxy_pass http://127.0.0.1:3881;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location = /ss.js { add_header Cache-Control "no-cache"; try_files $uri =404; }
    location = /ss-admin.html { add_header Cache-Control "no-cache"; try_files $uri =404; }

> 关键：`X-Forwarded-For` 必须透传，否则服务端拿不到访客真实 IP；多域名（含 `www`）**每个 server 块各加一份**。完整片段见 `nginx-sitestats.conf`。

### 4. 在要统计的页面挂一行 JS —— 这就是全部

在页面 `<head>` 加入：

`<script src="/ss.js" defer></script>`

**就这一行。** `ss.js` 自执行：页面加载即上报一次，SPA 路由切换自动再上报，无需写任何 `track()` 调用，也无需改你的业务代码。

可选：想要首页右下角"今日 N 次访问"小挂件，把 `examples/widget.html` 整段贴到 `</body>` 前即可。

完成后访问 `https://你的域名/ss-admin.html`，默认密码 `admin123`，登录后立即修改。

## 一条命令接入

```bash
python3 install.py
```

安装器会**分步引导**并自动完成：探测 Node/nginx/网站根目录 → 协商端口 → 装依赖 →
部署 `ss.js`/`ss-admin.html` → **替你把埋点那一行插进页面** → 启动服务 →
（可选）自动配 nginx → **健康自检并给出 ✅/❌ 报告**。

> 这就是本组件对"易用"的理解：自托管统计物理上需要一个接收数据的后端，
> 而安装器的价值，是把这一次性成本压到"回车几下"，并**连页面里那一行 JS 都替你挂好**——
> 于是从你的视角，真的就只剩"打开后台改个密码"。

### 常用模式

```bash
# 无人值守（CI / 脚本）
python3 install.py --yes --webroot /var/www/html --pm2

# 让安装器自动配置 nginx（自动备份 + nginx -t 校验 + 失败回滚）
python3 install.py --auto-nginx

# 只读自检，不改任何东西（排障 / 验收）
python3 install.py --check

# 从旧安装迁移数据与密码
python3 install.py --import-data /旧路径/sitestats/server/data --pm2
```

### 参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `--webroot` | 网站根目录 | 自动探测 + 交互选择 |
| `--embed` | 嵌入埋点的页面（逗号分隔多个） | 交互询问 / `index.html` |
| `--port` | 统计端口 | 自动协商（默认 `3881`，被占则顺延） |
| `--pm2` / `--no-pm2` | 是否用 pm2 常驻 | 探测后询问 |
| `--name` | pm2 进程名 | `sitestats` |
| `--import-data` | 旧 `server/data` 目录 | 无 |
| `--auto-nginx` | 自动配置 nginx（备份+校验+回滚） | 关 |
| `--yes` | 非交互，缺失项用探测默认值 | 关 |
| `--check` | 只读健康自检 | 关 |

### 安装器替你想到的事（= 我们踩过的坑）

- **端口被占**：先判断"是不是自己已在跑"（升级→沿用），否则自动找空闲端口并同步改 nginx 片段。
- **不知道根目录**：解析 nginx `root` + 扫描常见路径，列出候选（含 `index.html` 的优先）。
- **`www` 漏配**：用 `nginx -T` 列出**每个**配置文件的**每个** server 块，`--auto-nginx` 会给它们**全部**插入。
- **重复块翻车**：自动插入前**逐块查重**，已配则跳过，绝不产生 `duplicate location`。
- **改坏配置**：自动插入**先备份**、**改后 `nginx -t`**、**失败自动回滚**。
- **装完没底**：结束自动 curl 服务 + 检查文件 + 检查埋点 + 检查 nginx，给带框报告。

## 手动配置 nginx（不用 `--auto-nginx` 时）

把下面片段（即 `nginx-sitestats.conf`）粘到**每个** server 块**顶部**，`nginx -t && systemctl reload nginx`：

```nginx
location ^~ /api/ss/ {
    proxy_pass http://127.0.0.1:3881;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # ← 真实 IP 的关键
    proxy_set_header X-Forwarded-Proto $scheme;
}
location = /ss.js { add_header Cache-Control "no-cache"; try_files $uri =404; }
location = /ss-admin.html { add_header Cache-Control "no-cache"; try_files $uri =404; }
```

> 多域名（`example.com` 与 `www.example.com`）**每个 server 块各粘一份**——少粘一个，那个域名上报就 404。

## 后台与明细视图

- 地址：`https://你的域名/ss-admin.html`，默认密码 **`admin123`**（登录后立即修改，全设备通用）。
- **仪表盘**：默认视图，15 秒自动刷新（右上角可关）。
- **当日 / 历史明细**：工具栏按钮进入钻取视图。
  - 6 张卡：PV / UV / 独立 IP / 国家地区数 / 平均停留 / 移动端占比
  - 4 组分布条：设备 / 操作系统 / 浏览器 / 国家
  - 明细表：时间、IP（点击复制）、地域、页面、设备、系统、浏览器、屏幕、来源、停留
  - 表头排序；搜索 IP/页面/地域/系统/UA；下拉筛设备/地域；历史模式可框选日期
  - 点行展开完整 User-Agent、访客 ID、会话 ID、语言、时区；「导出当前结果 CSV」
- 登录框右侧眼睛图标显隐密码。

> IP / 城市 / 系统 / 浏览器仅对**改字段后**的新访问完整；旧记录优雅降级为"—"。

## 首页挂件（可选）

把 `examples/widget.html` 整段贴到页面 `</body>` 前，得右下角半透明"今日 N 次访问"胶囊，
悬停变清晰、点击进后台。它调用**公开**的 `/api/ss/summary`（仅汇总数字，不含 IP/明细）。

## 接口（前缀 `/api/ss/`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/report` | 公开 | 上报；服务端补 IP / 国家·省·市 / 系统 / 浏览器 |
| POST | `/stay` | 公开 | 回写停留时长 |
| GET | `/summary` | 公开 | 仅汇总数字（供挂件） |
| POST | `/login` | 公开 | 密码换令牌 |
| POST | `/logout` | 公开 | 注销令牌 |
| POST | `/password` | 令牌 | 改密码 |
| GET | `/visits?token=` | 令牌 | 全部记录（明细数据源） |
| POST | `/seed?token=` | 令牌 | 30 天演示数据（带自洽假 IP/地域/系统/浏览器） |
| POST | `/clear?token=` | 令牌 | 清空 |

## 配置（`server/stats.mjs` 顶部）

| 项 | 默认 | 说明 |
|---|---|---|
| `PORT` / 环境变量 `SS_PORT` | `3881` | 需与 nginx `proxy_pass` 一致 |
| `STORE_IP` | `true` | 设 `false` 则不存 IP（明细 IP 列显示"—"） |
| `MAX` | `20000` | 记录上限，超出丢弃最旧 |
| `TOKEN_TTL` | 12 小时 | 过期 / 重启服务需重新登录 |
| 默认密码 | `admin123` | 首次运行写入 `auth.json`，后台可改 |

## 数据与备份（⚠️ 读过能避坑）

统计数据与密码在 **`server/data/`**（是 `server/` 下的 `data`，**不是**模块根的 `data`）：
`visits.json`（访问记录）、`auth.json`（密码哈希）。

备份脚本（**用对路径**，可同时覆盖一个常见共存后端）：

```bash
#!/bin/bash
mkdir -p /root/backup
tar czf "/root/backup/site-$(date +%F).tar.gz" -C / \
    opt/sitestats/server/data \
    var/www/html/server/data        # 你的项目后端数据若在此则一并备份，否则删掉这行
```

> 🩸 **真实踩坑**：曾把路径写成 `opt/sitestats/data`（少了 `server/`），每周"备份"打包的是废弃空目录，真数据从未被备份。**写完后 `tar -tzf 包名` 核对清单**，看到 `visits.json`/`auth.json` 才算数。
> 🩸 **另一条**：清理旧文件时，绝不对承载其它服务数据的目录用 `rm -rf`——先 `ls` 看清里面住着谁。

恢复：

```bash
tar xzf /root/backup/site-YYYY-MM-DD.tar.gz -C /   # 解回前先 cp -r 现目录留底
pm2 restart sitestats
```

## 运维

```bash
npm i -g pm2
pm2 start server/stats.mjs --name sitestats
pm2 save && pm2 startup        # 按提示执行其输出命令，开机自启
pm2 logs sitestats             # 启动行会打印 STORE_IP 当前值
python3 install.py --check     # 随时自检全链路
```

## 复用到其他项目（清单）

1. [ ] 复制整个 `sitestats/` 到目标服务器
2. [ ] `python3 install.py`（或 `--yes --pm2` / `--auto-nginx`）
3. [ ] 看安装报告全 ✅；若未用 `--auto-nginx`，按报告粘 nginx 片段并 reload
4. [ ] 访问 `/ss-admin.html`，用 `admin123` 登录后**立即改密码**
5. [ ] 可选：贴 `examples/widget.html` 到 `</body>` 前
6. [ ] 配好备份脚本，`tar -tzf` 核对一次

## License

MIT