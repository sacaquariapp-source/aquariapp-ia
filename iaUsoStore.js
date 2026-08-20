const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, 'iaUso.json');

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
    console.error('Falha ao salvar iaUso.json:', e.message);
  }
}

const PLANOS = ['tester', 'freemium', 'premium', 'basico'];
function norm(p) {
  const v = String(p || '').toLowerCase().trim();
  return PLANOS.includes(v) ? v : '';
}

// Registra um consumo de IA (uma consulta ou um lote), com plano e data.
function registrar({ dispositivoId, plano, qtd, custo }) {
  const dados = ler();
  const eventos = dados.eventos || [];
  eventos.push({
    ts: Date.now(),
    dispositivoId: String(dispositivoId || ''),
    plano: norm(plano),
    qtd: Number(qtd) || 0,
    custo: Number(custo) || 0,
  });
  salvar({ ...dados, eventos });
}

function noPeriodo(ts, de, ate) {
  if (de && ts < de) return false;
  if (ate && ts > ate) return false;
  return true;
}

// Resumo do uso de IA, filtrado por plano e período (de/ate em ms).
function resumo({ plano = '', de = null, ate = null } = {}) {
  const dados = ler();
  const fp = norm(plano);
  const porPlano = {};
  for (const p of PLANOS) porPlano[p] = { consultas: 0, custo: 0 };
  let totalConsultas = 0;
  let totalCusto = 0;
  const dispositivos = new Set();
  const registros = [];
  for (const ev of dados.eventos || []) {
    if (fp && ev.plano !== fp) continue;
    if (!noPeriodo(ev.ts, de, ate)) continue;
    const q = ev.qtd || 0;
    const c = ev.custo || 0;
    const pp = porPlano[ev.plano] || { consultas: 0, custo: 0 };
    pp.consultas += q;
    pp.custo += c;
    totalConsultas += q;
    totalCusto += c;
    if (ev.dispositivoId) dispositivos.add(ev.dispositivoId);
    registros.push(ev);
  }
  registros.sort((a, b) => b.ts - a.ts);
  return {
    total: { consultas: totalConsultas, custo: totalCusto, dispositivos: dispositivos.size },
    porPlano,
    registros: registros.slice(0, 50),
  };
}

module.exports = { registrar, resumo };
