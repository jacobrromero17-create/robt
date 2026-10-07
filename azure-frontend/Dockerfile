# Contenedor liviano: solo sirve index.html e index2.html como páginas estáticas.
# La consulta de verdad la hace el robot en Render (robt.onrender.com).
FROM nginx:alpine
COPY index.html index2.html /usr/share/nginx/html/
EXPOSE 80
