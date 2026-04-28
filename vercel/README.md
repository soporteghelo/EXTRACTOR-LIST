# Instrucciones para desplegar en Vercel

1. Instala Vercel CLI si no lo tienes:
   npm install -g vercel

2. Desde la raíz del proyecto, ejecuta:
   vercel --prod

3. La configuración de despliegue está en la carpeta `vercel/`.

- El archivo `vercel.json` ya está preparado para una app Vite/React.
- El directorio de salida es `dist` (ajusta si usas otro).

Si necesitas variables de entorno, crea un archivo `.env` en la raíz y configúralas también en el dashboard de Vercel.
