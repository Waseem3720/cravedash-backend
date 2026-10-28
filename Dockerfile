FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY shared/package.json ./shared/
COPY services/gateway/package.json ./services/gateway/
COPY services/auth-service/package.json ./services/auth-service/
COPY services/catalog-service/package.json ./services/catalog-service/
COPY services/order-service/package.json ./services/order-service/
COPY services/restaurant-service/package.json ./services/restaurant-service/
COPY services/platform-service/package.json ./services/platform-service/
COPY services/epos-service/package.json ./services/epos-service/
COPY services/reporting-service/package.json ./services/reporting-service/
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "services/gateway/src/index.js"]
