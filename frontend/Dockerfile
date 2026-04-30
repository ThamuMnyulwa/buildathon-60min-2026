FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine

COPY --from=build /app/dist /usr/share/nginx/html

ENV PORT=8080
ENV BACKEND_URL=""
EXPOSE 8080

CMD ["sh", "-c", "printf 'window.SENTINEL_CONFIG = { BACKEND_URL: \"%s\" };' \"$BACKEND_URL\" > /usr/share/nginx/html/config.js && sed -i \"s/listen       80;/listen       ${PORT};/\" /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
