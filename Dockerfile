FROM node:20-alpine AS base

WORKDIR /app

RUN apk add --no-cache \
    tzdata \
    curl \
    && cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime \
    && echo "Asia/Shanghai" > /etc/timezone

COPY package.json package-lock.json* ./

RUN npm install --omit=dev

COPY . .

RUN npm cache clean --force

EXPOSE 35555

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:35555/api/health || exit 1

CMD ["node", "app.js"]
