FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY src/ src/
CMD ["node", "--require", "./src/instrumentation.js", "src/server.js"]
