var timers = require('timers')
var events = require('events')
var inherits = require('util').inherits

var _ = require('lodash')
var Q = require('q')

var WalletState = require('./WalletState')
var bitcoin = require('../bitcoin')
var cclib = require('../cclib')
var getUncolored = cclib.ColorDefinitionManager.getUncolored
var errors = require('../errors')
var util = require('../util')
var verify = require('../verify')
var TX_STATUS = require('../const').TX_STATUS


/**
 * @event WalletStateManager#error
 * @param {Error} error
 */

/**
 * @event WalletStateManager#syncStart
 */

/**
 * @event WalletStateManager#syncStop
 */

/**
 * @event WalletStateManager#addTx
 * @param {Transaction} tx
 */

/**
 * @event WalletStateManager#updateTx
 * @param {Transaction} tx
 */

/**
 * @event WalletStateManager#revertTx
 * @param {Transaction} tx
 */

/**
 * @event WalletStateManager#touchAddress
 * @param {string} address
 */

/**
 * @event WalletStateManager#newColor
 * @param {string} desc
 */

/**
 * @event WalletStateManager#touchAsset
 * @param {AssetDefinition} assetdef
 */

/**
 * @event WalletStateManager#historyUpdate
 */

/**
 * @class WalletStateManager
 * @extends events.EventEmitter
 * @mixes SyncMixin
 * @param {Wallet} wallet
 * @param {WalletStateStorage} stateStorage
 */
function WalletStateManager(wallet, stateStorage) {
  verify.Wallet(wallet)
  verify.WalletStateStorage(stateStorage)

  var self = this
  events.EventEmitter.call(self)
  util.SyncMixin.call(self)

  self._wallet = wallet
  self._stateStorage = stateStorage
  self._currentState = new WalletState(self._wallet, self._stateStorage)
  self._executeQueue = []

  // disable tx sending with attempts... (temporary)
  // self._currentState.getTxManager().getAllTxIds().filter(function (txId) {
  //   var txStatus = self._currentState.getTxManager().getTxStatus(txId)
  //   if (TX_STATUS.isDispatch(txStatus)) {
  //     self._attemptSendTx(txId)
  //   }
  // })

  // self.on('sendTx', function (tx) {
  //   self._attemptSendTx(tx.getId())
  // })
}

inherits(WalletStateManager, events.EventEmitter)

/**
 * @private
 * @param {string} txId
 * @param {number} [attempt=0]
 */
WalletStateManager.prototype._attemptSendTx = function (txId, attempt) {
  var self = this

  if (_.isUndefined(attempt)) {
    attempt = 0
  }

  verify.txId(txId)
  verify.number(attempt)

  var tx = self._currentState.getTxManager().getTx(txId)
  if (tx === null) {
    return
  }

  /**
   * Update tx status and
   *     update coins & history if tx have not invalid status
   *     delete coins & history if tx status is invalid
   *
   * @param {number} status
   */
  function updateTx(status) {
    self.execute(function (walletState) {
      var methodName = TX_STATUS.isInvalid(status) ? 'revertTx' : 'updateTx'

      return Q.fcall(function () {
        return walletState.getTxManager().updateTx(tx, {status: status})

      }).then(function () {
        var coinManager = walletState.getCoinManager()
        return coinManager[methodName].call(coinManager, tx)

      }).then(function () {
        var historyManager = walletState.getHistoryManager()
        return historyManager[methodName].call(historyManager, tx)

      }).then(function () {
        return {commit: true}

      })
    })
  }

  self._wallet.getBlockchain().sendTx(tx.toHex())
    .then(function () {
      /** @todo Check propagation with blockchain? */
      updateTx(TX_STATUS.pending)

    }, function (error) {
      self.emit('error', error)

      if (attempt >= 5) {
        return updateTx(TX_STATUS.invalid)
      }

      var timeout = 15000 * Math.pow(2, attempt)
      Q.delay(timeout).then(function () {
        self._attemptSendTx(txId, attempt + 1)
      })
    })
}

