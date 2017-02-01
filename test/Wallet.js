var expect = require('chai').expect

var Q = require('q')

var cccore = require('../lib')
var errors = cccore.errors
var AssetDefinition = cccore.asset.AssetDefinition
var Wallet = cccore.Wallet


describe('Wallet', function () {
  this.timeout(240 * 1000)

  var wallet
  var seed = '123131123131123131123131123131123131123131123131123131'
  var goldAsset = {
    monikers: ['gold'],
    colorDescs: ['epobc:b95323a763fa507110a89ab857af8e949810cf1e67e91104cd64222a04ccd0bb:0:180679'],
    unit: 10
  }

  function setup(done) {
    localStorage.clear()
    wallet = new Wallet({
      testnet: true,
      blockchain: {name: 'Verified'},
      spendUnconfirmedCoins: true
    })
    wallet.getConnector().once('connect', done)
    wallet.on('error', function (e) {console.error(e)})
  }

  function cleanup() {
    wallet.disconnect()
    wallet.removeListeners()
    wallet.clearStorage()
    wallet = null
  }

  describe('temp', function () {
    beforeEach(setup)
    after(cleanup)
    
    it('constructTx', function (done) {
      var seed = '421fc385fdae724b246b80e0212f77bb'
      wallet.initialize(seed)
      wallet.once('syncStop', function () {
        var bitcoin = wallet.getAssetDefinitionByMoniker('bitcoin')
        var targets = [{address: 'mkwmtrHX99ozTegy77wTgPZwodm4E2VbBr', value: 10000}]

        wallet.createTx(bitcoin, targets, function (error, tx) {
          expect(error).to.be.null

          wallet.transformTx(tx, 'signed', {seedHex: seed}, function (error, tx) {
            expect(error).to.be.null
	    done()
	  })
	})	
      })
    })
  })

  describe('instance methods', function () {
    beforeEach(setup)
    afterEach(cleanup)

    describe('initialized+ methods', function () {
      it('isInitialized return false', function () {
        expect(wallet.isInitialized()).to.be.false
      })

      it('isInitialized return true', function () {
        wallet.initialize(seed)
        expect(wallet.isInitialized()).to.be.true
      })

      it('isInitializedCheck throw Error', function () {
        expect(wallet.isInitializedCheck.bind(wallet)).to.throw(errors.WalletNotInitializedError)
      })

      it('isInitializedCheck not throw Error', function () {
        wallet.initialize(seed)
        expect(wallet.isInitializedCheck.bind(wallet)).to.not.throw(errors.WalletAlreadyInitializedError)
      })

      it('isCurrentSeed return true', function () {
        wallet.initialize(seed)
        expect(wallet.isCurrentSeed(seed)).to.be.true
      })

      it('isCurrentSeed return false', function () {
        wallet.initialize(seed)
        expect(wallet.isCurrentSeed(seed.split('').reverse().join(''))).to.be.false
      })
    })

    describe('asset methods', function () {
      it('addAssetDefinition need initialization', function () {
        var fn = function () { wallet.addAssetDefinition(seed, goldAsset) }
        expect(fn).to.throw(errors.WalletNotInitializedError)
      })

      it('addAssetDefinition', function () {
        wallet.initialize(seed)
        var assetdef = wallet.addAssetDefinition(seed, goldAsset)
        expect(assetdef).to.be.instanceof(AssetDefinition)
        expect(assetdef.getData()).to.deep.equal(goldAsset)
      })

      it('getAssetDefinitionByMoniker need initialization', function () {
        var fn = function () { wallet.getAssetDefinitionByMoniker('bitcoin') }
        expect(fn).to.throw(errors.WalletNotInitializedError)
      })

      it('getAssetDefinitionByMoniker', function () {
        wallet.initialize(seed)
        var result = wallet.getAssetDefinitionByMoniker('bitcoin')
        expect(result).to.be.instanceof(AssetDefinition)
        expect(result.getData()).to.deep.equal({monikers: ['bitcoin'], colorDescs: [''], unit: 100000000})
      })

      it('getAllAssetDefinitions need initialization', function () {
        var fn = function () { wallet.getAllAssetDefinitions('bitcoin') }
        expect(fn).to.throw(errors.WalletNotInitializedError)
      })

      it('getAllAssetDefinitions', function () {
        wallet.initialize(seed)
        var result = wallet.getAllAssetDefinitions()
        expect(result).to.have.length(1)
        expect(result[0]).to.be.instanceof(AssetDefinition)
        expect(result[0].getData()).to.deep.equal({monikers: ['bitcoin'], colorDescs: [''], unit: 100000000})
      })
    })

    describe('address methods', function () {
      var bitcoin

      it('getNewAddress need initialization', function () {
        expect(wallet.getNewAddress.bind(wallet)).to.throw(errors.WalletNotInitializedError)
      })

      it('getNewAddress', function () {
        wallet.initialize(seed)
        bitcoin = wallet.getAssetDefinitionByMoniker('bitcoin')
        expect(wallet.getNewAddress(seed, bitcoin)).to.equal('mmFYK2Mofiwtm68ZTYK7etjiGyf3SeLkgo')
      })

      it('getAllAddresses need initialization', function () {
        var fn = function () { wallet.getAllAddresses(bitcoin) }
        expect(fn).to.throw(errors.WalletNotInitializedError)
      })

      it('getAllAddresses', function () {
        wallet.initialize(seed)
        expect(wallet.getAllAddresses(bitcoin)).to.deep.equal(['mmHBqwp1fDwWXaXqo5ZrEE4qAoXH5xkUvd'])
      })

      it('getSomeAddress need initialization', function () {
        var fn = function () { wallet.getSomeAddress() }
        expect(fn).to.throw(errors.WalletNotInitializedError)
      })

      it('getSomeAddress', function () {
        wallet.initialize(seed)
        bitcoin = wallet.getAssetDefinitionByMoniker('bitcoin')
        expect(wallet.getSomeAddress(bitcoin)).to.equal('mmHBqwp1fDwWXaXqo5ZrEE4qAoXH5xkUvd')
      })

      it('checkAddress bitcoin', function () {
        wallet.initialize(seed)
        bitcoin = wallet.getAssetDefinitionByMoniker('bitcoin')
        var isValid = wallet.checkAddress(bitcoin, 'mgFmR51KZRKb2jcmJb276KQK9enC9cmG9v')
        expect(isValid).to.be.true
      })

      it('checkAddress color', function () {
        wallet.initialize(seed)
        var epobc = wallet.addAssetDefinition(seed, goldAsset)
        var isValid = wallet.checkAddress(epobc, 'ES5wsZmWHs5xzP@mgFmR51KZRKb2jcmJb276KQK9enC9cmG9v')
        expect(isValid).to.be.true
      })
    })
  })

  describe('balance methods', function () {
    before(function (done) {
      setup(function () {
        wallet.initialize(seed)
        wallet.addAssetDefinition(seed, goldAsset)
        wallet.once('syncStop', done)
      })
    })

    after(cleanup)

    var fixtures = [
      {method: 'getAvailableBalance',   moniker: 'bitcoin', balance: 63326039},
      {method: 'getAvailableBalance',   moniker: 'gold',    balance: 2000},
      {method: 'getTotalBalance',       moniker: 'bitcoin', balance: 63326039},
      {method: 'getTotalBalance',       moniker: 'gold',    balance: 2000},
      {method: 'getUnconfirmedBalance', moniker: 'bitcoin', balance: 0},
      {method: 'getUnconfirmedBalance', moniker: 'gold',    balance: 0}
    ]

    fixtures.forEach(function (fixture) {
      it(fixture.method + ' for ' + fixture.moniker, function (done) {
        var assetdef = wallet.getAssetDefinitionByMoniker(fixture.moniker)

        wallet[fixture.method](assetdef, function (error, balance) {
          if (error) { throw error }
          expect(error).to.be.null
          expect(balance).to.equal(fixture.balance)
          done()
        })
      })
    })
  })

  describe('send, history, issue', function () {
    beforeEach(setup)
    afterEach(cleanup)

    it('sendCoins', function (done) {
      var deferred = Q.defer()
      deferred.promise.done(done, done)

      var seed = '421fc385fdae724b246b80e0212f77bb'
      wallet.initialize(seed)
      wallet.addAssetDefinition(seed, goldAsset)
      wallet.once('syncStop', function () {
        var bitcoin = wallet.getAssetDefinitionByMoniker('bitcoin')
        var targets = [{address: 'mkwmtrHX99ozTegy77wTgPZwodm4E2VbBr', value: 10000}]

        wallet.createTx(bitcoin, targets, function (error, tx) {
          expect(error).to.be.null

          wallet.transformTx(tx, 'signed', {seedHex: seed}, function (error, tx) {
            expect(error).to.be.null

            wallet.on('updateTx', function (newTx) {
              if (newTx.getId() === tx.getId()) { deferred.resolve() }
            })

            wallet.sendTx(tx, function (error) {
              expect(error).to.be.null
            })
          })
        })
      })
    })

    it('history', function (done) {
      wallet.initialize(seed)

      wallet.on('syncStop', function () {
        var entries = wallet.getHistory()
        expect(entries).to.be.instanceof(Array)
        done()
      })
    })

    it('issueCoins epobc', function (done) {
      var seed = '421ac385fdaed1121321222eddad0daf'
      wallet.initialize(seed)
      wallet.addAssetDefinition(seed, goldAsset)
      wallet.once('syncStop', function () {
        wallet.createIssuanceTx('newEPOBC', 'epobc', 2, 10000, seed, function (error, tx) {
          expect(error).to.be.null

          wallet.transformTx(tx, 'signed', {seedHex: seed}, function (error, tx) {
            expect(error).to.be.null

            wallet.sendTx(tx, function (error) {
              expect(error).to.be.null
              done()
            })
          })
        })
      })
    })
  })
})
