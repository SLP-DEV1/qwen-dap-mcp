FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json ./
RUN npm install --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY README.md LICENSE qwen-extension.json server.json ./
COPY skills ./skills

USER node

CMD ["node", "dist/index.js"]
