# Wallapop Watcher

**Un vigilante que revisa Wallapop cada pocos minutos y te avisa por WhatsApp cuando aparece un chollo de verdad.**

En Wallapop los buenos precios duran minutos. Si alguien sube un juego a mitad de precio, el primero que escribe se lo lleva. Wallapop Watcher hace esa vigilancia por ti: busca lo que te interesa y compara cada anuncio nuevo con lo que se pide por ese mismo producto en el mercado. Solo te escribe cuando el precio está claramente por debajo.

```
🔥 CHOLLO · Zelda Link's Awakening

🎮 Zelda Link's Awakening Nintendo Switch
💰 18 € — 40% por debajo de la media (30 €)
📍 Madrid, Madrid · 📦 con envío · 🕒 hace 4 min

https://es.wallapop.com/item/...
```

## ¿Para qué sirve?

- **Comprar barato sin estar pendiente del móvil.** Defines qué buscas y el vigilante se queda corriendo en segundo plano.
- **Distinguir un chollo de algo simplemente barato.** Un precio máximo fijo te avisaría de cualquier funda o caja vacía. Este programa calcula la **mediana del mercado** para cada producto y solo avisa cuando un anuncio queda un porcentaje por debajo de ella.
- **Vigilar categorías enteras.** Por ejemplo, *cualquier juego de Switch*. Reconoce qué juego es cada anuncio gracias a un catálogo de 145 títulos y lo compara con el precio medio de **ese** juego en concreto.
- **Llegar el primero (opcional).** Puede escribir al vendedor un mensaje del tipo *"hola, sigue disponible?"* en cuanto salta el aviso.

## Cómo funciona

1. Cada `pollMinutes` minutos consulta la API pública de búsqueda de Wallapop para cada búsqueda configurada.
2. Con una consulta sin límite de precio calcula la **mediana** de lo que se está pidiendo por el producto.
3. Filtra los anuncios nuevos:
   - descarta los que ya había visto y los reservados;
   - descarta los que se salen del rango de precio;
   - descarta accesorios, cajas vacías, otras consolas, copias, etc.
4. Si un anuncio queda un `dealPercent` por debajo de la mediana, te manda un WhatsApp con el precio, el descuento, la ubicación y el enlace.
5. Apunta el anuncio en `seen.json` para no repetirte el aviso nunca.

No tiene dependencias: solo Node.js y su `fetch` y `WebSocket` nativos.

## Requisitos