/**
 * Return current WalletState if given undefined
 *
 * @private
 * @param {WalletState} [walletState]
 * @return {WalletState}
 */
WalletStateManager.prototype._resolveWalletState = function (walletState) {
  if (_.isUndefined(walletState)) {
    return this._currentState
  }

  verify.WalletState(walletState)
  return walletState
}

/**
 * Create getTxFn with given WalletState
 *     or use current WalletState if given undefined
 *
 * @private
 * @param {WalletState} [walletState]
 * @return {Blockchain~getTx}
 */
WalletStateManager.prototype._createGetTxFn = function (walletState) {
  walletState = this._resolveWalletState(walletState)

  var blockchain = this._wallet.getBlockchain()
  function getTxFn(txId, cb) {
    var tx = walletState.getTxManager().getTx(txId)
    if (tx !== null) {
      return timers.setImmediate(cb, null, tx)
    }

    function onFulfilled(txHex) { cb(null, bitcoin.Transaction.fromHex(txHex)) }
    function onRejected(error) { cb(error) }

    blockchain.getTx(txId).then(onFulfilled, onRejected)
  }

  return getTxFn
}

/**
 * @callback WalletStateManager~execute
 * @param {WalletState} walletState
 * @return {Q.Promise<{commit: boolean}>}
 */

/**
 * @param {WalletStateManager~execute} fn
 * @return {Q.Promise}
 */
WalletStateManager.prototype.execute = function (fn) {
  verify.function(fn)

  var self = this
  self._executeQueue.push(Q.defer())
  if (self._executeQueue.length === 1) {
    self._executeQueue[0].resolve()
    self._syncEnter()
  }

  return _.last(self._executeQueue).promise.then(function () {
    var walletState = new WalletState(self._wallet, self._stateStorage)

    var events = new util.OrderedMap()
    walletState.getTxStateSet().on('error', function (err) {
      events.add('error' + Date.now(), ['error', err])
    })
    walletState.getTxManager().on('addTx', function (tx) {
      events.add('addTx' + tx.getId(), ['addTx', tx])
    })
    walletState.getTxManager().on('updateTx', function (tx) {
      events.add('updateTx' + tx.getId(), ['updateTx', tx])
    })
    walletState.getTxManager().on('revertTx', function (tx) {
      events.add('revertTx' + tx.getId(), ['revertTx', tx])
    })
    walletState.getTxManager().on('sendTx', function (tx) {
      events.add('sendTx' + tx.getId(), ['sendTx', tx])
    })
    walletState.getCoinManager().on('touchAddress', function (address) {
      events.add('touchAddress' + address, ['touchAddress', address])
    })
    walletState.getCoinManager().on('newColor', function (colorDesc) {
      events.add('newColor' + colorDesc, ['newColor', colorDesc])
    })
    walletState.getCoinManager().on('touchAsset', function (assetdef) {
      events.add('touchAsset' + assetdef.getId(), ['touchAsset', assetdef])
    })
    walletState.getHistoryManager().on('update', function () {
      events.add('update', ['historyUpdate'])
    })

    return fn(walletState).finally(function () {
      walletState.getTxManager().removeAllListeners()
      walletState.getCoinManager().removeAllListeners()
      walletState.getHistoryManager().removeAllListeners()

    }).catch(function (error) {
      self.emit('error', error)
      throw error

    }).then(function (result) {
      if (!_.isObject(result) || result.commit !== true) {
        return
      }

      walletState.save({saveNow: result.saveNow || false})
      self._currentState = walletState

      events.getVals().forEach(function (args) {
        self.emit.apply(self, args)
      })
    })

  }).finally(function () {
    self._executeQueue.shift()
    if (self._executeQueue.length > 0) {
      return self._executeQueue[0].resolve()
    }

    self._syncExit()
  })
}

/**
 * Adds tx to local storage and trying to send to network through remote service
 *
 * @param {Transaction} tx
 * @return {Q.Promise}
 */
