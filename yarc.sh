#!/usr/bin/env bash
set -euo pipefail

# YARC 项目控制脚本
# 数据库使用 Docker，应用本地运行

CONTAINER_NAME="yarc-db"
DB_PORT=5432
APP_PORT=3000
PID_FILE=".yarc.pid"

# 从 .env 读取配置（如果存在）
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

POSTGRES_DB="${POSTGRES_DB:-yarc}"
POSTGRES_USER="${POSTGRES_USER:-yarc}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-yarc}"
DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${DB_PORT}/${POSTGRES_DB}"

usage() {
    cat <<EOF
YARC 项目控制脚本

用法: $0 <command>

命令:
    start       启动项目（不构建，直接运行生产模式）
    dev         构建并启动项目（watch 模式，开发用）
    stop        停止项目
    restart     重启项目（不构建）
    status      查看项目状态
    logs        查看应用日志
    build       仅构建（Prisma Client + 前端）
    pi:update          更新 Pi SDK 和 Pi 插件，并验证 API 构建
    pi:update:sdk      仅更新 YARC 后端使用的 Pi SDK
    pi:update:plugins  仅更新 data/.pi/agent/npm 中的 Pi 包和插件
    db:start    仅启动数据库
    db:stop     仅停止数据库
    db:status   查看数据库状态
    db:logs     查看数据库日志
    db:init     初始化数据库（迁移 + 生成 + 种子）
    db:migrate  运行数据库迁移
    db:psql     连接到数据库
    app:start   仅启动应用
    app:stop    仅停止应用
    clean       停止所有服务并删除数据库数据
    help        显示此帮助信息

EOF
}

# ========== 数据库函数 ==========

db_start() {
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "数据库已在运行"
        return 0
    fi

    if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "启动已存在的数据库容器..."
        docker start "$CONTAINER_NAME"
    else
        echo "创建并启动数据库容器..."
        docker run -d \
            --name "$CONTAINER_NAME" \
            -p "${DB_PORT}:5432" \
            -e POSTGRES_DB="$POSTGRES_DB" \
            -e POSTGRES_USER="$POSTGRES_USER" \
            -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
            -v yarc-db-data:/var/lib/postgresql/data \
            pgvector/pgvector:pg16
    fi

    echo "等待数据库就绪..."
    for i in {1..30}; do
        if docker exec "$CONTAINER_NAME" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" > /dev/null 2>&1; then
            echo "数据库已就绪 (localhost:${DB_PORT})"
            return 0
        fi
        sleep 1
    done
    echo "错误: 数据库启动超时"
    return 1
}

db_stop() {
    echo "停止数据库..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
}

db_status() {
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "数据库: 运行中"
    elif docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "数据库: 已停止"
    else
        echo "数据库: 未创建"
    fi
}

db_logs() {
    docker logs -f "$CONTAINER_NAME"
}

db_init() {
    echo "初始化数据库..."
    export DATABASE_URL
    pnpm db:migrate
    pnpm db:generate
    pnpm db:seed
    echo "数据库初始化完成"
}

db_migrate() {
    echo "运行数据库迁移..."
    export DATABASE_URL
    pnpm db:migrate
    pnpm db:generate
    echo "迁移完成"
}

db_psql() {
    docker exec -it "$CONTAINER_NAME" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
}

# ========== 应用函数 ==========

# 杀掉进程树：先尝试 kill 进程组，再逐个杀子进程
kill_tree() {
    local pid=$1
    # 获取所有子进程
    local children
    children=$(pgrep -P "$pid" 2>/dev/null || true)
    for child in $children; do
        kill_tree "$child"
    done
    kill "$pid" 2>/dev/null || true
}

app_start() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "应用已在运行 (PID: $(cat "$PID_FILE"))"
        return 0
    fi

    echo "启动应用..."
    export DATABASE_URL
    # 生产模式：前端已构建，只启动 API
    nohup pnpm start > .yarc.log 2>&1 &
    echo $! > "$PID_FILE"
    echo "应用已启动 (PID: $!)"
    echo "日志文件: .yarc.log"
    echo "访问地址: http://localhost:${APP_PORT}"
}

app_start_dev() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "应用已在运行 (PID: $(cat "$PID_FILE"))"
        return 0
    fi

    echo "启动应用 (dev watch 模式)..."
    export DATABASE_URL
    nohup pnpm dev > .yarc.log 2>&1 &
    echo $! > "$PID_FILE"
    echo "应用已启动 (PID: $!)"
    echo "日志文件: .yarc.log"
    echo "访问地址: http://localhost:${APP_PORT}"
}

