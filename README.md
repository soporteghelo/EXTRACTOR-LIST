# Configuración para Gemini API (obligatorio)

Para que la app funcione en local y en Vercel necesitas una API Key de Gemini:

1. Crea un archivo `.env` en la raíz del proyecto (puedes copiar el ejemplo `.env.example`).
2. Añade tu API Key:
   ```env
   VITE_GEMINI_API_KEY=tu_api_key_de_gemini_aqui
   ```
3. En Vercel, ve a Settings > Environment Variables y agrega:
   - **Name:** `VITE_GEMINI_API_KEY`
   - **Value:** tu API Key
   - **Environment:** Production y Preview

Si no configuras esta variable, la app no funcionará ni en local ni en producción.
<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/21b31829-b6ad-4818-af13-3387b3c0ae97

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`
