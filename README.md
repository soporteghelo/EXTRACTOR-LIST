# IntelliExtract - Asistencia OCR

Aplicación de Visión Computacional y OCR especializada en la extracción de datos de documentos corporativos y registros de asistencia mediante modelos avanzados de Google Gemini.

🌐 **Despliegue en Producción:** [https://extractor-list.vercel.app/](https://extractor-list.vercel.app/)

<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

## ⚙️ Configuración de Variables de Entorno (Obligatorio)

Esta aplicación requiere una API Key de Google Gemini para funcionar (tanto en local como en Vercel). El proyecto utiliza Vite, por lo que la variable debe usar el prefijo `VITE_`.

### En Desarrollo Local
1. Crea un archivo `.env` en la raíz del proyecto (puedes copiar el contenido de `.env.example`).
2. Añade tu API Key:
   ```env
   VITE_GEMINI_API_KEY="tu_api_key_de_gemini_aqui"
   ```

### En Producción (Vercel)
Para que el despliegue funcione correctamente, debes configurar la variable en el panel de Vercel:
1. Ve a tu proyecto en Vercel > **Settings** > **Environment Variables**.
2. Agrega una nueva variable:
   - **Key:** `VITE_GEMINI_API_KEY`
   - **Value:** `tu_api_key_de_gemini_aqui`
3. Guarda la configuración.
4. **Importante:** Ve a la pestaña **Deployments** y realiza un **Redeploy** para que la variable se inyecte en el nuevo *build*.

> ⚠️ Si no configuras esta variable en Vercel, el botón de extracción se deshabilitará por seguridad y mostrará una alerta naranja en la interfaz.

## 🚀 Instalación y Ejecución Local

**Requisitos:** Node.js

1. Instala las dependencias:
   ```bash
   npm install
   ```
2. Asegúrate de tener configurado tu archivo `.env` con la variable `VITE_GEMINI_API_KEY`.
3. Inicia el servidor de desarrollo:
   ```bash
   npm run dev
   ```

## 📊 Configuración del Backend y Google Sheets

La aplicación incluye la funcionalidad de enviar los datos extraídos directamente hacia una base de datos en Google Sheets a través de Apps Script.

Para aprender cómo configurar tu propio Google Apps Script, cómo desplegarlo como Web App y dónde actualizar el enlace de conexión en este proyecto, por favor revisa el documento de configuración dedicado:

👉 [**Manual de Configuración del Backend (Apps Script)**](./BACKEND_README.md)