- **Windows** (los scripts de arranque automático son de Windows; el motor en sí es Node puro).
- **Node.js 22 o superior.**
- Un **bridge de WhatsApp** que acepte peticiones HTTP en local, como [whatsapp-mcp](https://github.com/lharries/whatsapp-mcp), ya vinculado a tu cuenta. El vigilante llama a `/health` y `/send` del bridge y, si está caído, lo arranca él mismo.
- *(Solo para los mensajes automáticos)* Google Chrome.

## Instalación

```bash
git clone https://github.com/AntonioBernal1991/WallapopWatcher.git
cd WallapopWatcher
copy config.example.json config.json
```

Después edita `config.json`:

- `whatsapp.recipient`: tu número con prefijo de país y sin `+` (por ejemplo `34600000000`).
- `whatsapp.tokenFile`, `bridgeExe`, `bridgeUrl`: dónde está tu bridge de WhatsApp.
- `location`: tus coordenadas y el radio en km (`0` = toda España).
- `watches`: lo que quieres vigilar (más abajo se explica cómo).

Comprueba que los avisos llegan:

```bash
node watcher.js --test
```

> `config.json` lleva tus datos personales y está en `.gitignore`: no se sube al repositorio.

## Uso

| Quiero… | Comando |
|---|---|
| Probar que WhatsApp funciona | `node watcher.js --test` |
| **Búscame ya y mándamelo** | `node watcher.js --ahora` |
| …solo una de las búsquedas | `node watcher.js --ahora "zelda"` |
| Una sola pasada | `node watcher.js --once` |
| Vigilar en bucle | doble clic en **start.bat** |
| Que arranque solo con Windows | `powershell -ExecutionPolicy Bypass -File instalar-inicio-automatico.ps1` |
| Dejar de arrancar solo | el mismo comando con `-Quitar` |
| Ver qué reconoce el catálogo | `node watcher.js --diagnostico` |
| **Ensayar una búsqueda sin enviar nada** | `node watcher.js --simular "spirit tracks"` |
| Perfiles separados | `node watcher.js --config otro.json` |
| Iniciar sesión para los mensajes automáticos | `node watcher.js --sesion` |
| Ver mensajes enviados y pendientes | `node watcher.js --cola` |

La configuración se relee **en cada pasada**, así que puedes editar `config.json` o el catálogo con el vigilante en marcha, sin reiniciarlo.

---

## Qué considera un "chollo"

Lo que distingue algo *barato* de un *chollo* es compararlo con **lo que se está pidiendo ahora mismo por ese mismo producto**.

Un anuncio solo te llega si cumple **todas** estas condiciones:

- No lo había visto antes (memoria en `seen.json`, que dura `seenTtlDays` días).
- No está reservado.
- Su precio está entre `minPrice` y `maxPrice`.
- Su **título** no contiene ninguna de las `excludeWords`.
- Está al menos un `dealPercent` **por debajo de la mediana** del mercado.

Se usa la mediana y no la media porque un solo anuncio absurdo (un Zelda a 150 €) mueve la media pero no la mediana. Además, hacen falta al menos 5 anuncios comparables: con menos no hay mercado fiable y el vigilante no opina.

> Las `excludeWords` solo miran el título, no la descripción. Casi cualquier vendedor escribe "lo usé poco en mi consola", y filtrar por la descripción tumbaría anuncios perfectamente buenos.

## Dos modos de búsqueda

### Producto concreto

Lo normal: unas `keywords`, un precio máximo y listo.

```jsonc
{
  "name": "Zelda Link's Awakening",
  "keywords": "zelda links awakening switch",
  "requireWords": ["awakening"],  // el título TIENE que llevarlo
  "minPrice": 8,                  // suelo anti-timo (anuncios de 1 € como gancho)
  "maxPrice": 21                  // precio máximo, sin excepciones
}
```

`requireWords` es la mejor defensa para un producto concreto: exigir `["awakening"]` evita que se cuele cualquier otro Zelda que Wallapop considere "relacionado".

### Catálogo (`"mode": "catalog"`)

Sirve para vigilar una **categoría entera**, por ejemplo "juegos de Switch". Ahí una sola mediana no sirve: mezclar un Zelda de 35 € con un indie de 5 € da un número que no describe a ninguno de los dos. En este modo el vigilante:

1. Repasa los anuncios más recientes con varias `queries`.
2. Identifica **qué juego** es cada anuncio, usando `juegos-switch.json`.
3. Calcula la mediana **de ese título en concreto** y la guarda en caché en `precios.json`.
4. Avisa si el anuncio está un `dealPercent` por debajo de *su* mediana.

```jsonc
{
  "name": "Juegos Switch bajo precio medio",
  "mode": "catalog",
  "catalogFile": "juegos-switch.json",
  "queries": ["juegos nintendo switch", "juego switch", "nintendo switch cartucho"],
  "minPrice": 5,
  "maxPrice": 80,
  "dealPercent": 30,               // 30% por debajo de la media de ESE juego
  "medianTtlHours": 24,            // cada cuánto se recalculan las medias
  "maxMedianLookupsPerCycle": 6    // consultas de media por pasada
}
```

Los anuncios que no corresponden a ningún juego del catálogo se ignoran.

#### Afinar el catálogo

`node watcher.js --diagnostico` muestra tres listas: lo que reconoce, lo que no reconoce (candidatos a añadir) y lo que descarta por `excludeWords`.

Cada juego del catálogo tiene `alias` (textos que lo identifican en el título) y, opcionalmente, `excluir`. Gana el alias **más largo que encaje**, así "Super Mario Party Jamboree" no se confunde con "Super Mario Party". `excluir` resuelve los casos que ningún alias separa:

```jsonc
{ "id": "minecraft", "nombre": "Minecraft", "alias": ["minecraft"],
  "excluir": ["dungeons", "legends"], "busqueda": "minecraft nintendo switch juego" }
```

Sin ese `excluir`, "Minecraft Dungeons" contaminaría la media de Minecraft.

## Configuración (`config.json`)

```jsonc
{
  "pollMinutes": 5,          // cada cuánto mira
  "maxAlertsPerCycle": 8,    // máximo de mensajes por pasada (el resto espera a la siguiente)
  "seenTtlDays": 180,        // cuánto recuerda un anuncio ya avisado
  "pausaNocturna": { "desdeHora": 1, "hastaHora": 7 },   // no busca en esa franja

  "location": {
    "latitude": 40.4168,     // ← pon tus coordenadas
    "longitude": -3.7038,
    "distanceKm": 0          // 0 = toda España
  },

  "excludeStartsWith": [...],   // descarta por la PRIMERA palabra del título
  "excludeWords": [...],        // se aplican a TODAS las búsquedas
  "gruposExcluidos": {...},     // listas de otras consolas, que cada búsqueda elige con excludeGroups
  "watches": [...]              // tus búsquedas; cada una puede añadir sus propios filtros
}
```

**Opciones de cada búsqueda:** `keywords`, `minPrice`, `maxPrice`, `dealPercent`, `excludeWords`, `excludeDescWords`, `excludeGroups`, `requireWords`, `shippingOnly`, `categoryId`, `maxAgeDays` (descarta anuncios con más de X días), `matchDescription` (aplica los filtros también a la descripción) y `enabled`.

### Filtros que merecen explicación

- **`excludeStartsWith`.** "Caja Zelda Skyward Sword" contiene el nombre entero del juego, así que ninguna palabra prohibida lo distingue: lo único que lo delata es que *empieza* por "Caja". Pasa lo mismo con "Manual …", "Carátula …" o "Póster …".
- **`excludeDescWords`.** Es el punto intermedio entre mirar solo el título y mirarlo todo: son las únicas palabras que se buscan **también en la descripción**. Pon ahí solo frases que no dejen duda ("no es el juego", "puntos vip", "versión japonesa"). Existe porque hay anuncios con un título **idéntico** al del juego que solo se delatan en la descripción.
- **`gruposExcluidos`.** Estas listas no pueden ser globales: excluir "game boy" es imprescindible si vigilas Switch y rompe por completo la vigilancia de un juego de Game Boy. Por eso cada búsqueda elige su grupo.

### Ensayar antes de activar una búsqueda

`node watcher.js --simular "<nombre>"` hace una pasada de prueba. Te dice de qué anuncios avisaría y, del resto, **por qué** los descarta (`filtro de palabras`, `reservado`, `publicado hace 402 d`, `sobre el máximo`…). No toca `seen.json` ni manda ningún WhatsApp. Además funciona con búsquedas desactivadas (`"enabled": false`), así puedes revisarlas antes de activarlas.

## Detalles prácticos

- **Nunca repite un aviso.** Cada anuncio enviado queda en `seen.json` y no vuelve a mandarse.
- **Primera pasada de cada búsqueda.** El vigilante memoriza lo que ya hay sin avisarte, para no llenarte el WhatsApp con anuncios antiguos. Los avisos empiezan en la segunda pasada. Si cambias el `name` de una búsqueda, cuenta como nueva.
- **Rondas numeradas.** Cada aviso lleva una cabecera `🔄 Ronda #N · día, hora`, así sabes si dos mensajes vienen de la misma ronda. El contador se guarda en `estado.json`.
- **Si WhatsApp falla.** Si el bridge está caído, lo arranca solo. Si el envío falla, el anuncio **no** se marca como visto y se reintenta en la siguiente pasada.
- **Historial.** Cada aviso se guarda en `alerts.log` (una línea JSON por chollo).
- **En segundo plano no hay consola.** Mira `watcher.log` para comprobar que sigue funcionando. Para pararlo: `Stop-ScheduledTask -TaskName WallapopWatcher` y cierra el proceso `node.exe`, o ejecuta `instalar-inicio-automatico.ps1 -Quitar`.

## Mensajes automáticos al vendedor (opcional)

Cuando salta un aviso que cumple la regla de su búsqueda, el vigilante puede escribir al vendedor por el chat de Wallapop. **Viene desactivado.**

```jsonc
// global
"autoMensaje": {
  "activo": true,                      // false lo apaga todo
  "texto": "hola, sigue disponible?",
  "maxPorDia": 4,                      // máximo de mensajes al día
  "esperaMinutos": [3, 12],            // espera aleatoria antes de escribir
  "navegador": { "puerto": 9222, "perfil": "...\\chrome-perfil", "chrome": "...\\chrome.exe" }
}

// en cada búsqueda
"autoMensaje": { "activo": true, "maxPrice": 25 }
```

**Puesta en marcha (una sola vez):**

1. Ejecuta `node watcher.js --sesion`. Se abre un Chrome propio del vigilante, con su propio perfil en `chrome-perfil/`, aparte del tuyo.
2. Inicia sesión en Wallapop **en esa ventana**.
3. Ejecuta `node watcher.js --sesion` otra vez. Debe decir `✅ sesión iniciada`.

Ese Chrome tiene que quedarse abierto para que el vigilante pueda escribir.

**Cómo envía.** No imita la API interna: el chat de Wallapop va por PubNub con un token que caduca cada 60 minutos, así que una imitación dejaría de funcionar sola. En su lugar maneja la página real por el protocolo de depuración de Chrome (CDP) y escribe en el mismo cuadro de texto que usarías tú.

**Salvaguardas:**

- Nunca escribe dos veces al mismo anuncio (`mensajes.json`) y comprueba en el propio chat que no le hayas escrito ya.
- Espera unos minutos aleatorios antes de escribir y deja 20-60 s entre mensajes.
- Respeta el máximo diario.
- Cada mensaje enviado te llega también por WhatsApp.

> ⚠️ Esto es automatizar mensajes, algo que las condiciones de uso de Wallapop no permiten. El riesgo de que limiten tu cuenta es real: estos límites lo reducen, pero no lo eliminan. `"activo": false` lo desactiva al momento.

## Cuando algo no va

| Síntoma | Causa habitual |
|---|---|
| `el bridge no respondió a tiempo` | La sesión de WhatsApp caducó: arranca el bridge a mano y vuelve a escanear el QR. |
| `Wallapop responde 429` | Demasiadas consultas. Sube `pollMinutes` o reduce búsquedas. |
| Llegan avisos de accesorios (fundas, cables) | Amplía las `excludeWords` de esa búsqueda. |
| No llega ningún aviso nunca | `dealPercent` demasiado exigente. Bájalo y revisa `--simular` o `alerts.log`. |

No bajes `pollMinutes` de 3: no ganas casi nada y sobrecargas la API.

## Nota técnica: cuidado con la API

`order_by=newest` **no ordena, restringe**. Devuelve solo lo publicado hace muy poco, así que en una búsqueda poco común da 0 resultados, y combinado con `max_sale_price` da cero siempre. Por eso `huntSearch()` lanza **dos** consultas, una por relevancia y otra con `newest`, y junta los resultados. No lo simplifiques a una sola consulta con `newest`.

Los únicos valores válidos de `order_by` son `newest`, `price_low_to_high` y `price_high_to_low`. Los demás (`most_recent`, `creation_date`, `relevance`, `distance`) devuelven HTTP 400.

## Archivos

| Archivo | Para qué |
|---|---|
| `watcher.js` | El motor: búsqueda, filtros, medianas y avisos |
| `navegador.js` | Control de Chrome por CDP para los mensajes automáticos |
| `config.example.json` | Plantilla de configuración (cópiala a `config.json`) |
| `juegos-switch.json` | Catálogo de 145 juegos de Switch con sus alias |
| `start.bat` | Arrancar con doble clic |
| `iniciar-oculto.vbs` | Arranque sin ventana (lo usa la tarea programada) |
| `instalar-inicio-automatico.ps1` | Activa o quita el arranque automático con Windows |

Se generan solos y no se suben al repositorio: `config.json`, `seen.json`, `precios.json`, `estado.json`, `mensajes.json`, `alerts.log`, `watcher.log` y `chrome-perfil/`.
