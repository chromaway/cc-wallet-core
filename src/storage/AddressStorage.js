var assert = require('assert')
var inherits = require('util').inherits

var _ = require('lodash')
var bitcoin = require('bitcoinjs-lib')
var HDNode = bitcoin.HDNode

var SyncStorage = require('./SyncStorage')


function isHexString(s) {
  var set = ['0','1','2','3','4','5','6','7','8','9','a','b','c','d','e','f']

  return (_.isString(s) &&
          s.length % 2 === 0 &&
          s.toLowerCase().split('').every(function(x) { return set.indexOf(x) !== -1 }))
}

/**
 * @class AddressStorage
 *
 * Inherits SyncStorage
 */
function AddressStorage() {
  SyncStorage.apply(this, Array.prototype.slice.call(arguments))

  this.masterKeyDBKey = this.globalPrefix + 'masterKey'
  this.pubKeysDBKey = this.globalPrefix + 'pubKeys'

  if (!_.isString(this.store.get(this.masterKeyDBKey))) {
    this.store.remove(this.masterKeyDBKey)
    this.store.set(this.pubKeysDBKey, [])
  }

  if (!_.isArray(this.store.get(this.pubKeysDBKey)))
    this.store.set(this.pubKeysDBKey, [])
}

inherits(AddressStorage, SyncStorage)

/**
 * Save masterKey in base58 format
 *
 * @param {string} masterKey
 */
AddressStorage.prototype.setMasterKey = function(newMasterKey) {
  HDNode.fromBase58(newMasterKey) // Check masterKey

  this.store.set(this.masterKeyDBKey, newMasterKey)
  this.store.set(this.pubKeysDBKey, [])
}

/**
 * Get masterKey from store in base58
 *
 * @return {srting|undefined}
 */
AddressStorage.prototype.getMasterKey = function() {
  return this.store.get(this.masterKeyDBKey)
}

/*
 * Add pubKey for account, chain and index to store
 *
 * @param {Object} data
 * @param {number} data.account
 * @param {number} data.chain
 * @param {number} data.index
 * @param {string} data.pubKey bitcoinjs-lib.ECPubKey in hex format
 */
AddressStorage.prototype.addPubKey = function(data) {
  assert(_.isObject(data), 'Expected Object data, got ' + data)
  assert(_.isNumber(data.account), 'Expected number data.account, got ' + data.account)
  assert(_.isNumber(data.chain), 'Expected number data.chain, got ' + data.chain)
  assert(_.isNumber(data.index), 'Expected number data.index, got ' + data.index)
  assert(isHexString(data.pubKey), 'Expected hex string data.pubKey, got ' + data.pubKey)

  var pubKeys = this.store.get(this.pubKeysDBKey) || []

  pubKeys.forEach(function(record) {
    if ((record.account === data.account && record.chain === data.chain && record.index === data.index) ||
        record.pubKey === data.pubKey)
      throw new Error('UniqueConstraint')
  })

  pubKeys.push({
    account: data.account,
    chain: data.chain,
    index: data.index,
    pubKey: data.pubKey
  })

  this.store.set(this.pubKeysDBKey, pubKeys)
}

/**
 * Get all pubKeys for account and chain
 *
 * @param {Object} data
 * @param {number} [data.account]
 * @param {number} [data.chain]
 * @return {Array}
 */
AddressStorage.prototype.getAllPubKeys = function(data) {
  data = _.isUndefined(data) ? {} : data
  //assert(_.isObject(data), 'Expected Object data, got ' + data)
  //assert(_.isNumber(data.account), 'Expected number data.account, got ' + data.account)
  //assert(_.isNumber(data.chain), 'Expected number data.chain, got ' + data.chain)

  function isGoodRecord(record) {
    if (!_.isUndefined(data.account) && !_.isUndefined(data.chain))
      return (record.account === data.account && record.chain === data.chain)

    if (!_.isUndefined(data.account))
      return (record.account === data.account)

    if (!_.isUndefined(data.chain))
      return (record.chain === data.chain)

    return true
  }

  var pubKeys = this.store.get(this.pubKeysDBKey) || []
  return pubKeys.filter(isGoodRecord)
}

/**
 * Get max index for account and chain
 *
 * @param {Object} data
 * @param {number} data.account
 * @param {number} data.chain
 * @return {number|undefined}
 */
AddressStorage.prototype.getMaxIndex = function(data) {
  assert(_.isObject(data), 'Expected Object data, got ' + data)
  assert(_.isNumber(data.account), 'Expected number data.account, got ' + data.account)
  assert(_.isNumber(data.chain), 'Expected number data.chain, got ' + data.chain)

  var maxIndex

  var pubKeys = this.store.get(this.pubKeysDBKey) || []
  pubKeys.forEach(function(record) {
    if (record.account === data.account && record.chain === data.chain &&
       (record.index > maxIndex || _.isUndefined(maxIndex)))
      maxIndex = record.index
  })

  return maxIndex
}

/**
 * Remove masterKey and all pubKeys
 */
AddressStorage.prototype.clear = function() {
  this.store.remove(this.masterKeyDBKey)
  this.store.remove(this.pubKeysDBKey)
}


module.exports = AddressStorage