app_stop() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "停止应用 (PID: $pid)..."
            kill_tree "$pid"
            # 等待退出
            for i in {1..10}; do
                if ! kill -0 "$pid" 2>/dev/null; then
                    break
                fi
                sleep 1
            done
            # 强制杀
            if kill -0 "$pid" 2>/dev/null; then
                kill -9 "$pid" 2>/dev/null || true
            fi
        fi
        rm -f "$PID_FILE"
    fi
    # 兜底：清理可能残留的进程
    pkill -f "tsx.*apps/api/src/index.ts" 2>/dev/null || true
    pkill -f "vite.*build.*watch" 2>/dev/null || true
    echo "应用已停止"
}

app_status() {
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "应用: 运行中 (PID: $(cat "$PID_FILE"))"
    else
        echo "应用: 未运行"
    fi
}

# ========== 构建函数 ==========

build_all() {
    echo "生成 Prisma Client..."
    pnpm db:generate
    echo "构建前端..."
    pnpm --filter @yarc/web build
    echo "构建完成"
}

# ========== Pi 更新函数 ==========

pi_update_sdk() {
    echo "更新 YARC 后端使用的 Pi SDK..."
    pnpm --filter @yarc/api update @earendil-works/pi-coding-agent --latest
    echo "Pi SDK 更新完成"
}

pi_update_plugins() {
    local pi_npm_dir="data/.pi/agent/npm"
    if [ ! -f "${pi_npm_dir}/package.json" ]; then
        echo "错误: 未找到 ${pi_npm_dir}/package.json"
        echo "请先启动一次 YARC 或初始化 Pi agent workspace 后再更新插件。"
        return 1
    fi

    echo "更新 Pi agent workspace 中的 Pi 包和插件..."
    pnpm --dir "$pi_npm_dir" update --latest
    echo "Pi 插件环境更新完成"
}

pi_update_all() {
    echo "========== 更新 Pi 和 Pi 插件 =========="
    pi_update_sdk
    pi_update_plugins
    echo "验证 API 构建..."
    pnpm --filter @yarc/api build
    echo ""
    echo "========== Pi 更新完成 =========="
    echo "已更新 npm 依赖。请重启后端/应用使 Node 已加载的 Pi 模块和插件代码完全生效："
    echo "  ./yarc.sh restart"
    echo "或开发模式下停止当前进程后重新执行："
    echo "  ./yarc.sh dev"
}

# ========== 组合命令 ==========

ensure_env() {
    if ! grep -q "^DATABASE_URL=" .env 2>/dev/null; then
        echo "DATABASE_URL=${DATABASE_URL}" >> .env
    fi
}

start_all() {
    echo "========== 启动 YARC =========="
    db_start
    ensure_env
    build_all
    app_start
    echo ""
    echo "========== YARC 已启动 =========="
    echo "数据库: localhost:${DB_PORT}"
    echo "应用:   http://localhost:${APP_PORT}"
}

dev_all() {
    echo "========== 构建并启动 YARC (dev) =========="
    db_start
    ensure_env
    app_start_dev
    echo ""
    echo "========== YARC 已启动 =========="
    echo "数据库: localhost:${DB_PORT}"
    echo "应用:   http://localhost:${APP_PORT}"
}

stop_all() {
    echo "========== 停止 YARC =========="
    app_stop
    db_stop
    echo "========== YARC 已停止 =========="
}

restart_all() {
    stop_all
    sleep 2
    start_all
}

show_status() {
    echo "========== YARC 状态 =========="
    db_status
    app_status
}

clean_all() {
    echo "警告: 这将删除所有数据库数据！"
    read -p "确认继续? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        stop_all
        docker rm "$CONTAINER_NAME" 2>/dev/null || true
        docker volume rm yarc-db-data 2>/dev/null || true
        rm -f "$PID_FILE" .yarc.log
        echo "已清理完成"
    else
        echo "已取消"
    fi
}

# ========== 主入口 ==========

case "${1:-help}" in
    start)      start_all ;;
    dev)        dev_all ;;
    stop)       stop_all ;;
    restart)    restart_all ;;
    status)     show_status ;;
    logs)       tail -f .yarc.log 2>/dev/null || echo "日志文件不存在" ;;
    build)      build_all ;;
    pi:update)         pi_update_all ;;
    pi:update:sdk)     pi_update_sdk ;;
    pi:update:plugins) pi_update_plugins ;;
    db:start)   db_start ;;
    db:stop)    db_stop ;;
    db:status)  db_status ;;
    db:logs)    db_logs ;;
    db:init)    db_init ;;
    db:migrate) db_migrate ;;
    db:psql)    db_psql ;;
    app:start)  db_start && app_start ;;
    app:stop)   app_stop ;;
    clean)      clean_all ;;
    help|*)     usage ;;
esac
