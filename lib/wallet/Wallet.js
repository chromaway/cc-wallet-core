var events = require('events')
var inherits = require('util').inherits
var timers = require('timers')

var _ = require('lodash')
var Q = require('q')
var blockchainjs = require('blockchainjs')

var address = require('../address')
var asset = require('../asset')
var coin = require('../coin')
var ConfigStorage = require('../ConfigStorage')
var tx = require('../tx')
var WalletEventNotifier = require('./WalletEventNotifier')
var WalletStateStorage = require('./WalletStateStorage')
var WalletStateManager = require('./WalletStateManager')

var cclib = require('../cclib')
var bitcoin = require('../bitcoin')
var errors = require('../errors')
var util = require('../util')
var verify = require('../verify')


/**
 * @event Wallet#error
 * @param {Error} error
 */

/**
 * @event Wallet#newHeight
 * @param {number} height
 */

/**
 * @event Wallet#addTx
 * @param {Transaction} tx
 */

/**
 * @event Wallet#updateTx
 * @param {string} tx
 */

/**
 * @event Wallet#revertTx
 * @param {Transaction} tx
 */

/**
 * @event Wallet#newAddress
 * @param {Address} address
 */

/**
 * @event Wallet#touchAddress
 * @param {string} address
 */

/**
 * @event Wallet#newAsset
 * @param {AssetDefinition} assetdef
 */

/**
 * @event Wallet#newColor
 * @param {string} desc
 */

/**
 * @event Wallet#touchAsset
 * @param {AssetDefinition} assetdef
 */

/**
 * @event Wallet#historyUpdate
 */

/**
 * @event Wallet#syncStart
 */

/**
 * @event Wallet#syncStop
 */

/**
 * @event Wallet#initialize
 */

/**
 * @callback Wallet~errorCallback
 * @param {?Error} error
 */

/**
 * @class Wallet
 * @extends events.EventEmitter
 * @mixes SyncMixin
 *
 * @param {Object} opts
 * @param {boolean} [opts.testnet=false]
 * @param {Object} [opts.connector]
 * @param {string} [opts.connector.name='Chromanode']
 * @param {Object} [opts.connector.opts]
 * @param {boolean} [opts.connector.autoConnect=true]
 * @param {Object} [opts.blockchain]
 * @param {string} [opts.blockchain.name='Verified']
 * @param {Object} [opts.blockchain.opts]
 * @param {Object} [opts.blockchain.storage]
 * @param {string} [opts.blockchain.storage.name]
 * @param {Object} [opts.blockchain.storage.opts]
 * @param {boolean} [opts.spendUnconfirmedCoins=false] Allow spend unconfirmed coins
 * @param {Object[]} [opts.systemAssetDefinitions]
 */
