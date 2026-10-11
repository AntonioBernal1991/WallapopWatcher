# Wallapop Watcher

Vigila Wallapop cada pocos minutos y te manda un **WhatsApp** cuando aparece un chollo.
Sin dependencias: sólo Node y el bridge de WhatsApp que ya tienes autenticado.

```
🔥 CHOLLO · iPhone 13

📱 iPhone 13 128GB impecable
💰 185 € — 26% por debajo de la media (250 €)
📍 Madrid, Madrid · 📦 con envío · 🕒 hace 4 min

https://es.wallapop.com/item/...
```

## Uso

| Quiero… | Comando |
|---|---|
| Probar que WhatsApp funciona | `node watcher.js --test` |
| **Búscame ya y mándamelo** | `node watcher.js --ahora` |
| …sólo una de las búsquedas | `node watcher.js --ahora "zelda"` |
| Una sola pasada | `node watcher.js --once` |
| Vigilar en bucle | doble clic en **start.bat** |
| Que arranque solo con Windows | `powershell -ExecutionPolicy Bypass -File instalar-inicio-automatico.ps1` |
| Dejar de arrancar solo | el mismo comando con `-Quitar` |
| Ver qué reconoce el catálogo | `node watcher.js --diagnostico` |
| **Ensayar una búsqueda sin enviar nada** | `node watcher.js --simular "spirit tracks"` |
| Perfiles separados | `node watcher.js --config otro.json` |

## Qué considera un "chollo"

`maxPrice` por sí solo te avisaría de cualquier cosa barata, y lo barato en
Wallapop suele ser una funda. Lo que distingue "barato" de "chollo" es
comparar contra **lo que se está pidiendo ahora mismo por ese mismo producto**.

Un anuncio te llega sólo si cumple **todo**:

- No lo habías visto antes (memoria en `seen.json`, 30 días).
- No está reservado.
- Su precio cae entre `minPrice` y `maxPrice`.
- Su **título** no contiene ninguna `excludeWords`.
- Está al menos un `dealPercent` **por debajo de la mediana** del mercado.

Se usa la mediana y no la media porque un solo anuncio absurdo (un Zelda a
150 €) desplaza la media y no la mediana. Y hacen falta al menos 5 anuncios
comparables: con menos, no hay mercado del que fiarse y no se opina.

> Las `excludeWords` sólo miran el título, no la descripción. Casi cualquier
> vendedor escribe "lo usé poco en mi consola", y filtrar por descripción
> tumbaría anuncios perfectamente buenos.

## Dos modos de búsqueda

### Producto concreto

Lo normal: unas `keywords`, un techo de precio y ya.

```jsonc
{
  "name": "Zelda Link's Awakening",
  "keywords": "zelda links awakening switch",
  "minPrice": 8,          // suelo anti-timo (anuncios de 1 € para captar)
  "maxPrice": 21          // techo duro
}
```

### Catálogo (`"mode": "catalog"`)

Para vigilar una **categoría entera** — "juegos de Switch" — donde una sola
mediana no serviría: mezclar un Zelda de 35 € con un indie de 5 € da un número
que no describe a ninguno de los dos. Lo que hace:

1. Barre los anuncios más recientes con varias `queries`.
2. Identifica **qué juego** es cada anuncio, usando `juegos-switch.json`.
3. Calcula la mediana **de ese título en concreto** (cacheada en `precios.json`).
4. Avisa si el anuncio está un `dealPercent` por debajo de *su* mediana.

```jsonc
{
  "name": "Juegos Switch bajo precio medio",
  "mode": "catalog",
  "catalogFile": "juegos-switch.json",
  "queries": ["juegos nintendo switch", "juego switch", "nintendo switch cartucho"],
  "minPrice": 5,
  "maxPrice": 80,
  "dealPercent": 30,               // 30% bajo la media de ESE juego
  "medianTtlHours": 24,            // cada cuánto se recalculan las medias
  "maxMedianLookupsPerCycle": 6    // consultas de media por pasada
}
```

Los anuncios que no correspondan a ningún juego del catálogo se ignoran.

### Afinar el catálogo

`node watcher.js --diagnostico` imprime tres listas: qué reconoce, qué no
reconoce (candidatos a añadir) y qué descarta por `excludeWords`.

Cada juego del catálogo tiene `alias` (textos que lo identifican en el título)
y opcionalmente `excluir`. Gana el alias **más largo que encaje**, de modo que
"Super Mario Party Jamboree" no se confunda con "Super Mario Party". `excluir`
remata lo que ningún alias separa:

