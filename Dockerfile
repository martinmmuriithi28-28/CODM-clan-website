FROM node:20-alpine
WORKDIR /app
COPY server.js seed.json package.json ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 3000
CMD ["node","server.js"]
