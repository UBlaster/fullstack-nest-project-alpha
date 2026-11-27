FROM node:20-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npx prisma generate && npm run build
FROM node:20-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","dist/src/main"]
