'use strict';
// Monta catálogos fora da thread principal: o recebimento de ticks da Deriv nunca espera por este cálculo.
const { parentPort } = require('worker_threads');
const { buildCatalog } = require('./catalog');
parentPort.on('message', ({ id, candles, opts }) => {
  try { parentPort.postMessage({ id, cat: buildCatalog(candles, opts) }); }
  catch (e) { parentPort.postMessage({ id, error: e.message }); }
});
