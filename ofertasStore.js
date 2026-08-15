const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, 'ofertas.json');

function ler() {
  try {
    const raw = fs.readFileSync(ARQUIVO, 'utf8');
    const dados = JSON.parse(raw);
    return Array.isArray(dados) ? dados : [];
  } catch (e) {
    return [];
  }
}

function salvar(lista) {
  try {
    fs.writeFileSync(ARQUIVO, JSON.stringify(lista, null, 2), 'utf8');
  } catch (e) {
    console.error('Falha ao salvar ofertas:', e.message);
  }
}

function listar() {
  return ler();
}

function criar(dados) {
  const lista = ler();
  const oferta = {
    id: `of_${Date.now()}`,
    ativo: true,
    criadoEm: Date.now(),
    ...dados,
  };
  lista.unshift(oferta);
  salvar(lista);
  return oferta;
}

function atualizar(id, dados) {
  const lista = ler();
  const idx = lista.findIndex((o) => o.id === id);
  if (idx === -1) return null;
  lista[idx] = { ...lista[idx], ...dados, id };
  salvar(lista);
  return lista[idx];
}

function remover(id) {
  const lista = ler();
  const nova = lista.filter((o) => o.id !== id);
  if (nova.length === lista.length) return false;
  salvar(nova);
  return true;
}

module.exports = { listar, criar, atualizar, remover };
