/* globals describe, it */

// insert losses on the signal
require('./util-scrample')

var utp = require('../src')
var expect = require('chai').expect

describe('scrample-write', function () {
  it('simple', function (done) {
    utp.createServer(function (socket) {
      socket.on('data', function (data) {
        expect(data.toString()).to.equal('client')
        socket.write('server')
      })
    }).listen(53000)

    var socket = utp.connect(53000)
    socket.write('client')
    socket.on('data', function (data) {
      expect(data.toString()).to.equal('server')
      done()
    })
  })

  it('sequence', function (done) {
    this.timeout(5000)
    var max = 10

    utp.createServer(function (socket) {
      var prev = 0
      socket.on('data', function (data) {
        expect('' + (prev++)).to.equal(data.toString())
        socket.write(data)
        if (prev === max) socket.end()
      })
    }).listen(53030)

    var socket = utp.connect(53030)
    var prev = 0

    for (var i = 0; i < max; i++) {
      socket.write('' + i)
    }

    socket.on('data', function (data) {
      expect('' + (prev++)).to.equal(data.toString())
    })
    socket.on('end', function () {
      done()
    })
  })

  it('end', function (done) {
    var ended = false
    var dataed = false

    utp.createServer(function (socket) {
      socket.on('data', function (data) {
        expect(data.toString()).to.equal('client')
        socket.write('server')
      })
      socket.on('end', function () {
        ended = true
        socket.end()
      })
    }).listen(53020)

    var socket = utp.connect(53020)

    socket.on('data', function (data) {
      expect(data.toString()).to.equal('server')
      dataed = true
    })

    socket.on('end', function () {
      expect(ended).to.equal(true)
      expect(dataed).to.equal(true)
      done()
    })
    socket.write('client')
    socket.end()
  })

  it('big', function (done) {
    this.timeout(50000)
    var big = new Buffer(10 * 1024)
    big.fill(1)

    utp.createServer(function (socket) {
      socket.on('data', function (data) {
        socket.write(data)
      })
      socket.on('end', function () {
        socket.end()
      })
    }).listen(53010)

    var socket = utp.connect(53010)
    var recv = 0

    socket.write(big)
    socket.end()

    socket.on('data', function (data) {
      recv += data.length
    })
    socket.on('end', function () {
      expect(recv).to.equal(big.length)
      done()
    })
  })
})
