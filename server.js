const express = require('express');
const path = require('path');
const { consultar, cerrar, precalentar, ConsultaError } = require('./robots');

const PORT = process.env.PORT || 3000;
const MAX_SIMULTANEAS = 3;
let activas = 0;

const app = express();
app.use(express.json({ limit: '10kb' }));

// El front-end (index.html) puede vivir en otro dominio (p. ej. Azure) y pedirle
// el resultado a este robot. Solo se abre la ruta de la API, no el resto del servidor.
app.use(['/api/consulta', '/api/pagar-helppiupay'], (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Solo se publican las dos páginas; nada más de la carpeta del proyecto.
app.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/index2.html', (_req, res) => res.sendFile(path.join(__dirname, 'index2.html')));

app.post('/api/consulta', async (req, res) => {
  const cedula = String(req.body?.cedula ?? '').replace(/[\s.]/g, '');
  const placa = String(req.body?.placa ?? '').replace(/\s/g, '').toUpperCase();
  if (!/^\d{5,20}$/.test(cedula)) return res.status(400).json({ ok: false, code: 'DATOS', error: 'Ingresa un documento válido (solo números, sin puntos ni espacios).' });
  if (!/^[A-Z0-9]{5,12}$/.test(placa)) return res.status(400).json({ ok: false, code: 'DATOS', error: 'Ingresa una placa válida (sin espacios).' });
  if (activas >= MAX_SIMULTANEAS) return res.status(429).json({ ok: false, code: 'OCUPADO', error: 'Hay muchas consultas en curso. Intenta de nuevo en unos segundos.' });

  activas++;
  try {
    const r = await consultar({ cedula, placa });
    res.json({ ok: true, ...r });
  } catch (e) {
    const code = e instanceof ConsultaError ? e.code : 'ROBOT';
    const msg = code === 'NO_ENCONTRADO' ? e.message : 'No pudimos completar la consulta en este momento. Intenta de nuevo.';
    console.error(`[consulta ${code}]`, e.message);
    res.status(code === 'NO_ENCONTRADO' ? 404 : 502).json({ ok: false, code, error: msg });
  } finally {
    activas--;
  }
});

// ============= PAGAR CON HELPPIUPAY (CHECKOUT SESSIONS) =============
// Las llaves van como variables de entorno en Render (HELPPIU_KEY_ID, HELPPIU_SECRET, HELPPIU_API_URL).
const HELPPIU_KEY_ID = process.env.HELPPIU_KEY_ID;
const HELPPIU_SECRET = process.env.HELPPIU_SECRET;
const HELPPIU_API_URL = process.env.HELPPIU_API_URL || 'https://helppiupay.com/api/v1/checkout-sessions';

app.post('/api/pagar-helppiupay', async (req, res) => {
  try {
    const { credito, valor, nombre, apellido, email } = req.body || {};
    if (!credito || !valor) return res.status(400).json({ error: 'Faltan credito o valor' });
    if (!HELPPIU_KEY_ID || !HELPPIU_SECRET) return res.status(500).json({ error: 'Faltan llaves de HelppiuPay en el servidor' });

    const amount = parseInt(String(valor).replace(/[^\d]/g, ''), 10);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'El valor no es válido: ' + valor });
    if (amount < 1000) return res.status(400).json({ error: 'El monto mínimo es 1000 COP' });

    const body = {
      reference: `GM-${credito}-${Date.now()}`,
      amount,
      currency: 'COP',
      description: `Pago crédito GM Financial #${credito}`,
      success_url: 'https://tusitio.com/pago-exitoso',
      cancel_url: 'https://tusitio.com/pago-cancelado',
      customer_email: email || '',
      customer_name: `${nombre || ''} ${apellido || ''}`.trim(),
      payment_method_types: ['pse']
    };
    console.log('[HELPPIU] Checkout Session - Crédito:', credito, '- Monto:', amount);

    const response = await fetch(HELPPIU_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${HELPPIU_KEY_ID}:${HELPPIU_SECRET}` },
      body: JSON.stringify(body)
    });
    const texto = await response.text();
    let data;
    try { data = JSON.parse(texto); } catch (e) {
      console.error('[HELPPIU] Respuesta no es JSON:', texto.substring(0, 500));
      return res.status(response.status).json({ error: 'HelppiuPay devolvió una respuesta no válida', statusCode: response.status });
    }
    if (!response.ok) {
      console.error('[HELPPIU ERROR]', data);
      return res.status(response.status).json({ error: data.message || data.error || 'Error al crear la sesión', detalle: data });
    }
    const url = data.url || data.checkout_url;
    if (!url) {
      console.error('[HELPPIU] No se recibió url. Respuesta:', data);
      return res.status(500).json({ error: 'HelppiuPay no devolvió una URL de pago', detalle: data });
    }
    console.log('[HELPPIU] URL generada:', url);
    res.json({ url });
  } catch (error) {
    console.error('[HELPPIU ERROR]', error);
    res.status(500).json({ error: error.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Consulta de recaudos en http://localhost:${PORT}`);
  precalentar(); // abre el navegador de una vez, sin esperar la primera consulta
});
const salir = async () => { server.close(); await cerrar(); process.exit(0); };
process.on('SIGINT', salir);
process.on('SIGTERM', salir);
