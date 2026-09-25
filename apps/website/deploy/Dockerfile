# heystyx.com on Cloud Run: the static export (`out/`) served by nginx. No Node at runtime.
FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY out /usr/share/nginx/html
# Cloud Run sends traffic to $PORT (8080); nginx listens there directly.
EXPOSE 8080
