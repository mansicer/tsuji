#!/usr/bin/env bash
# 构建自托管版(带服务器转发)并经 ssh 发布到 .env.selfhost 里的 DEPLOY_HOST:DEPLOY_DIR。
# 只发布已提交的代码(工作区有改动就停),保证线上和仓库一致;版本号里带提交号。
# 先传到 DEPLOY_DIR.new,大文件预压缩 .gz,再整体换上(旧版留在 DEPLOY_DIR.old)。
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.selfhost ] || { echo "缺少 .env.selfhost(参考 .env.selfhost.example)"; exit 1; }
set -a; . ./.env.selfhost; set +a
: "${DEPLOY_HOST:?}" "${DEPLOY_DIR:?}"
[ -z "$(git status --porcelain)" ] || { echo "工作区有未提交的改动,先提交再发布"; exit 1; }
npm run build:selfhost
NEW="$DEPLOY_DIR.new" OLD="$DEPLOY_DIR.old"
ssh "$DEPLOY_HOST" "rm -rf '$NEW' && mkdir -p '$NEW'"
rsync -rz --delete dist/ "$DEPLOY_HOST:$NEW/"
ssh "$DEPLOY_HOST" "set -e; cd '$NEW' && chmod -R u=rwX,go=rX . && find . -type f \\( -name '*.wasm' -o -name '*.js' -o -name '*.css' -o -name '*.html' \\) -size +1k -exec gzip -9 -k -f {} +
rm -rf '$OLD'; [ -d '$DEPLOY_DIR' ] && mv '$DEPLOY_DIR' '$OLD'; mv '$NEW' '$DEPLOY_DIR'"
echo "已发布 $(git rev-parse --short HEAD) → $DEPLOY_HOST:$DEPLOY_DIR"
