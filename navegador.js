'use strict';

/**
 * Envío de mensajes de Wallapop manejando un Chrome propio.
 *
 * Se usa la interfaz real del chat, no la API interna: los mensajes de
 * Wallapop viajan por PubNub con un token que caduca cada 60 minutos, así que
 * replicar eso a mano se rompería solo. Manejando el navegador se envía
 * exactamente igual que si lo escribieras tú.
 *
 * Habla con Chrome por CDP usando el WebSocket nativo de Node: cero dependencias.
 */

const { spawn } = require('child_process');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEL_TEXTAREA = 'textarea.wallapop-chat-input__textarea';
const SEL_ENVIAR = 'button.wallapop-chat-input__send-button';

/**
 * Localiza la caja del chat dentro de la página.
 *
 * Se inyecta como texto en cada evaluación. La clase con nombre propio es lo
 * normal, pero algunas conversaciones tardan en montar el componente y conviene
 * un plan B: cualquier textarea cuyo placeholder hable de chatear o mensaje
 * (nunca el buscador, que es un input).
 */
const BUSCA_CAJA = `(() => document.querySelector('${SEL_TEXTAREA}')
  || [...document.querySelectorAll('textarea')].find(t => /chatear|mensaje|escribe/i.test(t.placeholder || ''))
  || null)()`;

// ------------------------------------------------------------------ Chrome

async function chromeVivo(puerto) {
  try {
    const r = await fetch(`http://127.0.0.1:${puerto}/json/version`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Arranca el Chrome dedicado si hace falta y espera a que responda. */
async function asegurarChrome(nav, log) {
  if (await chromeVivo(nav.puerto)) return true;

  if (!fs.existsSync(nav.chrome)) {
    log(`no encuentro Chrome en ${nav.chrome}`);
    return false;
  }
  log('arrancando el Chrome del vigilante...');
  const hijo = spawn(
    nav.chrome,
    [
      `--remote-debugging-port=${nav.puerto}`,
      `--user-data-dir=${nav.perfil}`,
      // Por debajo de ~900 px Wallapop sirve la versión móvil, que no tiene
      // el panel con Comprar / Hacer oferta / Chat.
      '--window-size=1400,950',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      'https://es.wallapop.com/app/chat',
    ],
    { detached: true, stdio: 'ignore' },
  );
  hijo.unref();

  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (await chromeVivo(nav.puerto)) return true;
  }
  log('el Chrome del vigilante no respondió');
  return false;
}

// --------------------------------------------------------------------- CDP

function conectar(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pendientes = new Map();
    let siguienteId = 0;

    ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = m.id && pendientes.get(m.id);
      if (!p) return;
      pendientes.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    });

    ws.addEventListener('error', () => reject(new Error('no pude conectar con Chrome por CDP')));
    ws.addEventListener('close', () => {
      for (const p of pendientes.values()) p.rej(new Error('Chrome cerró la conexión'));
      pendientes.clear();
    });

    ws.addEventListener('open', () =>
      resolve({
        pide(metodo, params = {}) {
          return new Promise((res, rej) => {
            const id = ++siguienteId;
            pendientes.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method: metodo, params }));
            setTimeout(() => {
              if (pendientes.delete(id)) rej(new Error(`${metodo} no contestó a tiempo`));
            }, 30000);
          });
        },
        cierra: () => ws.close(),
      }),
    );
  });
}