```jsonc
{ "id": "minecraft", "nombre": "Minecraft", "alias": ["minecraft"],
  "excluir": ["dungeons", "legends"], "busqueda": "minecraft nintendo switch juego" }
```

Sin ese `excluir`, "Minecraft Dungeons" contaminaría la media de Minecraft.

## Configuración (`config.json`)

```jsonc
{
  "pollMinutes": 5,          // cada cuánto mira
  "maxAlertsPerCycle": 8,    // tope de mensajes por pasada (el resto, a la cola)

  "location": {
    "latitude": 40.4168,     // ← pon tus coordenadas
    "longitude": -3.7038,
    "distanceKm": 0          // 0 = toda España
  },

  "seenTtlDays": 180,        // cuánto recuerda un anuncio ya avisado
  "pausaNocturna": { "desdeHora": 1, "hastaHora": 7 },   // no busca en esa franja

  "excludeStartsWith": [...],  // descarta por la PRIMERA palabra del título
  "excludeWords": [...],       // se aplican a TODAS las búsquedas
  "watches": [...]             // cada una puede sumar las suyas
}
```

`excludeStartsWith` existe porque "Caja Zelda Skyward Sword" contiene el nombre
entero del juego: ninguna palabra prohibida lo distingue, sólo que *empieza*
por "Caja". Lo mismo con "Manual …", "Carátula …" o "Póster …".

Cada aviso lleva una cabecera `🔄 Ronda #N · día, hora`, para saber de un
vistazo si dos mensajes vienen del mismo barrido o de barridos distintos. El
contador vive en `estado.json` y sobrevive a los reinicios.

Opciones por búsqueda: `keywords`, `minPrice`, `maxPrice`, `dealPercent`,
`excludeWords`, `requireWords`, `shippingOnly`, `categoryId`, `maxAgeDays`
(descarta anuncios más viejos que X días) y `matchDescription` (para volver a
filtrar también por descripción).

