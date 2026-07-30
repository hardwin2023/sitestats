#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SiteStats · 智能安装 / 迁移器（仅 Python 标准库，clone 即用）

它替你做的事：探测环境 → 协商端口 → 装依赖 → (迁移数据) → 部署静态文件
              → 自动插入埋点 → 启动服务 → (可选自动配 nginx) → 健康自检

交互安装：   python3 install.py
无人值守：   python3 install.py --yes --webroot /var/www/html --pm2
自动配nginx：python3 install.py --auto-nginx            # 自动备份+校验+回滚
只读自检：   python3 install.py --check                 # 不改任何东西，排障用
迁移数据：   python3 install.py --import-data /旧路径/sitestats/server/data
"""
import os, re, sys, json, shutil, socket, argparse, subprocess
import urllib.request

HERE       = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.join(HERE, 'server')
PUBLIC_DIR = os.path.join(HERE, 'public')
DATA_DIR   = os.path.join(SERVER_DIR, 'data')
DEFAULT_PORT = 3881
MIN_NODE   = 16

# 内置 nginx 片段（__PORT__ 占位；与仓库 nginx-sitestats.conf 保持一致）
SNIPPET = """    # ===== SiteStats (auto by install.py) =====
    location ^~ /api/ss/ {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 5s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
    location = /ss.js { add_header Cache-Control "no-cache"; try_files $uri =404; }
    location = /ss-admin.html { add_header Cache-Control "no-cache"; try_files $uri =404; }
    location = /detail.html { add_header Cache-Control "no-cache"; try_files $uri =404; }
    location = /detail.js { add_header Cache-Control "no-cache"; try_files $uri =404; }
    # ===== SiteStats end =====
"""
SNIPPET_MARK = 'location ^~ /api/ss/'

# ----------------------------------------------------------------------------
#  终端 UI（彩色 / 分步 / 带框报告）
# ----------------------------------------------------------------------------
USE_COLOR = sys.stdout.isatty() and os.environ.get('NO_COLOR') is None
def _c(s, code): return f"\033[{code}m{s}\033[0m" if USE_COLOR else s
def green(s):  return _c(s, '1;32')
def cyan(s):   return _c(s, '1;36')
def yellow(s): return _c(s, '1;33')
def red(s):    return _c(s, '1;31')
def bold(s):   return _c(s, '1')
def dim(s):    return _c(s, '2')

def banner():
    w = 66
    title = "SiteStats · 智能安装器"
    sub   = "服务端统计 · 离线地域 · 明细钻取 · 一条命令接入"
    print()
    print(cyan("  ╔" + "═" * (w - 2) + "╗"))
    print(cyan("  ║") + bold(title).center(w - 2 + (len(bold(title)) - len(title))) + cyan("║"))
    print(cyan("  ║") + dim(sub).center(w - 2 + (len(dim(sub)) - len(sub))) + cyan("║"))
    print(cyan("  ╚" + "═" * (w - 2) + "╝"))
    print()

STEP_TOTAL = 8
def step(n, title):
    print("\n" + green(f"▶ [{n}/{STEP_TOTAL}] ") + bold(title))
def ok(msg):   print("    " + green("✔ ") + msg)
def warn(msg): print("    " + yellow("⚠ ") + msg)
def err(msg):  print("    " + red("✘ ") + msg)
def info(msg): print("    " + cyan("ℹ ") + msg)
def note(msg): print("    " + dim("· ") + msg)

def ask(prompt, default=''):
    suf = f"  [{dim(default)}]" if default else ""
    try:
        v = input(f"    {prompt}{suf}: ").strip()
    except (EOFError, KeyboardInterrupt):
        print("\n" + yellow("  已取消。"))
        sys.exit(0)
    return v or default

def run(cmd, cwd=None, check=True, capture=False):
    print("    " + dim("$ " + cmd))
    if capture:
        r = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True)
        if check and r.returncode != 0:
            err(f"命令失败（{r.returncode}）：{cmd}")
            return r
        return r
    r = subprocess.run(cmd, shell=True, cwd=cwd)
    if check and r.returncode != 0:
        err(f"命令失败（{r.returncode}）：{cmd}"); sys.exit(1)
    return r

# ----------------------------------------------------------------------------
#  环境探测
# ----------------------------------------------------------------------------
def which(x): return shutil.which(x)

def node_version():
    p = which('node')
    if not p: return None, None
    try:
        v = subprocess.run([p, '-v'], capture_output=True, text=True).stdout.strip().lstrip('v')
        major = int(v.split('.')[0])
        return major, v
    except Exception:
        return None, None

def port_free(p):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.5)
    try:
        s.bind(('127.0.0.1', p)); return True
    except OSError:
        return False
    finally:
        s.close()

def our_service_on(p):
    """端口 p 上跑的是不是我们的 stats 服务（GET /api/ss/summary 200 且含 todayPV）"""
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{p}/api/ss/summary', timeout=2) as r:
            return r.status == 200 and b'todayPV' in r.read()
    except Exception:
        return False

def find_free_port(start=DEFAULT_PORT):
    p = start
    while p < start + 200:
        if port_free(p): return p
        p += 1
    return None

def nginx_full_config():
    """返回 (nginx_bin, main_conf, full_text)；full_text 来自 nginx -T，含每段来源文件注释"""
    nb = which('nginx')
    if not nb: return None, None, ''
    r = subprocess.run([nb, '-T'], capture_output=True, text=True)
    text = (r.stdout or '') + (r.stderr or '')
    m = re.search(r'configuration file ([^\s:]+):', text)
    main = m.group(1) if m else '/etc/nginx/nginx.conf'
    return nb, main, text

def parse_nginx_roots(full_text):
    roots = set()
    for m in re.finditer(r'\broot\s+([^;]+);', full_text):
        v = m.group(1).strip().strip('"').strip("'")
        if '$' in v: continue
        roots.add(v)
    return [r for r in roots if os.path.isdir(r)]

def parse_server_blocks(full_text):
    """返回 [(file, server_name, listen, has_ss)]，用 nginx -T 的来源注释做 file 映射"""
    out = []
    # 按 "# configuration file /path:" 切段
    parts = re.split(r'(?m)^# configuration file ([^:]+):\s*$', full_text)
    # parts: [pre, file1, body1, file2, body2, ...]
    for i in range(1, len(parts), 2):
        fpath = parts[i].strip()
        body = parts[i + 1] if i + 1 < len(parts) else ''
        for blk in _iter_server_blocks(body):
            sn = _first(blk, r'server_name\s+([^;]+);') or '_'
            ln = _first(blk, r'listen\s+([^;]+);') or ''
            out.append((fpath, sn.strip(), ln.strip(), SNIPPET_MARK in blk))
    return out

def _first(text, pat):
    m = re.search(pat, text)
    return m.group(1).strip() if m else None

def _iter_server_blocks(text):
    """yield 每个顶层 server{...} 的文本（括号匹配，跳过注释/引号）"""
    for m in re.finditer(r'(?m)(^|\s)server\s*\{', text):
        ob = text.index('{', m.start())
        eb = _match_brace(text, ob)
        if eb != -1:
            yield text[ob:eb + 1]

def _match_brace(text, i):
    depth = 1; j = i + 1; n = len(text); in_q = None; in_c = False
    while j < n:
        c = text[j]
        if in_c:
            if c == '\n': in_c = False
        elif in_q:
            if c == in_q and text[j - 1:j] != '\\': in_q = None
        else:
            if c == '#': in_c = True
            elif c in ('"', "'"): in_q = c
            elif c == '{': depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0: return j
        j += 1
    return -1

def detect_webroots(full_text):
    cands = parse_nginx_roots(full_text)
    for pat in ['/var/www/html', '/var/www', '/usr/share/nginx/html', '/srv/www']:
        if os.path.isdir(pat): cands.append(pat)
    import glob
    for g in ['/home/*/www', '/home/*/public_html', '/home/*/wwwroot']:
        cands += glob.glob(g)
    seen, uniq = set(), []
    for c in cands:
        c = os.path.abspath(c)
        if c not in seen:
            seen.add(c); uniq.append(c)
    # 含 index.html 的优先
    uniq.sort(key=lambda c: (not os.path.isfile(os.path.join(c, 'index.html')), c))
    return uniq

# ----------------------------------------------------------------------------
#  nginx 自动插入（查重 / 备份 / 校验 / 回滚）
# ----------------------------------------------------------------------------
def process_nginx_text(text, port):
    """对文本中每个 server 块：未含片段则插入。返回 (new_text, changed_blocks)"""
    snip = SNIPPET.replace('__PORT__', str(port))
    blocks = list(re.finditer(r'(?m)(^|\s)server\s*\{', text))
    if not blocks:
        return text, 0
    out, cursor, changed = [], 0, 0
    for m in blocks:
        ob = text.index('{', m.start())
        eb = _match_brace(text, ob)
        if eb == -1:
            continue
        out.append(text[cursor:ob + 1])           # 到 server 的 {
        block = text[ob + 1:eb]
        if SNIPPET_MARK in block:
            out.append(block)                      # 已配，原样
        else:
            lm = re.search(r'(?m)^(\s*)location\b', block)
            if lm:
                ins = lm.start()
                block = block[:ins] + snip + "\n" + block[ins:]
            else:
                block = block + "\n" + snip + "\n"
            changed += 1
        out.append(text[eb:eb + 1])                # 块的 }
        cursor = eb + 1
    out.append(text[cursor:])
    return ''.join(out), changed

def auto_nginx(cfg, port):
    nb, main, full = nginx_full_config()
    if not nb:
        warn("未检测到 nginx，跳过自动配置（请手动粘贴片段，见报告）。")
        return 'skip'
    blocks = parse_server_blocks(full)
    # 需要处理的文件 = 含有"未配 ss"的 server 块的文件
    target_files = sorted({f for (f, sn, ln, has) in blocks if not has})
    already = sorted({f for (f, sn, ln, has) in blocks if has})
    if not target_files:
        ok("所有 nginx server 块均已配置 /api/ss/，无需改动。")
        return 'ok'
    info(f"将为以下 {len(target_files)} 个文件插入片段（每文件可能含多个站点）：")
    for f in target_files:
        names = [sn for (ff, sn, ln, has) in blocks if ff == f and not has]
        note(f"{f}  ← 站点: {', '.join(names)}")
    if already:
        note("已配置（跳过）：" + ', '.join(already))
    if not cfg.yes:
        if ask("确认自动修改以上文件？(会先备份，失败自动回滚) (Y/n)", 'Y').lower() == 'n':
            warn("已取消自动配置。"); return 'skip'
    # 备份 + 改写
    import time
    ts = time.strftime('%Y%m%d%H%M%S')
    backups = []
    try:
        for f in target_files:
            if not os.path.isfile(f):
                warn(f"文件不存在，跳过：{f}"); continue
            bak = f + f'.ssbak.{ts}'
            shutil.copy2(f, bak); backups.append((f, bak))
            with open(f, encoding='utf-8') as fh: txt = fh.read()
            new_txt, n = process_nginx_text(txt, port)
            with open(f, 'w', encoding='utf-8') as fh: fh.write(new_txt)
            ok(f"已写入 {f}（{n} 个 server 块，备份 → {os.path.basename(bak)}）")
        # 校验
        t = subprocess.run([nb, '-t'], capture_output=True, text=True)
        if t.returncode != 0:
            err("nginx -t 校验失败，正在回滚所有改动…")
            for f, bak in backups:
                shutil.copy2(bak, f)
            err("已回滚。请检查片段或手动配置。")
            print(dim((t.stderr or t.stdout)[-600:]))
            return 'err'
        ok("nginx -t 校验通过。")
        # 尝试 reload
        rl = subprocess.run(['systemctl', 'reload', 'nginx'], capture_output=True, text=True)
        if rl.returncode == 0:
            ok("已执行 systemctl reload nginx，配置生效。")
        else:
            rl2 = subprocess.run([nb, '-s', 'reload'], capture_output=True, text=True)
            if rl2.returncode == 0:
                ok("已执行 nginx -s reload，配置生效。")
            else:
                warn("自动 reload 失败，请手动执行：systemctl reload nginx")
        return 'ok'
    except Exception as e:
        err(f"自动配置异常：{e}，正在回滚…")
        for f, bak in backups:
            try: shutil.copy2(bak, f)
            except Exception: pass
        return 'err'

# ----------------------------------------------------------------------------
#  嵌入埋点
# ----------------------------------------------------------------------------
def embed_one(target, port_unused=None):
    tag = '<script src="/ss.js" defer></script>'
    if not os.path.isfile(target):
        warn(f"文件不存在，跳过：{target}"); return False
    with open(target, encoding='utf-8') as f: html = f.read()
    if 'ss.js' in html:
        note(f"已含 ss.js 引用，跳过（幂等）：{target}"); return True
    anchor = '</head>' if '</head>' in html else ('</body>' if '</body>' in html else None)
    if not anchor:
        warn(f"未找到 </head> 或 </body>，请手动在 {target} 加入：{tag}"); return False
    html = html.replace(anchor, f'  {tag}\n{anchor}', 1)
    with open(target, 'w', encoding='utf-8') as f: f.write(html)
    ok(f"已在 {anchor} 前插入埋点：{os.path.basename(target)}")
    if re.search(r'react|vue|router|history\.pushState|createRouter', html, re.I):
        note("检测到单页应用特征：ss.js 已自动统计路由切换，无需额外配置。")
    return True

# ----------------------------------------------------------------------------
#  健康自检
# ----------------------------------------------------------------------------
def health(port, webroot, embeds):
    res = {}
    # 服务
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/ss/summary', timeout=3) as r:
            body = r.read()
            res['service'] = (r.status == 200 and b'todayPV' in body)
    except Exception:
        res['service'] = False
    # 静态文件
    res['ss.js'] = bool(webroot and os.path.getsize(os.path.join(webroot, 'ss.js')) > 0) if webroot and os.path.isfile(os.path.join(webroot, 'ss.js')) else False
    res['ss-admin.html'] = bool(webroot and os.path.isfile(os.path.join(webroot, 'ss-admin.html'))) if webroot else False
    # 埋点
    if embeds:
        res['embed'] = all('ss.js' in (open(e, encoding='utf-8').read() if os.path.isfile(e) else '') for e in embeds)
    else:
        res['embed'] = None
    # nginx 语法
    nb = which('nginx')
    if nb:
        res['nginx'] = subprocess.run([nb, '-t'], capture_output=True).returncode == 0
    else:
        res['nginx'] = None
    return res

def render_report(rep, port, webroot, auto):
    label = {
        'service': f'统计服务 (:{port})',
        'ss.js': '静态文件 ss.js',
        'ss-admin.html': '后台 ss-admin.html',
        'embed': '页面埋点',
        'nginx': 'nginx 配置语法',
    }
    print("\n" + cyan("  ┌" + "─" * 60 + "┐"))
    print(cyan("  │") + bold("  安装报告").ljust(60 + (len(bold("  安装报告")) - len("  安装报告"))) + cyan("│"))
    print(cyan("  ├" + "─" * 60 + "┤"))
    for k, v in rep.items():
        if v is None:
            sym, col = '·', dim
        elif v:
            sym, col = '✔', green
        else:
            sym, col = '✘', red
        line = f"  {sym}  {label.get(k, k)}"
        print(cyan("  │") + col(line).ljust(60 + (len(col(line)) - len(line))) + cyan("│"))
    print(cyan("  └" + "─" * 60 + "┘"))
    allgood = all(v is not False for v in rep.values()) and rep.get('service') and rep.get('ss.js')
    print()
    if allgood:
        print(green("  🎉 全部就绪！你接下来唯一要做的事："))
        print(f"     打开 {bold('https://你的域名/ss-admin.html')} → 用 {bold('admin123')} 登录 → 改密码。")
        print(dim("     （那一行埋点 JS 已由安装器替你插好，页面挂着即被统计。）"))
    else:
        print(yellow("  ⚠ 部分项未通过，对照上面 ✘ 处理："))
        if not rep.get('service'):
            print(f"     · 服务未通：pm2 logs {cfg_name()}  或检查端口 {port}")
        if rep.get('nginx') is False:
            print("     · nginx 语法错误：nginx -t 查看详情")
        if rep.get('embed') is False:
            print("     · 埋点未插入：在页面 </head> 前加 <script src=\"/ss.js\" defer></script>")
    if not auto:
        print()
        print(dim("  提示：若尚未配 nginx，把下面片段粘到每个 server 块顶部，再 nginx -t && systemctl reload nginx："))
        print(dim("  " + "─" * 58))
        for line in SNIPPET.replace('__PORT__', str(port)).splitlines():
            print(dim("  " + line))
        print(dim("  " + "─" * 58))
    print()

def cfg_name(): return _NAME

# ----------------------------------------------------------------------------
#  主流程
# ----------------------------------------------------------------------------
_NAME = 'sitestats'

def collect(cfg):
    """交互/非交互统一产出配置 dict；做环境探测。"""
    banner()
    nb, main, full = nginx_full_config()
    blocks = parse_server_blocks(full)
    roots = detect_webroots(full)

    # --- 环境一览 ---
    step(1, "探测环境")
    nmaj, nver = node_version()
    if nmaj is None:
        err("未检测到 Node.js。请先安装 Node ≥ 16（推荐 18/20）后重试。"); sys.exit(1)
    if nmaj < MIN_NODE:
        err(f"Node 版本过低（{nver}），需要 ≥ {MIN_NODE}。请升级后重试。"); sys.exit(1)
    ok(f"Node {nver}  ✔  npm {'✔' if which('npm') else '✘(缺失)'}  ✔  pm2 {'已安装' if which('pm2') else '未安装(可选)'}")
    if nb:
        ok(f"nginx 已安装（主配置 {main}）；检测到 {len(blocks)} 个 server 块")
        for f, sn, ln, has in blocks:
            note(f"  {'●' if has else '○'} {sn or '_'}  listen {ln or '?'}  ({os.path.basename(f)})")
    else:
        warn("未检测到 nginx（稍后需手动配置反向代理）。")
    if not which('npm'):
        err("未检测到 npm，无法安装依赖。"); sys.exit(1)

    # --- 端口协商 ---
    if cfg.port:
        port = cfg.port
    elif our_service_on(DEFAULT_PORT):
        port = DEFAULT_PORT; note(f"检测到 :{DEFAULT_PORT} 已是 SiteStats 在运行（升级场景），沿用该端口。")
    elif port_free(DEFAULT_PORT):
        port = DEFAULT_PORT
    else:
        fp = find_free_port(DEFAULT_PORT)
        if not fp: err("找不到可用端口。"); sys.exit(1)
        warn(f":{DEFAULT_PORT} 已被其它程序占用，自动改用 :{fp}")
        port = fp

    # --- webroot ---
    webroot = cfg.webroot
    if not webroot:
        if cfg.yes:
            webroot = roots[0] if roots else '/var/www/html'
        else:
            print()
            info("探测到的网站根目录候选：")
            for i, r in enumerate(roots[:6], 1):
                tag = '  ← 含 index.html' if os.path.isfile(os.path.join(r, 'index.html')) else ''
                print(f"      {cyan(str(i))}) {r}{dim(tag)}")
            print(f"      {cyan('0')}) 手动输入路径 / 留空跳过部署")
            sel = ask("选择编号或直接输入路径", '1' if roots else '0')
            if sel.isdigit() and 1 <= int(sel) <= len(roots[:6]):
                webroot = roots[int(sel) - 1]
            elif sel and sel != '0':
                webroot = sel
            else:
                webroot = None

    # --- 嵌入页面 ---
    embeds = []
    if cfg.embed is not None:
        embeds = [e.strip() for e in cfg.embed.split(',') if e.strip()] if cfg.embed else []
    elif webroot and not cfg.yes:
        ans = ask("要自动插入埋点的页面（相对 webroot，逗号分隔多个，留空跳过）", 'index.html')
        embeds = [e.strip() for e in ans.split(',') if e.strip()]

    # --- pm2 ---
    use_pm2 = cfg.pm2
    if use_pm2 is None:
        if cfg.yes:
            use_pm2 = bool(which('pm2'))
        else:
            use_pm2 = ask("用 pm2 常驻启动？(Y/n，未装 pm2 将用 nohup 后台启动)", 'Y' if which('pm2') else 'n').lower() != 'n'

    # --- auto nginx ---
    auto = cfg.auto_nginx
    if auto is None:
        if cfg.yes:
            auto = False
        elif nb:
            auto = ask("是否让安装器自动配置 nginx？(会备份+校验+失败回滚) (y/N)", 'N').lower() == 'y'
        else:
            auto = False

    return dict(port=port, webroot=webroot, embeds=[os.path.join(webroot, e) for e in embeds] if webroot else [],
                use_pm2=use_pm2, auto=auto, name=cfg.name)

def main():
    ap = argparse.ArgumentParser(
        description='SiteStats 智能安装 / 迁移器',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例:\n  python3 install.py                       # 交互式\n"
               "  python3 install.py --yes --pm2           # 无人值守\n"
               "  python3 install.py --auto-nginx          # 自动配 nginx(备份+回滚)\n"
               "  python3 install.py --check               # 只读自检\n")
    ap.add_argument('--webroot', help='网站根目录（不传则自动探测+交互选择）')
    ap.add_argument('--port', type=int, help=f'统计端口（不传则自动协商，默认 {DEFAULT_PORT}）')
    ap.add_argument('--embed', nargs='?', const='index.html', help='嵌入埋点的页面，逗号分隔多个（不传则交互）')
    ap.add_argument('--pm2', dest='pm2', action='store_true', default=None, help='用 pm2 常驻')
    ap.add_argument('--no-pm2', dest='pm2', action='store_false', help='不用 pm2（nohup 后台启动）')
    ap.add_argument('--name', default='sitestats', help='pm2 进程名（默认 sitestats）')
    ap.add_argument('--import-data', help='旧 server/data 目录，迁移数据/密码')
    ap.add_argument('--auto-nginx', dest='auto_nginx', action='store_true', default=None, help='自动配置 nginx（备份+校验+回滚）')
    ap.add_argument('--yes', action='store_true', help='非交互：缺失项用探测默认值')
    ap.add_argument('--check', action='store_true', help='只读健康自检，不做任何修改')
    a = ap.parse_args()
    global _NAME; _NAME = a.name

    # ---- 只读自检模式 ----
    if a.check:
        banner()
        port = a.port or DEFAULT_PORT
        wr = a.webroot or (detect_webroots(nginx_full_config()[2]) or [None])[0]
        print(green("▶ 只读健康自检（不修改任何文件）") + dim(f"  端口={port}  webroot={wr}"))
        rep = health(port, wr, [os.path.join(wr, 'index.html')] if wr and os.path.isfile(os.path.join(wr, 'index.html')) else [])
        render_report(rep, port, wr, False)
        return

    c = collect(a)
    port, webroot, embeds = c['port'], c['webroot'], c['embeds']
    use_pm2, auto, name = c['use_pm2'], c['auto'], c['name']

    # 2 依赖
    step(2, "安装依赖 (express + geoip-lite)")
    if os.path.isfile(os.path.join(HERE, 'package.json')):
        run('npm install --no-audit --no-fund', cwd=HERE)
        ok("依赖就绪。")
    else:
        warn("缺少 package.json，跳过（请确认仓库完整）。")

    # 3 迁移
    step(3, "迁移数据" + ("（跳过）" if not a.import_data else ""))
    if a.import_data:
        os.makedirs(DATA_DIR, exist_ok=True)
        for fn in ('visits.json', 'auth.json'):
            s = os.path.join(a.import_data, fn)
            if os.path.isfile(s):
                shutil.copy2(s, os.path.join(DATA_DIR, fn)); ok(f"已迁移 {fn}")
            else:
                note(f"源不存在，跳过：{fn}")
    else:
        note("未指定 --import-data，使用现有/新建数据。")

    # 4 部署静态文件
    step(4, "部署静态文件" + (f" → {webroot}" if webroot else "（跳过）"))
    if webroot:
        os.makedirs(webroot, exist_ok=True)
        for fn in ('ss.js', 'ss-admin.html', 'detail.html', 'detail.js'):
            src = os.path.join(PUBLIC_DIR, fn)
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(webroot, fn)); ok(f"已部署 {fn}")
            else:
                warn(f"缺少 public/{fn}")
    else:
        note("未指定 webroot，请手动复制 public/ss.js、public/ss-admin.html 到网站根目录。")

    # 5 嵌入
    step(5, "嵌入埋点" + ("（跳过）" if not embeds else ""))
    if embeds:
        for e in embeds:
            embed_one(e)
    else:
        note("未嵌入埋点：在页面 </head> 前加 <script src=\"/ss.js\" defer></script>（或重跑 --embed index.html）。")

    # 6 启动
    step(6, f"启动服务 (:{port})")
    already = our_service_on(port)
    if use_pm2:
        if not which('pm2'):
            warn("未安装 pm2，尝试 npm i -g pm2 …")
            run('npm i -g pm2', check=False)
        if already:
            run(f'pm2 restart {name} >/dev/null 2>&1 || true', cwd=HERE, check=False)
            ok(f"服务已在 :{port} 运行，已 pm2 restart {name}。")
        else:
            run(f'pm2 delete {name} >/dev/null 2>&1 || true', cwd=HERE, check=False)
            run(f'SS_PORT={port} pm2 start server/stats.mjs --name {name}', cwd=HERE)
            run('pm2 save', cwd=HERE, check=False)
            ok(f"已用 pm2 启动（{name}）。开机自启：执行 pm2 startup 并按提示运行其输出命令。")
    else:
        if already:
            ok(f"服务已在 :{port} 运行，跳过启动。")
        else:
            logf = os.path.join(SERVER_DIR, 'stats.log')
            run(f'nohup env SS_PORT={port} node server/stats.mjs > {logf} 2>&1 &', cwd=HERE, check=False)
            import time; time.sleep(1.5)
            if our_service_on(port):
                ok(f"已用 nohup 后台启动，日志：{logf}（生产强烈建议改用 pm2）。")
            else:
                warn(f"后台启动可能失败，查看日志：{logf}")

    # 7 nginx
    step(7, "配置 nginx" + ("（自动）" if auto else "（打印片段）"))
    ng_status = 'skip'
    if auto:
        ng_status = auto_nginx(type('C', (), {'yes': a.yes})(), port)
    else:
        if which('nginx'):
            info("未启用 --auto-nginx，请在每个 server 块顶部粘贴片段（见报告）。")
        else:
            warn("未检测到 nginx，部署到你自己的反向代理时，请转发 /api/ss/ → 127.0.0.1:%d" % port)

    # 8 自检 + 报告
    step(8, "健康自检")
    import time; time.sleep(1)
    rep = health(port, webroot, embeds)
    render_report(rep, port, webroot, auto)

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print("\n" + yellow("  已中断。"))
        sys.exit(130)