FROM node:22.23.4-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
RUN npm run build

FROM node:22.23.4-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist/
COPY --from=build /app/openapi.json ./openapi.json
EXPOSE 3000
CMD ["node", "dist/index.js"]
