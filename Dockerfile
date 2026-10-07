# Imagen con apt disponible y sin restricciones de usuario: durante "docker build"
# el proceso corre como root, así que "playwright install --with-deps" puede instalar
# las librerías del sistema que Chromium necesita (eso era lo que fallaba en Render
# con el build nativo de Node, que corre como un usuario sin permisos de sudo).
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Instala Chromium y sus dependencias de sistema (libnss3, libatk, etc.).
RUN npx playwright install --with-deps chromium

COPY index.html index2.html server.js robot.js robots.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