/** Ejecuta una función dentro de la página y devuelve su resultado. */
async function enPagina(pg, fn, ...args) {
  const expr = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(',')})`;
  const r = await pg.pide('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'error dentro de la página');
  return r.result.value;
}

/**
 * Pulsa el botón cuyo texto sea uno de los dados.
 *
 * Los botones Comprar / Hacer oferta / Chat de la ficha viven en shadow roots
 * CERRADOS: document.querySelector no los ve y el árbol de accesibilidad
 * tampoco los expone. DOM.getDocument con pierce:true sí los atraviesa.
 */
/**
 * Pulsa el botón Comprar / Hacer oferta / Chat de la ficha del anuncio.
 *
 * Estos controles son <walla-button> y su etiqueta vive en un shadow root
 * CERRADO, así que buscar el texto "Chat" no sirve: ni textContent, ni el árbol
 * de accesibilidad, ni recorrer el DOM con pierce lo alcanzan. Pero el propio
 * elemento está en el DOM normal y lleva la etiqueta en un atributo, así que
 * basta con un querySelector corriente sobre walla-button[text].
 *
 * Se compara el atributo exacto: confundirse aquí sería pulsar "Comprar".
 * Y hay varias copias del mismo botón (móvil/escritorio); sólo vale la visible.
 */
async function clicarPorTexto(pg, texto) {
  // El <walla-button> es sólo el envoltorio: el <button> con el listener vive
  // en su shadow CERRADO, así que llamar a .click() sobre el envoltorio no
  // hace nada. Por eso se hace un clic de ratón real sobre sus coordenadas:
  // el evento llega al elemento que esté pintado encima, shadow incluido.
  const doc = await pg.pide('DOM.getDocument', { depth: 1 });
  const { nodeIds } = await pg.pide('DOM.querySelectorAll', {
    nodeId: doc.root.nodeId,
    selector: `walla-button[text="${texto}"]`,
  });
  if (!nodeIds.length) {
    const vistos = await enPagina(pg, () =>
      [...document.querySelectorAll('walla-button[text]')].map((e) => e.getAttribute('text')).slice(0, 10));
    return { ok: false, vistos: vistos.length, etiquetas: vistos };
  }

  for (const nodeId of nodeIds) {
    try {
      await pg.pide('DOM.scrollIntoViewIfNeeded', { nodeId });
      const { model } = await pg.pide('DOM.getBoxModel', { nodeId });
      const [x1, y1, x2, , , y3] = model.content;
      const x = Math.round((x1 + x2) / 2);
      const y = Math.round((y1 + y3) / 2);
      if (!model.width || !model.height) continue; // copia oculta

      for (const type of ['mousePressed', 'mouseReleased']) {
        await pg.pide('Input.dispatchMouseEvent', {
          type, x, y, button: 'left', clickCount: 1,
        });
      }
      return { ok: true };
    } catch {
      continue; // este ejemplar no está renderizado; probamos el siguiente
    }
  }
  return { ok: false, vistos: nodeIds.length, etiquetas: [texto] };
}

/**
 * Saca la ventana de Chrome del estado minimizado.
 *
 * Minimizada, Chrome suspende el cálculo de posiciones: los elementos existen
 * en el DOM pero no tienen dimensiones, así que no se puede clicar sobre sus
 * coordenadas. Sin esto, el botón Chat se encuentra pero es imposible pulsarlo.
 */
async function ventanaVisible(puerto, targetId, log) {
  let nav;
  try {
    const info = await (await fetch(`http://127.0.0.1:${puerto}/json/version`)).json();
    nav = await conectar(info.webSocketDebuggerUrl);
    const { windowId, bounds } = await nav.pide('Browser.getWindowForTarget', { targetId });
    if (bounds.windowState === 'minimized') {
      log('la ventana de Chrome estaba minimizada, restaurándola');
      await nav.pide('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await sleep(800);
    }
    await nav.pide('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState: 'normal', width: 1400, height: 950 },
    });
  } catch { /* si no se puede, seguimos e intentamos igual */ } finally {
    try {
      nav?.cierra();
    } catch { /* da igual */ }
  }
}

async function primeraPagina(puerto) {
  const r = await fetch(`http://127.0.0.1:${puerto}/json/list`);
  const paginas = (await r.json()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!paginas.length) throw new Error('Chrome no tiene ninguna pestaña abierta');
  // Preferimos una pestaña que ya esté en Wallapop, para no pisar otra cosa.
  return paginas.find((p) => (p.url || '').includes('wallapop.com')) || paginas[0];
}

// ------------------------------------------------------------------ envío

/**
 * Abre el chat del anuncio y manda el texto.
 * Devuelve {ok:true} o {ok:false, motivo:'...'}.
 */