WalletStateManager.prototype.sendTx = function (tx) {
  // return this.execute(function (walletState) {
  //   var promise = Q()
  //   promise = promise.then(function () { return walletState.getTxManager().sendTx(tx) })
  //   promise = promise.then(function () { return walletState.getCoinManager().addTx(tx) })
  //   promise = promise.then(function () { return walletState.getHistoryManager().addTx(tx) })
  //   return promise.then(function () { return {commit: true, saveNow: true} })
  // })

  var self = this
    return self.execute(function (walletState) {
	return self._wallet.getBlockchain().sendTx(tx.toHex())
          .then(function () { return walletState.getTxManager().sendTx(tx) })
          .then(function () { return walletState.getTxManager().updateTx(tx, {status: TX_STATUS.pending}) })
          .then(function () { return walletState.getCoinManager().addTx(tx) })
          .then(function () { return walletState.getCoinManager().updateTx(tx) })
          .then(function () { return walletState.getHistoryManager().addTx(tx) })
          .then(function () { return walletState.getHistoryManager().updateTx(tx) })
          .then(function () { return {commit: true, saveNow: true} })
    })
}

/**
 * @return {Q.Promise}
 */
WalletStateManager.prototype.sync = function (addresses) {
  console.log('WSM.sync!')
  var self = this

  return self.execute(function (walletState) {
    console.log('WSM.sync.execute')
    var blockchain = self._wallet.getBlockchain()
    
    var txManager = walletState.getTxManager()
    return walletState.getTxStateSet().autoSync(
      blockchain, addresses, txManager.getAllTxIds())
      .then(function (newTxSS) {
        var changes = newTxSS.getChanges()
        console.log('applying ' + changes.length + "changes")
        if (changes.length === 0) {
          return {commit: false}
        }
        
        var coinManager = walletState.getCoinManager()
        var historyManager = walletState.getHistoryManager()
        return Q.all(changes.map(function (txr) {
          return txManager.processTxRecord(txr, coinManager, historyManager)
        }))
        .then(function () {
          historyManager.emit('update')
          console.log('commiting changes')
          walletState.setTxStateSet(newTxSS)
          return {commit: true}
        })
    })
  })
}

/**
 * @callback WalletStateManager~freezeUnfreezeCallback
 * @param {?Error} error
 */

/**
 * @param {Array.<{txId: string, outIndex: number}>} coins
 * @param {Object} opts Freeze options
 * @param {number} [opts.height] Freeze until height is not be reached
 * @param {number} [opts.timestamp] Freeze until timestamp is not be reached
 * @param {number} [opts.fromNow] As timestamp that equal (Date.now() + fromNow)
 * @param {WalletStateManager~freezeUnfreezeCallback} cb
 */
WalletStateManager.prototype.freezeCoins = function (coins, opts, cb) {
  verify.function(cb)

  this.execute(function (walletState) {
    walletState.getCoinManager().freezeCoins(coins, opts)
    return Q.resolve({commit: true})

  }).done(
    function () { cb(null) },
    function (error) { cb(error) }
  )
}

/**
 * @param {Array.<{txId: string, outIndex: number}>} coins
 * @param {WalletStateManager~freezeUnfreezeCallback} cb
 */
WalletStateManager.prototype.unfreezeCoins = function (coins, cb) {
  verify.function(cb)

  this.execute(function (walletState) {
    walletState.getCoinManager().unfreezeCoins(coins)
    return Q.resolve({commit: true})

  }).done(
    function () { cb(null) },
    function (error) { cb(error) }
  )
}

/**
 * @param {string} txId
 * @param {WalletState} [walletState]
 * @return {?Transaction}
 */
WalletStateManager.prototype.getTx = function (txId, walletState) {
  walletState = this._resolveWalletState(walletState)
  return walletState.getTxManager().getTx(txId)
}

/**
 * @callback WalletStateManager~getTxColorValuesCallback
 * @param {?Error} error
 * @param {external:coloredcoinjs-lib.ColorValue[]} colorValues
 */

/**
 * Get ColorValues for given tx and color definition
 *
 * @param {external:coloredcoinjs-lib.bitcoin.Transaction} tx Tx for processing
 * @param {external:coloredcoinjs-lib.ColorDefinition} colordef
 * @param {WalletState} [walletState] Custom WalletState
 * @param {WalletStateManager~getTxColorValuesCallback} cb
 */
