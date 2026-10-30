FROM mcr.microsoft.com/playwright:v1.56.0-noble
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src
USER pwuser
CMD ["node","src/server.mjs"]