async function enviarMensaje({ nav, itemUrl, texto, log, soloProbar = false }) {
  if (!(await asegurarChrome(nav, log))) return { ok: false, motivo: 'Chrome no disponible' };
  if (!itemUrl) return { ok: false, motivo: 'falta la URL del anuncio' };

  let pg;
  let pgChat = null; // id de la pestaña del chat, para cerrarla al terminar
  try {
    const destino = await primeraPagina(nav.puerto);
    await ventanaVisible(nav.puerto, destino.id, log);
    pg = await conectar(destino.webSocketDebuggerUrl);
    await pg.pide('Page.enable');
    await pg.pide('Runtime.enable');
    await pg.pide('DOM.enable');

    // Chrome suspende el renderizado de las pestañas que no se ven: los
    // elementos existen en el DOM pero miden cero y no se pueden clicar. Con la
    // ventana en segundo plano document.visibilityState era "hidden" y por eso
    // el botón Chat resultaba imposible de pulsar. Estas dos órdenes le hacen
    // creer que está en primer plano sin robarte el foco.
    try {
      await pg.pide('Page.bringToFront');
      await pg.pide('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch { /* si no están disponibles, se intenta igual */ }
    // Nada de Emulation.setDeviceMetricsOverride: con el override activo la
    // búsqueda del DOM deja de encontrar los <walla-button>. El ancho de
    // escritorio se consigue arrancando Chrome con --window-size.

    // Se entra por la ficha del anuncio y se pulsa Chat. La URL directa
    // /app/chat?itemId=… NO sirve: sólo carga la bandeja de entrada, la
    // conversación no llega a abrirse (comprobado a lo largo de 40 s).
    await pg.pide('Page.navigate', { url: 'about:blank' });
    await sleep(500);
    await pg.pide('Page.navigate', { url: itemUrl });

    let pulsado = false;
    let ultimoFallo = null;
    let ultimoVistazo = null;
    for (let i = 0; i < 25 && !pulsado; i++) {
      await sleep(1200);
      try {
        const r = await clicarPorTexto(pg, 'Chat');
        pulsado = r?.ok === true;
        if (!pulsado) ultimoVistazo = r;
      } catch (err) {
        ultimoFallo = err.message; // la página puede seguir montándose
      }
    }
    if (!pulsado) {
      const detalle = ultimoFallo
        ? `error: ${ultimoFallo}`
        : `vi ${ultimoVistazo?.vistos ?? 0} botones [${(ultimoVistazo?.etiquetas || []).join(', ')}]`;
      return { ok: false, motivo: `no encontré el botón Chat en la ficha (${detalle})` };
    }

    // El botón abre la conversación en una pestaña nueva.
    let chatTarget = null;
    for (let i = 0; i < 20 && !chatTarget; i++) {
      await sleep(1000);
      const lista = await (await fetch(`http://127.0.0.1:${nav.puerto}/json/list`)).json();
      chatTarget = lista.find((t) => t.type === 'page' && /\/app\/chat\?itemId=/.test(t.url || ''));
    }
    if (!chatTarget) return { ok: false, motivo: 'el botón Chat no abrió la conversación' };

    pg.cierra();
    pgChat = chatTarget.id;
    pg = await conectar(chatTarget.webSocketDebuggerUrl);
    await pg.pide('Page.enable');
    await pg.pide('Runtime.enable');

    // Esperamos a que cargue la conversación (o a detectar que no hay sesión).
    let estado = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      try {
        estado = await enPagina(
          pg,
          (buscaCaja) => ({
            hayCaja: !!eval(buscaCaja),
            sinSesion: /\/auth\/|\/login/i.test(location.href) ||
              /Regístrate o inicia sesión/i.test(document.body?.innerText || ''),
            // Mensajes ya enviados por nosotros en esta conversación.
            mios: document.querySelectorAll('.wallapop-chat-message--own, [class*="message--own"], [class*="own-message"]').length,
          }),
          BUSCA_CAJA,
        );
      } catch {
        continue; // la página aún está navegando
      }
      if (estado.sinSesion) return { ok: false, motivo: 'la sesión de Wallapop ha caducado, hay que volver a entrar' };
      if (estado.hayCaja) break;
    }
    if (!estado?.hayCaja) return { ok: false, motivo: 'no apareció la caja de texto del chat' };

    // Salvaguarda: si ya le habíamos escrito, no repetimos.
    if (estado.mios > 0) return { ok: false, motivo: 'ya había mensajes tuyos en esta conversación' };

    const escrito = await enPagina(
      pg,
      (buscaCaja, selBtn, txt) => {
        const ta = eval(buscaCaja);
        if (!ta) return { ok: false, motivo: 'sin caja de texto' };
        // Angular sólo se entera si se usa el setter nativo y se emite 'input'.
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, txt);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        const btn = document.querySelector(selBtn);
        return { ok: !!btn, valor: ta.value, botonActivo: btn ? !btn.disabled : false };
      },
      BUSCA_CAJA,
      SEL_ENVIAR,
      texto,
    );
    if (!escrito.ok) return { ok: false, motivo: escrito.motivo || 'no encontré el botón de enviar' };
    if (escrito.valor !== texto) return { ok: false, motivo: 'el texto no se escribió bien' };

    await sleep(600); // que Angular habilite el botón

    if (soloProbar) {
      const listo = await enPagina(
        pg,
        (selBtn) => {
          const b = document.querySelector(selBtn);
          return { botonActivo: !!b && !b.disabled };
        },
        SEL_ENVIAR,
      );
      // Dejamos la caja limpia para no sorprender a nadie con texto pendiente.
      await enPagina(
        pg,
        (buscaCaja) => {
          const ta = eval(buscaCaja);
          if (!ta) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, '');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        },
        BUSCA_CAJA,
      );
      return listo.botonActivo
        ? { ok: true, motivo: 'PRUEBA: texto escrito y botón activo, no se ha enviado' }
        : { ok: false, motivo: 'PRUEBA: el botón de enviar no se activó' };
    }

    const enviado = await enPagina(
      pg,
      (selBtn) => {
        const btn = document.querySelector(selBtn);
        if (!btn || btn.disabled) return { ok: false, motivo: 'el botón de enviar sigue deshabilitado' };
        btn.click();
        return { ok: true };
      },
      SEL_ENVIAR,
    );
    if (!enviado.ok) return { ok: false, motivo: enviado.motivo };

    // Confirmamos que el mensaje aparece en la conversación y la caja se vació.
    for (let i = 0; i < 10; i++) {
      await sleep(800);
      const ok = await enPagina(
        pg,
        (buscaCaja, txt) => {
          const ta = eval(buscaCaja);
          const cuerpo = document.body?.innerText || '';
          return { vacia: ta ? ta.value === '' : false, aparece: cuerpo.includes(txt) };
        },
        BUSCA_CAJA,
        texto,
      );
      if (ok.vacia && ok.aparece) return { ok: true };
    }
    return { ok: false, motivo: 'no pude confirmar que se enviara' };
  } catch (err) {
    return { ok: false, motivo: err.message };
  } finally {
    try {
      pg?.cierra();
    } catch { /* da igual */ }
    // Cerramos la pestaña del chat para que no se acumulen.
    if (pgChat) {
      try {
        await fetch(`http://127.0.0.1:${nav.puerto}/json/close/${pgChat}`);
      } catch { /* da igual */ }
    }
  }
}

