FROM node:18-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY index.js ./
ENTRYPOINT ["node", "index.js"]