`excludeDescWords` es el término medio entre mirar sólo el título y mirarlo
todo: son las únicas palabras que se buscan **también en la descripción**. Mete
ahí sólo frases que no admitan duda ("no es el juego", "puntos vip", "versión
japonesa"), nunca algo ambiguo, o vuelves al problema que hizo que
`excludeWords` mirase sólo el título: casi cualquier vendedor escribe "lo usé
poco en mi consola" y eso tumbaba anuncios buenos. Existe porque hay anuncios
cuyo título es **idéntico** al del juego y sólo la descripción los delata: en
Spirit Tracks, una tarjeta de puntos de 10 € y la versión japonesa de 20 € se
anunciaban las dos como "Zelda Spirit Tracks - Nintendo DS".

### Ensayar antes de soltar una búsqueda

`node watcher.js --simular "<nombre>"` hace una pasada en seco: dice de qué
avisaría, y de lo demás **por qué** lo descarta (`filtro de palabras`,
`reservado`, `publicado hace 402 d`, `sobre el máximo`…). No toca `seen.json`
ni manda ningún WhatsApp, y es la única forma de ver una búsqueda todavía
apagada con `"enabled": false` — que es justo cuando quieres mirarla, antes de
encenderla y no después.

`requireWords` es la mejor defensa para un producto concreto: exigir
`["awakening"]` en el título evita que la búsqueda te cuele cualquier otro
Zelda que Wallapop considere "relacionado".

La config se relee **en cada pasada**: puedes editar `config.json` o el
catálogo con el vigilante corriendo, sin reiniciarlo.

Las `excludeWords` globales que vienen puestas cubren dos frentes: lo que no es
un juego (fundas, alfombrillas, soportes, lotes, consolas) y **otras consolas**
— sin eso, un Link's Awakening de Game Boy o un Smash de N64 se colarían en la
media del juego de Switch, que fue justo lo que pasó en las primeras pruebas.

Añade tantas entradas a `watches` como quieras. Cambia `pollMinutes` con
cabeza: por debajo de 3 minutos no ganas gran cosa y castigas la API.

## Detalles prácticos

- **Nunca repite un aviso**: cada anuncio enviado queda en `seen.json` y no
  vuelve a mandarse. La memoria dura `seenTtlDays` días (180 por defecto).
- **Primera pasada de cada búsqueda**: memoriza lo que hay sin avisarte, para
  no llenarte el WhatsApp con el histórico. Los avisos empiezan en la segunda.
- **Corriendo como tarea programada** no hay consola: mira `watcher.log` para
  comprobar que sigue dando rondas. Para pararlo del todo:
  `Stop-ScheduledTask -TaskName WallapopWatcher` y matar el `node.exe`, o
  ejecutar `instalar-inicio-automatico.ps1 -Quitar`.
- **Nombre de la búsqueda**: si cambias `name`, cuenta como búsqueda nueva y
  vuelve a memorizar sin avisar.
- **Si el bridge de WhatsApp está caído**, lo arranca solo. Si el envío falla,
  el anuncio **no** se marca como visto y se reintenta en la siguiente pasada.
- **Historial**: cada aviso enviado se apunta en `alerts.log` (una línea JSON
  por chollo), por si quieres revisar precios pasados.

## Cuando algo no va

## Mensajes automáticos al vendedor

Cuando salta un aviso que cumple la regla de su búsqueda, el vigilante le
escribe al vendedor por el chat de Wallapop.

```jsonc
// global
"autoMensaje": {
  "activo": true,                      // false lo apaga todo
  "texto": "hola, sigue disponible?",
  "maxPorDia": 4,                      // tope de mensajes al día
  "esperaMinutos": [3, 12],            // espera aleatoria antes de escribir
  "navegador": { "puerto": 9222, "perfil": "...\\chrome-perfil", "chrome": "...\\chrome.exe" }
}

// por búsqueda
"autoMensaje": { "activo": true, "maxPrice": 25 }
```

**Puesta en marcha (una sola vez):**

1. `node watcher.js --sesion` → abre un Chrome propio del vigilante
2. Inicia sesión en Wallapop **en esa ventana**
3. `node watcher.js --sesion` otra vez → debe decir `✅ sesión iniciada`

Ese Chrome tiene su propio perfil en `chrome-perfil/`, aparte del tuyo, y debe
quedarse abierto para que el vigilante pueda escribir. `node watcher.js --cola`
muestra lo enviado y lo pendiente.

**Cómo envía.** No replica la API interna: el chat de Wallapop va por PubNub
con un token que caduca cada 60 minutos, así que imitarlo se rompería solo. En
vez de eso maneja la interfaz real por CDP —el WebSocket nativo de Node, sin
dependencias— escribiendo en el mismo cuadro de texto que usarías tú.

**Salvaguardas**: nunca escribe dos veces al mismo anuncio (`mensajes.json`),
comprueba además en el propio chat que no haya mensajes tuyos previos, espera
unos minutos aleatorios en vez de escribir al segundo, respeta el tope diario y
deja 20-60 s entre mensajes. Cada mensaje enviado te llega también por WhatsApp.

> Aun así esto es automatizar mensajes, algo que las condiciones de uso de
> Wallapop no permiten. El riesgo de que limiten la cuenta es real; los límites
> de arriba lo reducen, no lo eliminan. `"activo": false` lo para en seco.

## Trampa de la API (importante si tocas el código)

`order_by=newest` **no ordena: restringe**. Devuelve sólo lo publicado hace muy
poco, así que en una búsqueda de nicho da 0 resultados de 36 — y combinado con
`max_sale_price` da cero siempre. Por eso `huntSearch()` lanza **dos**
consultas, una por relevancia (orden por defecto) y otra con `newest`, y une
los resultados. No lo simplifiques a una sola con `newest`.

Otros valores (`most_recent`, `creation_date`, `relevance`, `distance`)
devuelven HTTP 400. Los únicos válidos son `newest`, `price_low_to_high` y
`price_high_to_low`.

## Cuando algo no va

| Síntoma | Causa habitual |
|---|---|
| `el bridge no respondió a tiempo` | La sesión de WhatsApp caducó: arranca `whatsapp-bridge.exe` a mano y reescanea el QR. |
| `Wallapop responde 429` | Demasiadas consultas. Sube `pollMinutes` o reduce búsquedas. |
| Avisos de accesorios (fundas, cables) | Amplía `excludeWords` de esa búsqueda. |
| No llega ningún aviso nunca | `dealPercent` demasiado exigente. Bájalo o quítalo y mira `alerts.log`. |

## Piezas

| Archivo | Para qué |
|---|---|
| `watcher.js` | Todo el motor |
| `config.json` | Tus búsquedas |
| `juegos-switch.json` | Catálogo de juegos (145 títulos) con sus alias |
| `seen.json` | Memoria de anuncios ya avisados (se crea solo) |
| `precios.json` | Medias de mercado cacheadas por juego (se crea solo) |
| `alerts.log` | Historial de chollos enviados |
| `watcher.log` | Actividad del vigilante (para saber si sigue vivo) |
| `estado.json` | Contador de rondas (se crea solo) |
| `start.bat` | Arrancar con doble clic |
| `iniciar-oculto.vbs` | Arranque sin ventana (lo usa la tarea programada) |
| `instalar-inicio-automatico.ps1` | Instalar/quitar el arranque con Windows |