function Wallet(opts) {
  opts = _.merge({testnet: false}, opts)
  opts.networkName = opts.testnet ? 'testnet' : 'livenet'
  opts = _.merge({
    connector: {
      name: 'Chromanode',
      opts: {networkName: opts.networkName},
      autoConnect: true
    },
    blockchain: {
      name: 'Verified',
      opts: {
        networkName: opts.networkName,
        testnet: opts.testnet,
        compactMode: true,
        chunkHashes: blockchainjs.chunkHashes[opts.networkName]
      },
      storage: {
        name: 'LocalStorage',
        opts: {
          networkName: opts.networkName,
          compactMode: true,
          keyName: 'ccwallet_blockchain_'
        }
      }
    },
    spendUnconfirmedCoins: false
  }, opts)
  var storeOpts = opts.store ? { store: opts.store } : {}

  // add verify checks

  var self = this
  events.EventEmitter.call(self)
  util.SyncMixin.call(self)
  
  self._opts = opts

  self._allAddressesCache = undefined
  self.on('newAddress', function () { self._allAddressesCache = undefined })

  var networkParameterDefaults = opts.testnet ? bitcoin.networks.testnet : bitcoin.networks.bitcoin
  self.bitcoinNetwork = _.merge( opts.networkParameters || {},
				 _.cloneDeep(networkParameterDefaults) )
  self._spendUnconfirmedCoins = opts.spendUnconfirmedCoins

  self.config = new ConfigStorage(storeOpts)

  var ConnectorCls = blockchainjs.connector[opts.connector.name]
  self.connector = new ConnectorCls(opts.connector.opts)

  var StorageCls = blockchainjs.storage[opts.blockchain.storage.name]
  self.blockchainStorage = new StorageCls(opts.blockchain.storage.opts)
  var BlockchainCls = blockchainjs.blockchain[opts.blockchain.name]
  var blockchainOpts = _.merge({storage: self.blockchainStorage}, opts.blockchain.opts)
  self.blockchain = new BlockchainCls(self.connector, blockchainOpts)

  self.cdStorage = new cclib.ColorDefinitionStorage(storeOpts)
  self.cdManager = new cclib.ColorDefinitionManager(self.cdStorage)

  self.cDataStorage = new cclib.ColorDataStorage(storeOpts)
  self.cData = new cclib.ColorData(self.cDataStorage)

  self.aStorage = new address.AddressStorage(storeOpts)
  self.aManager = new address.AddressManager(self.aStorage, self.bitcoinNetwork)

  self.adStorage = new asset.AssetDefinitionStorage(storeOpts)
  self.adManager = new asset.AssetDefinitionManager(self.cdManager, self.adStorage)
  if (opts.systemAssetDefinitions) {
    opts.systemAssetDefinitions.forEach(function (sad) {
      self.adManager.resolveAssetDefinition(sad)
    })
  }

  self.walletEventNotifier = new WalletEventNotifier(self)
  self.walletStateStorage = new WalletStateStorage(storeOpts)
  self.walletStateManager = new WalletStateManager(self, self.walletStateStorage)

  function forwardSyncAndErrors(obj) {
    obj.on('error', function (error) {
      console.log('Wallet Error! ')
      self.emit('error', error)
    })
    obj.on('syncStart', function () { self._syncEnter() })
    obj.on('syncStop', function () { self._syncExit() })
  }

  // events
  self.connector.on('error', function (error) { self.emit('error', error) })

  self.blockchain.on('newHeight', function (height) { self.emit('newHeight', height) })

  self.aManager.on('newAddress', function (address) { self.emit('newAddress', address) })
  self.adManager.on('newAsset', function (assetdef) { self.emit('newAsset', assetdef) })

  forwardSyncAndErrors(self.blockchain)
  forwardSyncAndErrors(self.walletEventNotifier)

  forwardSyncAndErrors(self.walletStateManager)
  self.walletStateManager.on('addTx', function (tx) { self.emit('addTx', tx) })
  self.walletStateManager.on('updateTx', function (tx) { self.emit('updateTx', tx) })
  self.walletStateManager.on('revertTx', function (tx) { self.emit('revertTx', tx) })
  self.walletStateManager.on('touchAddress', function (address) { self.emit('touchAddress', address) })
  self.walletStateManager.on('newColor', function (desc) { self.emit('newColor', desc) })
  self.walletStateManager.on('touchAsset', function (assetdef) { self.emit('touchAsset', assetdef) })
  self.walletStateManager.on('historyUpdate', function () { self.emit('historyUpdate') })

  if (opts.connector.autoConnect) { 
    timers.setImmediate(function () { self.connect() })
  }
}

inherits(Wallet, events.EventEmitter)

Wallet.prototype.getBitcoinNetwork = function () { return this.bitcoinNetwork }
Wallet.prototype.canSpendUnconfirmedCoins = function () { return this._spendUnconfirmedCoins }
Wallet.prototype.getConnector = function () { return this.connector }
Wallet.prototype.getBlockchain = function () { return this.blockchain }
Wallet.prototype.getColorDefinitionManager = function () { return this.cdManager }
Wallet.prototype.getColorData = function () { return this.cData }
Wallet.prototype.getAddressManager = function () { return this.aManager }
Wallet.prototype.getAssetDefinitionManager = function () { return this.adManager }
Wallet.prototype.getCoinQuery = function () { return new coin.CoinQuery(this) }
Wallet.prototype.getStateManager = function () { return this.walletStateManager }
Wallet.prototype.getNetworkName = function () { return this._opts.networkName }
Wallet.prototype.isTestnet = function () { return this._opts.testnet }

/**
 * @return {boolean}
 */
Wallet.prototype.isInitialized = function () {
  return this.config.get('initialized') || false
}

/**
 * @throws {Error} If not initialized
 */
Wallet.prototype.isInitializedCheck = function () {
  if (!this.isInitialized()) {
    throw new errors.WalletNotInitializedError()
  }
}

/**
 * @param {string} seedHex
 * @throws {Error} If already initialized
 */
Wallet.prototype.initialize = function (seedHex) {
  verify.hexString(seedHex)

  if (this.isInitialized()) {
    throw new errors.WalletAlreadyInitializedError()
  }

  var addressManager = this.getAddressManager()
  this.getAssetDefinitionManager().getAllAssets().forEach(function (assetdef) {
    if (addressManager.getAllAddresses(assetdef).length === 0) {
      addressManager.getNewAddress(assetdef, seedHex)
    }
  })

  this.config.set('initialized', true)
  this.emit('initialize')
}

