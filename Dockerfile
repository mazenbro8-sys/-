FROM node:24-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
VOLUME /app/data
EXPOSE 3000
USER node
CMD ["node","src/server.js"]