/** Comprueba si el Chrome del vigilante tiene sesión iniciada en Wallapop. */
async function comprobarSesion({ nav, log }) {
  if (!(await asegurarChrome(nav, log))) return { ok: false, motivo: 'Chrome no disponible' };
  let pg;
  try {
    const destino = await primeraPagina(nav.puerto);
    pg = await conectar(destino.webSocketDebuggerUrl);
    await pg.pide('Runtime.enable');
    await pg.pide('Page.navigate', { url: 'https://es.wallapop.com/app/chat' });
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      try {
        const r = await enPagina(pg, () => {
          const t = document.body?.innerText || '';
          const u = location.href;
          return {
            // Sin sesión, Wallapop redirige a /auth/onboarding antes incluso
            // de pintar nada, así que la URL es la señal fiable.
            fuera: /\/auth\/|\/login/i.test(u) || /Regístrate o inicia sesión/i.test(t),
            dentro: /\/app\/chat/i.test(u) && /Bandeja de Entrada|Buzón|Empieza a chatear/i.test(t),
          };
        });
        if (r.dentro) return { ok: true };
        if (r.fuera) return { ok: false, motivo: 'sin sesión: entra en Wallapop en esa ventana de Chrome' };
      } catch { /* sigue cargando */ }
    }
    return { ok: false, motivo: 'no pude determinar el estado de la sesión' };
  } catch (err) {
    return { ok: false, motivo: err.message };
  } finally {
    try {
      pg?.cierra();
    } catch { /* da igual */ }
  }
}

module.exports = { enviarMensaje, comprobarSesion, asegurarChrome };
