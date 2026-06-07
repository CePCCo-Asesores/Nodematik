FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache openssl && npm ci
COPY . .
RUN npx prisma generate && npm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache openssl && npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma
COPY src/forge/skills ./src/forge/skills
COPY start.sh ./start.sh
EXPOSE 3000
CMD ["node", "dist/server.js"]
