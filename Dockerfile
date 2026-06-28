FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY client/package*.json client/
COPY server/package*.json server/
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY server/package*.json server/
RUN npm install --omit=dev --workspace server
COPY --from=build /app/server ./server
COPY --from=build /app/client/dist ./client/dist
EXPOSE 8080
CMD ["npm", "--workspace", "server", "start"]
