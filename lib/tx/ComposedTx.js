var util = require('util')

var Q = require('q')

var cclib = require('../cclib')
var errors = require('../errors')
var verify = require('../verify')
var _ = require('lodash')
var varIntSize = require('../bitcoin').bufferutils.varIntSize

function ComposedTx (operationalTx) {
  cclib.ComposedTx.call(this, operationalTx)
  this.defaultExtraTxOuts = 1
}

util.inherits(ComposedTx, cclib.ComposedTx)

/**
 * Estimate transaction size
 *
 * @param {Object} extra
 * @param {number} [extra.txIns=0]
 * @param {number} [extra.txOuts=0]
 * @param {number} [extra.bytes=0]
 */
ComposedTx.prototype.estimateSize = function (extra) {
  extra = _.extend({
    txIns:  0,
    txOuts: this.defaultExtraTxOuts,
    bytes:  0
  }, extra)

  verify.object(extra)
  verify.number(extra.txIns)
  verify.number(extra.txOuts)
  verify.number(extra.bytes)

  var P2PKHScriptSigSize = 107
  var MultiScriptSigSize = 254 // something like P2SH 2-of-3
  var InputSize = 40
  
  var txInSize = 0
  
  this.txIns.forEach(function (txIn) {
    if (txIn.script.length === (25 * 2)) {
      console.log("Normal input")
      txInSize += InputSize + varIntSize(P2PKHScriptSigSize) + P2PKHScriptSigSize
    } else {
      console.log("Multi-sig input")
      txInSize += InputSize + varIntSize(MultiScriptSigSize) + MultiScriptSigSize
    }
  })

  txInSize += (InputSize + varIntSize(MultiScriptSigSize) + MultiScriptSigSize) * extra.txIns

  // 40 -- txId, outIndex, sequence
  // 107 -- P2PKH scriptSig length (the most common redeem script)
  //var txInSize = (40 + varIntSize(107) + 107) * (this.txIns.length + extra.txIns)

  // 8 -- output value
  // 25 -- P2PKH length (the most common)
  var txOutSize = this.txOuts.reduce(function (a, x) {
    return a + (8 + varIntSize(x.script.length / 2) + x.script.length / 2)

  }, (8 + varIntSize(25) + 25) * extra.txOuts)

  var txSize = (
    8 +
    extra.bytes +
    varIntSize(this.txIns.length + extra.txIns) +
    varIntSize(this.txOuts.length + extra.txOuts) +
    txInSize +
    txOutSize
  )
  console.log('Total est. size:', txSize, " txIns: ", txInSize,
	      "txOut: ", txOutSize, "extra", extra)
  
  return txSize
}

module.exports = ComposedTx
