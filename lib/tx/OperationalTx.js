var util = require('util')

var Q = require('q')

var cclib = require('../cclib')
var errors = require('../errors')
var verify = require('../verify')
var getUncolored = cclib.ColorDefinitionManager.getUncolored
var ComposedTx = require('./ComposedTx')

/**
 * @class OperationalTx
 * @extends external:coloredcoinjs-lib.OperationalTx
 *
 * @param {Wallet} wallet
 */
function OperationalTx(wallet) {
  verify.Wallet(wallet)

  cclib.OperationalTx.call(this)

  this.wallet = wallet
  this.targets = []
}

util.inherits(OperationalTx, cclib.OperationalTx)

/**
 * Add ColorTarget to current tx
 *
 * @param {external:coloredcoinjs-lib.ColorTarget} target
 */
OperationalTx.prototype.addTarget = function (target) {
  verify.ColorTarget(target)
  this.targets.push(target)
}

/**
 * Vectorized version of addTarget
 *
 * @param {external:coloredcoinjs-lib.ColorTarget[]} targets
 */
OperationalTx.prototype.addTargets = function (targets) {
  targets.forEach(this.addTarget.bind(this))
}

/**
 * Return ColorTargets of current transaction
 *
 * @return {external:coloredcoinjs-lib.ColorTarget[]}
 */
OperationalTx.prototype.getTargets = function () {
  return this.targets
}

/**
 * Return true if transaction represent 1 color
 *
 * @return {boolean}
 * @throws {ZeroArrayLengthError}
 */
OperationalTx.prototype.isMonoColor = function () {
  if (this.targets.length === 0) {
    throw new errors.ZeroArrayLengthError('ColorTargets')
  }

  var colorId = this.targets[0].getColorId()
  var isMonoColor = this.targets.every(function (target) { return target.getColorId() === colorId })

  return isMonoColor
}

/**
 * @param {number} txSize
 * @return {external:coloredcoinjs-lib.ColorValue}
 */
OperationalTx.prototype.getRequiredFee = function (txSize) {
  verify.number(txSize)

  var feePerKb = this.wallet.getBitcoinNetwork().feePerKb
  var feeValue = Math.ceil(feePerKb * txSize / 1000)

  return new cclib.ColorValue(getUncolored(), feeValue)
}

/**
 * @return {external:coloredcoinjs-lib.ColorValue}
 */
OperationalTx.prototype.getDustThreshold = function () {
  var dustValue = this.wallet.getBitcoinNetwork().dustThreshold
  return new cclib.ColorValue(getUncolored(), dustValue)
}


OperationalTx.prototype._getCoinsForColor = function (colordef) {
  var coinQuery = this.wallet.getCoinQuery()
  coinQuery = coinQuery.onlyColoredAs(colordef)
  coinQuery = coinQuery.onlyAddresses(this.wallet.getAllAddresses(colordef))
  if (this.wallet.canSpendUnconfirmedCoins()) {
    coinQuery = coinQuery.includeUnconfirmed()
  }
  return Q.ninvoke(coinQuery, 'getCoins')
}

/**
 * @callback OperationalTx~selectCoinsCallback
 * @param {?Error}
 * @param {Coin[]} utxo
 * @param {external:coloredcoinjs-lib.ColorValue} utxoColorValue
 */

/**
 * @param {external:coloredcoinjs-lib.ColorValue} colorValue
 * @param {?Object} feeEstimator
 * @param {OperationalTx~selectCoinsCallback} cb
 */
OperationalTx.prototype.selectCoins = function (colorValue, feeEstimator, cb) {
  verify.ColorValue(colorValue)
  if (feeEstimator !== null) { verify.object(feeEstimator) }
  verify.function(cb)

  var self = this

  var colordef
  Q.fcall(function () {
    colordef = colorValue.getColorDefinition()

    if (!colorValue.isUncolored() && feeEstimator !== null) {
      throw new errors.ColoredFeeEstimatorError()
    }

    return self._getCoinsForColor(colordef)

  }).then(function (coinList) {
    var coins = coinList.getCoins()

    var selectedCoinsColorValue = new cclib.ColorValue(colordef, 0)
    var selectedCoins = []

    var requiredSum = colorValue.clone()
    if (feeEstimator !== null) {
      requiredSum = requiredSum.plus(feeEstimator.estimateRequiredFee({txIns: coins.length}))
    }

    /** @todo Better coins selection algorithm */
    var promise = Q.resolve()
    coins.forEach(function (coin) {
      promise = promise.then(function () {
        if (selectedCoinsColorValue.getValue() >= requiredSum.getValue()) {
          return
        }

        return Q.ninvoke(coin, 'getMainColorValue').then(function (coinColorValue) {
          selectedCoinsColorValue = selectedCoinsColorValue.plus(coinColorValue)
          selectedCoins.push(coin)
        })
      })
    })

    return promise.then(function () {
      if (selectedCoinsColorValue.getValue() >= requiredSum.getValue()) {
        return {coins: selectedCoins, value: selectedCoinsColorValue}
      }

      var required = requiredSum.getValue()
      var selected = selectedCoinsColorValue.getValue()
      throw new errors.InsufficientFundsError(required + ' requested, ' + selected + ' found')
    })

  }).done(function (data) { cb(null, data.coins, data.value) }, function (error) { cb(error) })
}

/**
 * @param {external:coloredcoinjs-lib.ColorDefinition} colordef
 * @return {string}
 */
OperationalTx.prototype.getChangeAddress = function (colordef) {
  verify.ColorDefinition(colordef)

  return this.wallet.getSomeAddress(colordef)
}

OperationalTx.prototype.makeComposedTx = function () {
  return new ComposedTx(this)
}


module.exports = OperationalTx