/**
 * @param {string} seedHex
 * @throws {Error} If not initialized
 */
Wallet.prototype.isCurrentSeed = function (seedHex) {
  this.isInitializedCheck()
  return this.getAddressManager().isCurrentSeed(seedHex)
}


/**
 * @param {string} seedHex
 * @param {Object} data
 * @param {string[]} data.monikers
 * @param {string[]} data.colorDescs
 * @param {number} [data.unit=1]
 * @return {AssetDefinition}
 * @throws {Error} If asset already exists or not currently seedHex
 */
Wallet.prototype.addAssetDefinition = function (seedHex, data) {
  this.isInitializedCheck()
  this.getAddressManager().isCurrentSeedCheck(seedHex)

  var assetdef = this.getAssetDefinitionManager().resolveAssetDefinition(data)
  if (this.getSomeAddress(assetdef) === null) {
    this.getNewAddress(seedHex, assetdef)
  }

  return assetdef
}

/**
 * @param {string} moniker
 * @return {?AssetDefinition}
 * @throws {Error} If not initialized
 */
Wallet.prototype.getAssetDefinitionByMoniker = function (moniker) {
  this.isInitializedCheck()
  return this.getAssetDefinitionManager().getByMoniker(moniker)
}

/**
 * @return {AssetDefinition[]}
 * @throws {Error} If not initialized
 */
Wallet.prototype.getAllAssetDefinitions = function () {
  this.isInitializedCheck()
  return this.getAssetDefinitionManager().getAllAssets()
}

/**
 * Param asColorAddress in address method not good solution
 * But sometimes we need bitcoin address for ColorDefintion,
 *  such as in OperationalTx.getChangeAddress
 */

/**
 * Create new address for given asset
 *
 * @param {string} seedHex
 * @param {AssetDefinition} assetdef
 * @param {boolean} [asColorAddress=false]
 * @return {string}
 * @throws {Error} If wallet not initialized or not currently seedHex
 */
Wallet.prototype.getNewAddress = function (seedHex, assetdef, asColorAddress) {
  this.isInitializedCheck()

  var address = this.getAddressManager().getNewAddress(assetdef, seedHex)

  if (asColorAddress) {
    return address.getColorAddress()
  }

  return address.getAddress()
}

/**
 * Return all addresses for given asset
 *
 * @param {(AssetDefinition|ColorDefinition)} [assetdef]
 * @param {boolean} [asColorAddress=false]
 * @return {string[]}
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.getAllAddresses = function (assetdef, asColorAddress) {
  var self = this
  self.isInitializedCheck()

  if (_.isUndefined(self._allAddressesCache)) {
    self._allAddressesCache = {colored: {}, uncolored: {}}
    self.getAllAssetDefinitions().forEach(function (assetdef) {
      var addresses = self.getAddressManager().getAllAddresses(assetdef)
      self._allAddressesCache.colored[assetdef.getId()] = addresses.map(function (o) { return o.getColorAddress() })
      self._allAddressesCache.uncolored[assetdef.getId()] = addresses.map(function (o) { return o.getAddress() })
    })
  }

  var addresses = self._allAddressesCache
  if (!_.isUndefined(assetdef)) {
    if (assetdef instanceof cclib.ColorDefinition) {
      assetdef = self.getAssetDefinitionManager().getByDesc(assetdef.getDesc())
    }

    verify.AssetDefinition(assetdef)
    addresses = {
      colored: [addresses.colored[assetdef.getId()] || []],
      uncolored: [addresses.uncolored[assetdef.getId()] || []]
    }
  }

  if (_.isUndefined(asColorAddress)) { asColorAddress = false }
  verify.boolean(asColorAddress)

  return _.chain(asColorAddress ? addresses.colored : addresses.uncolored)
    .values()
    .flatten()
    .uniq()
    .value()
}

/**
 * Return first address for given asset or throw Error
 *
 * @param {AssetDefinition} assetdef
 * @param {boolean} [asColorAddress=false]
 * @return {?string}
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.getSomeAddress = function (assetdef, asColorAddress) {
  this.isInitializedCheck()

  var addresses = this.getAllAddresses(assetdef, asColorAddress)
  if (addresses.length > 0) {
    return addresses[0]
  }

  return null
}

/**
 * {@link Address.getBitcoinAddress}
 */
Wallet.prototype.getBitcoinAddress = function (assetdef, colorAddress) {
  return address.Address.getBitcoinAddress(assetdef, colorAddress)
}

/**
 * {@link Address.checkAddress}
 */
