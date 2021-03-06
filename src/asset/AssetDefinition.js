var createHash = require('crypto').createHash
var base58 = require('bs58')
var _ = require('lodash')
var cclib = require('coloredcoinjs-lib')

var errors = require('../errors')

/**
 * @typedef {Object} AssetDefinition~Desc
 * @param {string[]} monikers
 * @param {string[]} colorDescs
 * @param {number} [unit=1] Power of 10 and greater than 0
 */

/**
 * @class AssetDefinition
 * @param {cclib.definitions.Manager} cdManager
 * @param {AssetDefinition~Desc} data
 * @throws {VerifyPowerError} If data.unit not power of 10
 */
function AssetDefinition (cdManager, data) {
  if (!data.colorDescs) {
    data.colorDescs = data.colorSchemes // upgrade from old version
  }

  if (data.colorDescs.length !== 1) {
    throw errors.MultiColorNotSupportedError('AssetDefinition.constructor')
  }

  data.unit = data.unit === undefined ? 1 : data.unit
  if (Math.log(data.unit) / Math.LN10 % 1 !== 0) {
    throw new errors.VerifyPowerError('data.unit must be power of 10 and greater than 0')
  }

  var cdescs = _.sortBy(data.colorDescs)
  var cdata = JSON.stringify(cdescs).replace(', ', ',')
  var chash = createHash('sha256').update(cdata).digest().slice(0, 10)
  this._id = base58.encode(chash)

  var zeroCDescs = data.colorDescs.map(function (cdesc) {
    return cdesc.replace(/:\d{1,}$/, ':0')
  })

  this.monikers = data.monikers
  this.colorSet = new cclib.ColorSet(cdManager, zeroCDescs)
  this.unit = data.unit
}

/**
 * @return {AssetDefinition~Desc}
 */
AssetDefinition.prototype.getData = function () {
  return {
    monikers: this.monikers,
    colorDescs: this.colorSet.getColorDescs(),
    unit: this.unit
  }
}

/**
 * @return {string[]}
 */
AssetDefinition.prototype.getMonikers = function () {
  return this.monikers
}

/**
 * @return {cclib.ColorSet}
 */
AssetDefinition.prototype.getColorSet = function () {
  return this.colorSet
}

/**
 * @return {string}
 */
AssetDefinition.prototype.getId = function () {
  return this._id
}

/**
 * @return {Promise.<cclib.ColorDefinition[]>}
 */
AssetDefinition.prototype.getColorDefinitions = function () {
  return this.getColorSet().getColorDefinitions()
}

/**
 * @param {string} portion
 * @return {number}
 */
AssetDefinition.prototype.parseValue = function (portion) {
  var items = portion.split('.')

  var value = parseInt(items[0], 10) * this.unit

  if (!_.isUndefined(items[1])) {
    var centString = items[1] + new Array(this.unit.toString().length).join('0')
    var centValue = parseInt(centString.slice(0, this.unit.toString().length - 1), 10)

    if (!isNaN(centValue)) {
      value = value + (parseFloat(portion) >= 0 ? centValue : -centValue)
    }
  }

  return value
}

/**
 * @param {number} value
 * @return {string}
 */
AssetDefinition.prototype.formatValue = function (value) {
  var coinString = (~~(value / this.unit)).toString()
  if (coinString === '0' && value < 0) {
    coinString = '-' + coinString
  }

  var centString = Math.abs(value % this.unit).toString()
  var centLength = this.unit.toString().length - 1
  while (centString.length < centLength) {
    centString = '0' + centString
  }

  return coinString + '.' + centString
}

module.exports = AssetDefinition
