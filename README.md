# Mi Salud

App web para llevar el control de un tratamiento médico: recordatorios de medicamentos, registro de síntomas e historial de consultas. Pensada para tratamientos crónicos y enfermedades autoinmunes, pero sirve para cualquier persona que necesite seguir una medicación o sus citas médicas.

Funciona como PWA: se instala en el celular o el computador y sigue funcionando sin conexión.

## Qué hace

- **Recordatorios de medicamentos** con frecuencia diaria, semanal, por intervalo de días o SOS (según necesidad), con varios horarios por día.
- **Avisos insistentes** dentro de la app y notificaciones del sistema, con opción de posponer o marcar la toma.
- **Control de inventario** de cada medicamento, con alerta de stock bajo.
- **Registro de bienestar**: dolor, fatiga, rigidez matutina y mapa articular interactivo para marcar dónde hay molestia.
- **Historial de consultas médicas** por especialidad, con hallazgos, plan, laboratorios, preguntas para el médico y archivos adjuntos (imágenes o PDF).
- **Ficha médica imprimible** con los datos que un médico necesita de entrada.
- **Exportación a calendario** (`.ics`) de medicamentos y citas, y **respaldo completo** en `.json`.

## Privacidad

Toda la información se guarda **únicamente en tu dispositivo**: `localStorage` para los registros y `IndexedDB` para los archivos adjuntos. No hay servidor, no hay cuenta y nada se envía a internet. Si borras los datos del navegador, se borra la información — para eso está el respaldo en `.json`.

## Cómo ejecutarla localmente

No hay paso de compilación ni dependencias. Hace falta servirla por HTTP (abrirla con `file://` rompe los módulos ES, el Service Worker y IndexedDB):

```bash
python -m http.server 8777
# o: npx serve .
```

Luego abre `http://localhost:8777`.

## Estructura

| Archivo | Rol |
|---|---|
| `index.html` | Todas las vistas y modales de la app |
| `js/app.js` | Lógica, renderizado, recordatorios y eventos |
| `js/storage.js` | Persistencia y forma de los datos |
| `js/utils.js` | Fechas, cálculo de frecuencias, generación de `.ics` |
| `sw.js` | Service Worker (soporte offline) |

Al cambiar cualquier archivo cacheado hay que subir `CACHE_NAME` en `sw.js` para que los clientes instalados reciban la actualización.

## Aviso

Esta app es una herramienta de registro personal. No reemplaza el criterio médico: sigue siempre las indicaciones de tu especialista.
