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
# 以线上版本的硬链接副本为底,rsync 只传有变化的文件(rsync 写新文件再改名,不会改到线上那份)
ssh "$DEPLOY_HOST" "rm -rf '$NEW' && if [ -d '$DEPLOY_DIR' ]; then cp -al '$DEPLOY_DIR' '$NEW'; else mkdir -p '$NEW'; fi"
# 按内容比对(每次构建文件时间都会变),只传内容变了的
rsync -rcz --delete --exclude '*.gz' dist/ "$DEPLOY_HOST:$NEW/"
# 预压缩:缺 .gz 或 .gz 比原文件旧的重新压(先删再写,硬链接到线上的那份不受影响);原文件已删掉的 .gz 一并删
ssh "$DEPLOY_HOST" "set -e; cd '$NEW' && chmod -R u=rwX,go=rX .
find . -type f -name '*.gz' | while read -r g; do [ -f \"\${g%.gz}\" ] || rm -f \"\$g\"; done
find . -type f \\( -name '*.wasm' -o -name '*.js' -o -name '*.css' -o -name '*.html' \\) -size +1k | while read -r f; do [ \"\$f.gz\" -nt \"\$f\" ] || { rm -f \"\$f.gz\"; gzip -9 -c \"\$f\" > \"\$f.gz\"; }; done
rm -rf '$OLD'; [ -d '$DEPLOY_DIR' ] && mv '$DEPLOY_DIR' '$OLD'; mv '$NEW' '$DEPLOY_DIR'"
echo "已发布 $(git rev-parse --short HEAD) → $DEPLOY_HOST:$DEPLOY_DIR"
