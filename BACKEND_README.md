# ⚙️ Configuración del Backend (Google Apps Script)

El proyecto utiliza **Google Apps Script** como un backend ligero (Web App) para recibir los datos extraídos por la inteligencia artificial (Gemini) y guardarlos directamente en una hoja de cálculo de Google Sheets.

## 🔗 Despliegue Actual (Web App URL)
El enlace web actual desplegado para recibir las peticiones es:
```text
https://script.google.com/macros/s/AKfycbyohGM8PRErgAK4Uq_SXw0b4gQwuCqbV2O9CC64UAS1piAurb9oiZQ2kQiv4YwOn3GL/exec
```
*Este enlace está configurado en el archivo `src/App.tsx` en la variable `GOOGLE_SHEETS_WEBAPP_URL`.*

---

## 🚀 ¿Cómo crear y desplegar tu propio backend en Apps Script?

Si deseas conectar la aplicación a tu propia hoja de Google Sheets, sigue estos pasos:

### 1. Preparar la Hoja de Google Sheets
1. Crea una nueva hoja de cálculo en Google Sheets.
2. Asegúrate de tener una pestaña (hoja) preparada para recibir los datos. (Por ejemplo, con columnas como `IdRef`, `ParticipanteDNI`, `Participante`, `Cargo`, `Area`).
3. Anota el nombre de la pestaña donde se guardarán los registros.

### 2. Crear el script en Google Apps Script
1. En tu hoja de cálculo, ve al menú **Extensiones** > **Apps Script**.
2. Se abrirá el editor de código. Borra el código por defecto y pega el script necesario para recibir las peticiones `POST`.

Ejemplo de la función `doPost` que espera la aplicación:
```javascript
function doPost(e) {
  try {
    // IMPORTANTE: Cambia "Hoja1" por el nombre real de tu pestaña en Google Sheets
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Hoja1"); 
    
    // Parsear los datos que envía el frontend (React)
    var data = JSON.parse(e.postData.contents);
    var idRef = data.IdRef;
    var participantes = data.participantes;
    
    // Iterar sobre cada participante y guardarlo como una nueva fila
    participantes.forEach(function(p) {
      // Ajusta el orden de las columnas según tu documento
      sheet.appendRow([
        p.Id,
        idRef, 
        p.ParticipanteDNI, 
        p.Participante, 
        p.Cargo, 
        p.Area
      ]);
    });
    
    return ContentService.createTextOutput(JSON.stringify({success: true}))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({success: false, message: error.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

### 3. Desplegar como Aplicación Web (Web App)
1. En el editor de Apps Script, haz clic en el botón azul **Implementar** (o *Deploy*) en la esquina superior derecha.
2. Selecciona **Nueva implementación** (*New deployment*).
3. En el tipo de implementación (icono de engranaje ⚙️), selecciona **Aplicación web** (*Web app*).
4. Configura los siguientes campos:
   - **Descripción:** (Opcional) ej. "API Extractor v1"
   - **Ejecutar como:** `Yo (tu correo)`
   - **Quién tiene acceso:** `Cualquier persona` (Esto es **muy importante** para que la app de React pueda hacer la petición CORS sin bloqueos de autenticación).
5. Haz clic en **Implementar**.
6. Se te pedirá que autorices los permisos para que el script pueda editar tu hoja de cálculo. Sigue los pasos de autorización (si aparece una advertencia de seguridad, ve a *Configuración avanzada* y selecciona *Ir a Proyecto (no seguro)*).

### 4. Actualizar la URL en el Frontend
1. Una vez desplegado, Google te proporcionará una **URL de la aplicación web** (termina en `/exec`). Cópiala.
2. Ve al código del frontend de esta aplicación.
3. Abre el archivo `src/App.tsx`.
4. En las primeras líneas (aprox. línea 2), busca la variable `GOOGLE_SHEETS_WEBAPP_URL` y reemplaza el valor con tu nueva URL:
   ```typescript
   const GOOGLE_SHEETS_WEBAPP_URL = "TU_NUEVA_URL_AQUI";
   ```
5. Guarda los cambios. Si estás en producción, haz un push a tu repositorio y Vercel redesplegará automáticamente los cambios.

¡Listo! Ahora las extracciones de datos se enviarán directamente a tu propia hoja de cálculo.
