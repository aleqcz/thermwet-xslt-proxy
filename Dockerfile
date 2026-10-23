FROM node:22-alpine

WORKDIR /app
# explicit mode - COPY preserves source perms on Linux and USER node needs read access
COPY --chmod=644 server.js xslt-polyfill.min.js ./

# THERMWET_HOST has no default - set it in docker-compose.yml / -e
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "server.js"]
