FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data

COPY package.json server.js ./
COPY src ./src
COPY public ./public
# 提词器用的标签库（scripts/build_tag_data.py 生成）
COPY assets ./assets

# 数据目录交给 node 用户；挂命名卷时 Docker 会沿用这个属主
RUN mkdir -p /app/data && chown node:node /app/data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