Wallet.prototype.checkAddress = function (assetdef, checkedAddress) {
  return address.Address.checkColorAddress(assetdef, checkedAddress)
}

/**
 * @deprecated TxFetcher itself tracks and subscribe addresses
 *
 * @param {string} address
 * @param {Wallet~errorCallback} cb
 */
Wallet.prototype.subscribeAndSyncAddress = function (address, cb) {
  console.warn('subscribeAndSyncAddress is deprecated for removal in 1.0.0')
  timers.setImmediate(cb, null)
}

/**
 * @deprecated TxFetcher itself tracks and subscribe addresses
 *
 * @param {Wallet~errorCallback} cb
 */
Wallet.prototype.subscribeAndSyncAllAddresses = function (cb) {
  console.warn('subscribeAndSyncAllAddresses is deprecated for removal in 1.0.0')
  timers.setImmediate(cb, null)
}

/**
 * @callback Wallet~getBalance
 * @param {?Error} error
 * @param {Object} balance
 * @param {number} balance.total
 * @param {number} balance.available
 * @param {number} balance.unconfirmed
 */

/**
 * @param {AssetDefinition} assetdef
 * @param {Wallet~getBalance} cb
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.getBalance = function (assetdef, cb) {
  verify.AssetDefinition(assetdef)
  verify.function(cb)

  var self = this
  self.isInitializedCheck()

  Q.fcall(function () {
    var coinQuery = self.getCoinQuery()
    coinQuery = coinQuery.includeUnconfirmed()
    coinQuery = coinQuery.includeFrozen()
    coinQuery = coinQuery.onlyColoredAs(assetdef.getColorDefinitions())
    coinQuery = coinQuery.onlyAddresses(self.getAllAddresses(assetdef))

    return Q.ninvoke(coinQuery, 'getCoins')

  }).then(function (coinList) {
    return Q.ninvoke(coinList, 'getValues')

  }).then(function (values) {
    return _.chain(['total', 'available', 'unconfirmed'])
      .map(function (name) {
        var value = values[name].length === 1 ? values[name][0].getValue() : 0
        return [name, value]
      })
      .zipObject()
      .value()

  }).done(function (result) { cb(null, result) }, function (error) { cb(error) })
}

/**
 * @callback Wallet~getBalanceType
 * @param {?Error} error
 * @param {number} balance
 */

/**
 * @param {AssetDefinition} assetdef
 * @param {Wallet~getBalanceType} cb
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.getTotalBalance = function (assetdef, cb) {
  Q.ninvoke(this, 'getBalance', assetdef)
    .done(function (balance) { cb(null, balance.total) }, function (error) { cb(error) })
}

/**
 * @param {AssetDefinition} assetdef
 * @param {Wallet~getBalanceType} cb
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.getAvailableBalance = function (assetdef, cb) {
  Q.ninvoke(this, 'getBalance', assetdef)
    .done(function (balance) { cb(null, balance.available) }, function (error) { cb(error) })
}

/**
 * @param {AssetDefinition} assetdef
 * @param {Wallet~getBalanceType} cb
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.getUnconfirmedBalance = function (assetdef, cb) {
  Q.ninvoke(this, 'getBalance', assetdef)
    .done(function (balance) { cb(null, balance.unconfirmed) }, function (error) { cb(error) })
}

/**
 * {@link WalletStateManager~getEntries}
 */
Wallet.prototype.getHistory = function (assetdef) {
  return this.getStateManager().getHistory(assetdef)
}

/**
 * @typedef {Object} rawTarget
 * @property {number} value Target value in satoshi
 * @property {string} address Target address
 */

/**
 * @callback Wallet~createTx
 * @param {?Error} error
 * @param {ComposedTx} tx
 */

/**
 * @param {AssetDefinition} assetdef
 * @param {rawTarget[]} rawTargets
 * @param {Wallet~createTx} cb
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.createTx = function (assetdef, rawTargets, cb) {
  verify.array(rawTargets)
  rawTargets.forEach(function (rawTarget) {
    verify.object(rawTarget)
    verify.number(rawTarget.value)
    verify.string(rawTarget.address)
  })
  verify.function(cb)

  var self = this
  self.isInitializedCheck()

  var assetTargets = rawTargets.map(function (rawTarget) {
    /** @todo Add multisig support */
    var script = bitcoin.Address.fromBase58Check(rawTarget.address).toOutputScript()
    var assetValue = new asset.AssetValue(assetdef, rawTarget.value)
    return new asset.AssetTarget(script.toHex(), assetValue)
  })

  var assetTx = new tx.AssetTx(self, assetTargets)
  Q.nfcall(tx.transformTx, assetTx, 'composed').done(
    function (composedTx) { cb(null, composedTx) },
    function (error) { cb(error) }
  )
}

