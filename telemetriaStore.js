const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, 'telemetria.json');

function ler() {
  try {
    const raw = fs.readFileSync(ARQUIVO, 'utf8');
    const dados = JSON.parse(raw);
    return dados && typeof dados === 'object' ? dados : {};
  } catch (e) {
    return {};
  }
}

function salvar(dados) {
  try {
    fs.writeFileSync(ARQUIVO, JSON.stringify(dados, null, 2), 'utf8');
  } catch (e) {
    console.error('Falha ao salvar telemetria:', e.message);
  }
}

const PLANOS_VALIDOS = ['tester', 'freemium', 'premium', 'basico'];
function normalizarPlano(p) {
  const v = String(p || '').toLowerCase().trim();
  return PLANOS_VALIDOS.includes(v) ? v : '';
}

// --- Uso de seções (evento avulso com plano, dispositivo e data) ---
function registrarSecao(secao, plano, dispositivoId) {
  const dados = ler();
  const eventos = dados.eventosSecao || [];
  eventos.push({
    ts: Date.now(),
    plano: normalizarPlano(plano),
    secao: String(secao || '').trim().slice(0, 60),
    dispositivoId: String(dispositivoId || '').trim().slice(0, 120),
  });
  salvar({ ...dados, eventosSecao: eventos });
}

// --- Perfil de aquários (evento avulso com plano, dispositivo e data) ---
function registrarPerfilAquario(aquario, plano, dispositivoId) {
  const dados = ler();
  const eventos = dados.eventosAquario || [];
  eventos.push({
    ts: Date.now(),
    plano: normalizarPlano(plano),
    aquario: aquario || {},
    dispositivoId: String(dispositivoId || '').trim().slice(0, 120),
  });
  salvar({ ...dados, eventosAquario: eventos });
}

function noPeriodo(ts, de, ate) {
  if (de && ts < de) return false;
  if (ate && ts > ate) return false;
  return true;
}

// --- Resumo filtrado por plano e período ---
function resumo({ plano = '', de = null, ate = null } = {}) {
  const dados = ler();
  const filtroPlano = normalizarPlano(plano);

  // Uso das seções
  const secoes = {};
  for (const ev of dados.eventosSecao || []) {
    if (filtroPlano && ev.plano !== filtroPlano) continue;
    if (!noPeriodo(ev.ts, de, ate)) continue;
    const s = secoes[ev.secao] || { total: 0 };
    s.total += 1;
    secoes[ev.secao] = s;
  }
  const listaSecoes = Object.entries(secoes)
    .map(([nome, s]) => ({ secao: nome, total: s.total }))
    .sort((a, b) => b.total - a.total);

  // Perfil dos aquários
  const perfil = { total: 0, plantados: 0, naoPlantados: 0, comFauna: 0, comFlora: 0, porTipo: {}, porFaixaLitros: {} };
  for (const ev of dados.eventosAquario || []) {
    if (filtroPlano && ev.plano !== filtroPlano) continue;
    if (!noPeriodo(ev.ts, de, ate)) continue;
    const a = ev.aquario || {};
    const tipo = String(a.tipo || 'Não informado').trim() || 'Não informado';
    const litros = parseFloat(a.litros);
    const faixa = !litros || isNaN(litros)
      ? 'Não informado'
      : litros < 50 ? 'Até 50 L' : litros < 150 ? '50-150 L' : litros < 300 ? '150-300 L' : 'Mais de 300 L';
    perfil.porTipo[tipo] = (perfil.porTipo[tipo] || 0) + 1;
    perfil.porFaixaLitros[faixa] = (perfil.porFaixaLitros[faixa] || 0) + 1;
    perfil.plantados += a.ehPlantado === 'Sim' ? 1 : 0;
    perfil.naoPlantados += a.ehPlantado === 'Não' ? 1 : 0;
    perfil.comFauna += a.composicao && a.composicao.fauna && a.composicao.fauna.length > 0 ? 1 : 0;
    perfil.comFlora += a.composicao && a.composicao.flora && a.composicao.flora.length > 0 ? 1 : 0;
    perfil.total += 1;
  }

  // Dispositivos únicos
  const dispositivosSecao = new Set();
  const dispositivosAquario = new Set();
  for (const ev of dados.eventosSecao || []) {
    if (filtroPlano && ev.plano !== filtroPlano) continue;
    if (!noPeriodo(ev.ts, de, ate)) continue;
    if (ev.dispositivoId) dispositivosSecao.add(ev.dispositivoId);
  }
  for (const ev of dados.eventosAquario || []) {
    if (filtroPlano && ev.plano !== filtroPlano) continue;
    if (!noPeriodo(ev.ts, de, ate)) continue;
    if (ev.dispositivoId) dispositivosAquario.add(ev.dispositivoId);
  }
  const todosDispositivos = new Set([...dispositivosSecao, ...dispositivosAquario]);

  return { secoes: listaSecoes, perfilAquarios: perfil, dispositivosAtivos: todosDispositivos.size };
}

module.exports = {
  registrarSecao,
  registrarPerfilAquario,
  resumo,
};
