#!/usr/bin/env bash
# 启动可见浏览器并开启 CDP 调试端口 —— flow.mjs 通过它接管页面。
#
# 用法：
#   bash scripts/launch-edge.sh                 # 用默认 profile 起 Edge
#   START_URL="https://www.zhipin.com/" bash scripts/launch-edge.sh
#   BROWSER=chrome bash scripts/launch-edge.sh  # 改用 Chrome
#
# ⚠️ 四条硬约束：
#   1) 用**后台任务**方式执行本脚本（启动任务一旦"完成"，它名下的浏览器会被回收）。
#   2) 末尾的 sleep 是故意的：挂住启动任务，浏览器才跨调用存活。
#   3) **绝不 taskkill 清场** —— 那会连用户已登录的浏览器一起杀掉。
#      要停，停这个启动任务本身。
#   4) 窗口不要最小化：鼠标点击依赖坐标，最小化时所有元素尺寸为 0，什么都点不到。
set -u

PORT="${CDP_PORT:-9222}"
# profile 放在**用户目录**下（不是 skill 目录里）——登录态要能跨会话留存，
# 但浏览器缓存不该污染 skill 目录（那会塞进几十 MB 的 cache）。
AI_HOME_DIR="${AI_HOME:-$HOME/.auto-introduce}"
PROFILE="${FLOW_PROFILE:-$AI_HOME_DIR/edge-profile}"
START="${START_URL:-https://www.zhipin.com/}"

if [ "${BROWSER:-edge}" = "chrome" ]; then
  BIN="/c/Program Files/Google/Chrome/Application/chrome.exe"
else
  BIN="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
fi

if [ ! -x "$BIN" ]; then
  echo "FAIL 找不到浏览器：$BIN"
  echo "FIX  用 BROWSER=chrome 指定其它浏览器，或改本脚本里的 BIN"
  exit 1
fi

mkdir -p "$PROFILE"

"$BIN" --remote-debugging-port="$PORT" --remote-allow-origins=* \
  --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
  "$START" >/dev/null 2>&1 &

echo "OK  已启动（${BIN##*/}）  port=$PORT  profile=$PROFILE  start=$START"
echo "KEY  pid=$!"

# 挂住任务：启动任务活着，浏览器才活着
sleep 86400