WalletStateManager.prototype.getTxColorValues = function (tx, colordef, walletState, cb) {
  // tx, colordef, function, undefined -> tx, colordef, undefined, function
  if (_.isFunction(walletState) && _.isUndefined(cb)) {
    cb = walletState
    walletState = undefined
  }

  verify.Transaction(tx)
  verify.ColorDefinition(colordef)
  walletState = this._resolveWalletState(walletState)
  verify.function(cb)

  var colorData = this._wallet.getColorData()
  var getTxFn = this._createGetTxFn(walletState)

  return Q.fcall(function () {
    return Q.ninvoke(colorData(), 'getTxColorValues', tx, colordef, getTxFn)

  }).then(function (colorValues) {
    return colorValues.map(function (colorValue, index) {
      if (colorValue === null) {
        colorValue = new cclib.ColorValue(getUncolored(), tx.outs[index].value)
      }

      return colorValue
    })

  }).done(
    function (colorValues) { cb(null, colorValues) },
    function (error) { cb(error) }
  )
}

/**
 * Get ColorValues for given tx
 *
 * @param {external:coloredcoinjs-lib.bitcoin.Transaction} tx Tx for processing
 * @param {WalletState} [walletState] Custom WalletState
 * @param {WalletStateManager~getTxColorValuesCallback} cb
 */
WalletStateManager.prototype.getTxMainColorValues = function (tx, walletState, cb) {
  // tx, function, undefined -> tx, undefined, function
  if (_.isFunction(walletState) && _.isUndefined(cb)) {
    cb = walletState
    walletState = undefined
  }

  verify.Transaction(tx)
  walletState = this._resolveWalletState(walletState)
  verify.function(cb)

  var wallet = this._wallet
  var getTxFn = this._createGetTxFn(walletState)
  var colordefs = wallet.getColorDefinitionManager().getAllColorDefinitions()

  Q.all(colordefs.map(function (colordef) {
    return Q.ninvoke(wallet.getColorData(), 'getTxColorValues', tx, colordef, getTxFn)

  })).then(function (colorValuess) {
    var colorValues = colorValuess.reduce(function (pColorValues, colorValues) {
      return pColorValues.map(function (colorValue, index) {
        if (colorValue !== null && colorValues[index] !== null) {
          var msg = tx.getId() + ':' + index + ' have more than one ColorValue'
          throw new errors.CoinColorValueError(msg)
        }

        return colorValue === null ? colorValues[index] : colorValue
      })

    }, _.range(tx.outs.length).map(function () { return null }))

    return colorValues.map(function (cv, index) {
      if (cv !== null) {
        return cv
      }

      return new cclib.ColorValue(getUncolored(), tx.outs[index].value)
    })

  }).done(
    function (colorValues) { cb(null, colorValues) },
    function (error) { cb(error) }
  )
}

/**
 * @param {(string|string[])} addresses
 * @param {WalletState} [walletState]
 * @return {Coin[]}
 */
WalletStateManager.prototype.getCoins = function (addresses, walletState) {
  walletState = this._resolveWalletState(walletState)
  return walletState.getCoinManager().getCoins(addresses)
}

/**
 * @param {{txId: string, outIndex: number}} coin
 * @param {WalletState} [walletState]
 * @return {boolean}
 */
WalletStateManager.prototype.isCoinSpent = function (coin, walletState) {
  walletState = this._resolveWalletState(walletState)
  return walletState.getCoinManager().isCoinSpent(coin)
}

/**
 * @param {{txId: string}} coin
 * @param {WalletState} [walletState]
 * @return {boolean}
 * @throws {TxNotFoundError} If tx for given coin not found
 */
WalletStateManager.prototype.isCoinValid = function (coin, walletState) {
  walletState = this._resolveWalletState(walletState)
  return walletState.getCoinManager().isCoinValid(coin)
}

/**
 * @param {{txId: string}} coin
 * @param {WalletState} [walletState]
 * @return {boolean}
 * @throws {TxNotFoundError} If tx for given coin not found
 */
