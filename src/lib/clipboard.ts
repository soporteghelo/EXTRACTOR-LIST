// Copiar al portapapeles funcionando también fuera de contexto seguro.
//
// `navigator.clipboard` SOLO existe en contextos seguros: HTTPS o localhost. Al abrir la
// app por la IP de la red local (http://192.168.x.x:3000, que es como se usa desde el
// móvil o desde otro PC) el objeto es `undefined` y llamar a `.writeText()` lanza un
// TypeError que React se traga: el botón no hace nada y no avisa de nada.
//
// El camino antiguo (textarea + execCommand) está obsoleto pero sigue soportado en todos
// los navegadores y no exige contexto seguro, así que sirve exactamente para ese hueco.

export async function copiarTexto(texto: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(texto);
      return true;
    } catch {
      // Puede fallar aun existiendo (permiso denegado, documento sin foco):
      // no se devuelve todavía, se intenta el camino de respaldo.
    }
  }

  try {
    const area = document.createElement("textarea");
    area.value = texto;
    // Fuera de la vista pero enfocable: si estuviera en display:none no se podría seleccionar.
    area.style.position = "fixed";
    area.style.top = "-9999px";
    area.setAttribute("readonly", "");
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, texto.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
