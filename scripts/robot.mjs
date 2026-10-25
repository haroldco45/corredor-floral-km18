// Robot del Corredor Floral KM 18
// Cada 30 minutos (GitHub Actions) busca videos nuevos en YouTube y noticias en Google News
// sobre Hernando Betancourt y el Vivero Paraíso, y los guarda en data/medios.json.
import fs from 'node:fs';

const ARCHIVO = 'data/medios.json';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; VibrasPositivasBot/1.0)', 'Accept-Language': 'es-CO,es;q=0.9' };

// Videos conocidos de su canal: sirven para descubrir el canal y leer su lista pública de videos
const VIDEOS_SEMILLA = ['ZsbNWxE6KzY', '2VtxpbIWAHA', 'mr4yc4p4n0I'];
const BUSQUEDAS_YT = ['Hernando Betancourt vivero paraiso', 'vivero paraiso sembrando vida', 'Hernando Betancourt km 18'];
const BUSQUEDAS_NOTICIAS = ['"Hernando Betancourt" vivero', '"Vivero Paraíso" Hernando Betancourt', '"Hernando Betancourt" árboles'];
// Solo se aceptan resultados que hablen de él o del vivero
const FILTRO = /betancour|vivero para[ií]so|sembrando vida/i;

const ahora = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/Bogota' }).replace(' ', 'T') + '-05:00';
const dec = s => s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\\u0026/g, '&').trim();

async function traer(url) {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
    if (!r.ok) { console.log('⚠️', r.status, url); return ''; }
    return await r.text();
  } catch (e) { console.log('⚠️', e.message, url); return ''; }
}

async function canales() {
  const ids = new Set();
  for (const v of VIDEOS_SEMILLA) {
    const h = await traer(`https://www.youtube.com/watch?v=${v}`);
    const m = h.match(/"(?:externalChannelId|channelId)":"(UC[\w-]{22})"/);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

async function videosDeCanal(id) {
  const x = await traer(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
  return [...x.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: (e.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1],
    titulo: dec((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ''),
    fecha: (e.match(/<published>(.*?)<\/published>/) || [])[1] || '',
    canal: dec((e.match(/<name>(.*?)<\/name>/) || [])[1] || ''),
    origen: 'canal'
  })).filter(v => v.id);
}

async function videosDeBusqueda(q) {
  // sp=CAI%253D ordena por fecha de subida
  const h = await traer(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=CAI%253D`);
  const out = [];
  for (const [, bloque] of h.matchAll(/"videoRenderer":\{([\s\S]{0,4000}?)"navigationEndpoint"/g)) {
    const id = (bloque.match(/"videoId":"([\w-]{11})"/) || [])[1];
    const titulo = dec((bloque.match(/"title":\{"runs":\[\{"text":"(.*?)"\}/) || [])[1] || '');
    if (id && FILTRO.test(titulo)) out.push({ id, titulo, fecha: '', canal: '', origen: 'busqueda' });
  }
  return out;
}

async function noticias(q) {
  const x = await traer(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=es-419&gl=CO&ceid=CO:es-419`);
  return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, i]) => {
    const fuente = dec((i.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '');
    let titulo = dec((i.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    if (fuente && titulo.endsWith(' - ' + fuente)) titulo = titulo.slice(0, -(fuente.length + 3));
    const f = (i.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1];
    return { titulo, enlace: dec((i.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || ''), fuente,
      fecha: f ? new Date(f).toISOString() : '' };
  }).filter(n => n.enlace && FILTRO.test(n.titulo));
}

function mezclar(viejos, nuevos, clave, max) {
  const mapa = new Map(viejos.map(o => [o[clave], o]));
  for (const n of nuevos) {
    const v = mapa.get(n[clave]);
    mapa.set(n[clave], v ? { ...v, ...Object.fromEntries(Object.entries(n).filter(([, x]) => x)) } : { ...n, encontrado: ahora() });
  }
  return [...mapa.values()]
    .sort((a, b) => (b.fecha || b.encontrado || '').localeCompare(a.fecha || a.encontrado || ''))
    .slice(0, max);
}

const previo = fs.existsSync(ARCHIVO) ? JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')) : { videos: [], noticias: [] };

let vids = [];
const chs = await canales();
console.log('Canales encontrados:', chs);
for (const c of chs) vids.push(...await videosDeCanal(c));
for (const q of BUSQUEDAS_YT) vids.push(...await videosDeBusqueda(q));
let nots = [];
for (const q of BUSQUEDAS_NOTICIAS) nots.push(...await noticias(q));
console.log(`YouTube: ${vids.length} · Noticias: ${nots.length}`);

const datos = {
  actualizado: previo.actualizado || ahora(),
  canales: chs.length ? chs : (previo.canales || []),
  videos: mezclar(previo.videos || [], vids, 'id', 40),
  noticias: mezclar(previo.noticias || [], nots, 'enlace', 40)
};

// Solo se guarda (y se hace commit) si apareció algo nuevo
const igual = JSON.stringify({ ...previo, actualizado: 0 }) === JSON.stringify({ ...datos, actualizado: 0 });
if (!igual) {
  datos.actualizado = ahora();
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(ARCHIVO, JSON.stringify(datos, null, 2) + '\n');
  console.log('✅ Novedades guardadas', datos.actualizado);
} else console.log('Sin novedades');