WalletStateManager.prototype.isCoinAvailable = function (coin, walletState) {
  walletState = this._resolveWalletState(walletState)
  return walletState.getCoinManager().isCoinAvailable(coin)
}

/**
 * @param {{txId: string, outIndex: number}} coin
 * @param {WalletState} [walletState]
 * @return {boolean}
 * @throws {CoinNotFoundError} If coin for given txId:outIndex not found
 */
WalletStateManager.prototype.isCoinFrozen = function (coin, walletState) {
  walletState = this._resolveWalletState(walletState)
  return walletState.getCoinManager().isCoinFrozen(coin)
}

/**
 * @callback WalletStateManager~getCoinColorValueCallback
 * @param {?Error} error
 * @param {ColorValue} colorValue
 */

/**
 * Get ColorValue for given txId:outIndex and color definition
 *
 * @param {{txId: string, outIndex: number}} coin
 * @param {external:coloredcoinjs-lib.ColorDefinition} colordef
 * @param {WalletState} [walletState]
 * @param {WalletStateManager~getCoinColorValueCallback} cb
 */
WalletStateManager.prototype.getCoinColorValue = function (coin, colordef, walletState, cb) {
  // coin, colordef, function, undefined -> coin, colordef, undefined, function
  if (_.isFunction(walletState) && _.isUndefined(cb)) {
    cb = walletState
    walletState = undefined
  }

  verify.object(coin)
  verify.txId(coin.txId)
  verify.number(coin.outIndex)
  verify.ColorDefinition(colordef)
  walletState = this._resolveWalletState(walletState)
  verify.function(cb)

  var getTxFn = this._createGetTxFn(walletState)

  this._wallet.getColorData().getCoinColorValue(coin, colordef, getTxFn, cb)
}

/**
 * Get main ColorValue for given txId:outIndex
 *
 * @param {{txId: string, outIndex: number, value: number}} coin
 * @param {WalletState} [walletState]
 * @param {WalletStateManager~getCoinColorValueCallback} cb
 */
WalletStateManager.prototype.getCoinMainColorValue = function (coin, walletState, cb) {
  // coin, function, undefined -> coin, undefined, function
  if (_.isFunction(walletState) && _.isUndefined(cb)) {
    cb = walletState
    walletState = undefined
  }

  verify.object(coin)
  //verify.txId(coin.txId)
  verify.number(coin.outIndex)
  verify.number(coin.value)
  walletState = this._resolveWalletState(walletState)
  verify.function(cb)

  var wallet = this._wallet
  var getTxFn = this._createGetTxFn(walletState)

  var colordefs = wallet.getColorDefinitionManager().getAllColorDefinitions()
  Q.all(colordefs.map(function (colordef) {
    return Q.ninvoke(wallet.getColorData(), 'getCoinColorValue', coin, colordef, getTxFn)

  })).then(function (colorValues) {
    var colorValue = colorValues.reduce(function (prevColorValue, colorValue) {
      if (prevColorValue === null || colorValue === null) {
        return prevColorValue || colorValue
      }

      var msg = coin.txId + ':' + coin.outIndex + ' have more than one ColorValue'
      throw new errors.CoinColorValueError(msg)
    }, null)

    return colorValue || new cclib.ColorValue(getUncolored(), coin.value)

  }).done(
    function (colorValue) { cb(null, colorValue) },
    function (error) { cb(error) }
  )
}

/**
 * @param {AssetDefinition} [assetdef]
 * @param {WalletState} [walletState]
 * @return {HistoryEntry[]}
 */
WalletStateManager.prototype.getHistory = function (assetdef, walletState) {
  walletState = this._resolveWalletState(walletState)
  return walletState.getHistoryManager().getEntries(assetdef)
}

/**
 */
WalletStateManager.prototype.clear = function () {
  var self = this
  self.once('syncStop', function () {
    self._currentState.clear()
    self._currentState = new WalletState(self._wallet, self._stateStorage)
  })
}


module.exports = WalletStateManager
