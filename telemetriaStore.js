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

// --- Uso de seções ---
function registrarSecao(secao) {
  const dados = ler();
  const hoje = new Date().toISOString().slice(0, 10);
  const secoes = dados.secoes || {};
  const s = secoes[secao] || { total: 0, porDia: {} };
  s.total += 1;
  s.porDia[hoje] = (s.porDia[hoje] || 0) + 1;
  secoes[secao] = s;
  salvar({ ...dados, secoes });
}

// --- Perfil de aquários ---
function registrarPerfilAquario(aquario) {
  const dados = ler();
  const perfil = dados.perfilAquarios || {};
  const a = aquario || {};

  const tipo = String(a.tipo || 'Não informado').trim() || 'Não informado';
  const litros = parseFloat(a.litros);
  const faixa = !litros || isNaN(litros)
    ? 'Não informado'
    : litros < 50 ? 'Até 50 L' : litros < 150 ? '50-150 L' : litros < 300 ? '150-300 L' : 'Mais de 300 L';

  perfil.porTipo = incrementar(perfil.porTipo, tipo);
  perfil.porFaixaLitros = incrementar(perfil.porFaixaLitros, faixa);
  perfil.plantados = (perfil.plantados || 0) + (a.ehPlantado === 'Sim' ? 1 : 0);
  perfil.naoPlantados = (perfil.naoPlantados || 0) + (a.ehPlantado === 'Não' ? 1 : 0);
  perfil.comFauna = (perfil.comFauna || 0) + ((a.composicao && a.composicao.fauna && a.composicao.fauna.length > 0) ? 1 : 0);
  perfil.comFlora = (perfil.comFlora || 0) + ((a.composicao && a.composicao.flora && a.composicao.flora.length > 0) ? 1 : 0);
  perfil.total = (perfil.total || 0) + 1;

  salvar({ ...dados, perfilAquarios: perfil });
}

function incrementar(obj, chave) {
  const o = obj || {};
  o[chave] = (o[chave] || 0) + 1;
  return o;
}

// --- Resumo ---
function resumo() {
  const dados = ler();
  const secoes = dados.secoes || {};
  const listaSecoes = Object.entries(secoes)
    .map(([nome, s]) => ({ secao: nome, total: s.total || 0, porDia: s.porDia || {} }))
    .sort((a, b) => b.total - a.total);
  return {
    secoes: listaSecoes,
    perfilAquarios: dados.perfilAquarios || {},
  };
}

module.exports = {
  registrarSecao,
  registrarPerfilAquario,
  resumo,
};
