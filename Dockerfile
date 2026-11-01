FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app
ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node","src/server.js"]