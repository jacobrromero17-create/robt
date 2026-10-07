const express = require('express');
const path = require('path');
const { consultar, cerrar, precalentar, ConsultaError } = require('./robot');

const PORT = process.env.PORT || 3000;
const MAX_SIMULTANEAS = 3;
let activas = 0;

const app = express();
app.use(express.json({ limit: '2kb' }));

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

const server = app.listen(PORT, () => {
  console.log(`Consulta de recaudos en http://localhost:${PORT}`);
  precalentar(); // abre el navegador de una vez, sin esperar la primera consulta
});
const salir = async () => { server.close(); await cerrar(); process.exit(0); };
process.on('SIGINT', salir);
process.on('SIGTERM', salir);