/**
 * @callback Wallet~createIssuanceTx
 * @param {?Error} error
 * @param {ComposedTx} tx
 */

/**
 * @param {string} moniker
 * @param {string} pck
 * @param {number} units
 * @param {number} atoms
 * @param {string} seedHex
 * @param {Wallet~createIssuanceTx} cb
 * @throws {Error} If wallet not initialized
 */
Wallet.prototype.createIssuanceTx = function (moniker, pck, units, atoms, seedHex, cb) {
  verify.string(moniker)
  verify.string(pck)
  verify.number(units)
  verify.number(atoms)
  verify.hexString(seedHex)
  verify.function(cb)

  this.isInitializedCheck()

  var self = this

  Q.fcall(function () {
    var colorDefinitionCls = cclib.ColorDefinitionManager.getColorDefenitionClsForType(pck)
    if (colorDefinitionCls === null) {
      throw new errors.VerifyColorDefinitionTypeError('Type: ' + pck)
    }

    var addresses = self.getAddressManager().getAllAddresses(colorDefinitionCls)
    if (addresses.length === 0) {
      addresses.push(self.getAddressManager().getNewAddress(colorDefinitionCls, seedHex))
    }

    var targetAddress = addresses[0].getAddress()
    var targetScript = bitcoin.Address.fromBase58Check(targetAddress).toOutputScript()
    var colorValue = new cclib.ColorValue(cclib.ColorDefinitionManager.getGenesis(), units * atoms)
    var colorTarget = new cclib.ColorTarget(targetScript.toHex(), colorValue)

    var operationalTx = new tx.OperationalTx(self)
    operationalTx.addTarget(colorTarget)

    return Q.nfcall(colorDefinitionCls.composeGenesisTx, operationalTx)

  }).done(function (composedTx) { cb(null, composedTx) }, function (error) { cb(error) })
}

/**
 * @callback Wallet~transformTx
 * @param {?Error} error
 * @param {(RawTx|bitcoinjs-lib.Transaction)} tx
 */

/**
 * @param {(ComposedTx|RawTx)} currentTx
 * @param {string} targetKind
 * @param {Object} [opts]
 * @param {string} [opts.seedHex]
 * @param {number[]} [opts.signingOnly]
 * @param {Wallet~transformTx} cb
 * @throws {Error} If wallet not initialized or not currently seedHex
 */
Wallet.prototype.transformTx = function (currentTx, targetKind, opts, cb) {
  if (_.isFunction(opts) && _.isUndefined(cb)) {
    cb = opts
    opts = undefined
  }
  if (_.isString(opts)) {
    console.warn('seedHex as string is deprecated for removal in 1.0.0, use Object')
    opts = {seedHex: opts}
  }

  verify.function(cb)

  this.isInitializedCheck()
  if (targetKind === 'signed') {
    this.getAddressManager().isCurrentSeedCheck(opts.seedHex)
  }

  opts = _.extend(opts, {wallet: this})
  Q.nfcall(tx.transformTx, currentTx, targetKind, opts).done(
    function (newTx) { cb(null, newTx) },
    function (error) { cb(error) }
  )
}

/**
 * @callback Wallet~sendTx
 * @param {?Error} error
 */

/**
 * @param {bitcoinjs-lib.Transaction} tx
 * @param {Wallet~sendTx} cb
 */
Wallet.prototype.sendTx = function (tx, cb) {
  verify.function(cb)

  this.getStateManager().sendTx(tx).done(function () { cb(null) }, function (error) { cb(error) })
}

Wallet.prototype.connect = function () {
  this.walletEventNotifier.connect()
  this.connector.connect()
}

Wallet.prototype.disconnect = function () {
  this.walletEventNotifier.disconnect()
  this.connector.disconnect()
}

var nullErrorHandler = function () {}

/**
 */
Wallet.prototype.removeListeners = function () {
  var things = [this, this.connector, this.blockchainStorage,
                this.blockchain, this.aManager, this.adManager,
                this.walletEventNotifier, this.walletStateManager]

  things.forEach(function (thing) {
    thing.removeAllListeners()
    thing.on('error', nullErrorHandler)
  })
}

/**
 */
Wallet.prototype.clearStorage = function () {
  this.config.clear()
  this.blockchainStorage.clear()
  this.cdStorage.clear()
  this.cDataStorage.clear()
  this.aStorage.clear()
  this.adStorage.clear()
  this.walletStateManager.clear()
}


module.exports = Wallet
