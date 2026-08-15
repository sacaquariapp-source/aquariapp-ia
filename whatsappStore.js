const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, 'whatsapp-membros.json');

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
    console.error('Falha ao salvar membros do WhatsApp:', e.message);
  }
}

function listar() {
  return ler();
}

function buscar(telefone) {
  return ler().find((m) => m.telefone === telefone) || null;
}

function upsert(dados) {
  const lista = ler();
  const idx = lista.findIndex((m) => m.telefone === dados.telefone);
  if (idx === -1) {
    const membro = { criadoEm: Date.now(), ...dados };
    lista.push(membro);
    salvar(lista);
    return membro;
  }
  lista[idx] = { ...lista[idx], ...dados, criadoEm: lista[idx].criadoEm };
  salvar(lista);
  return lista[idx];
}

function remover(telefone) {
  const lista = ler();
  const nova = lista.filter((m) => m.telefone !== telefone);
  if (nova.length === lista.length) return false;
  salvar(nova);
  return true;
}

module.exports = { listar, buscar, upsert, remover };
