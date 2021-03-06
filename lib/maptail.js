var EventEmitter = require('events').EventEmitter
var geoip = require('geoip-lite-with-city-data')

var maptail = exports = module.exports = new EventEmitter

maptail.config = {
  // quiet logs
  quiet: false
  // maximum history items
, historyMax: 50

  // maximum markers to buffer
, bufferMax: 50

  // buffer time in milliseconds
, bufferTime: 1000

  // markers' initial time to live in seconds
, ttl: 100 // seconds

  // maximum dots to be displayed (this adjusts ttl automatically)
, maxDots: 200

  // report visitors up to that age
, maxAge: 240 // seconds

  // only emit ips with geo data
, onlyLookups: false

  // aging repaint in fps
, fps: 120

  // no duplicate IPs in a packet
, noduplicates: true

  // tuning for low performance browser
, highPerf: false
}

maptail.history = []
maptail.buffer = []
maptail.ipbuffer = []
maptail.discards = 0
maptail.duplicates = 0


Array.prototype.contains = function(k, callback) {
    var self = this;
    return (function check(i) {
        if (i >= self.length) {
            return callback(false);
        }

        if (self[i] === k) {
            return callback(true);
        }

        return process.nextTick(check.bind(null, i+1));
    }(0));
}



maptail.on('message', function (message) {
  if (message.ip)
  {
    var geo = maptail.lookup(message.ip) || {}
    delete geo.range
    delete geo.region
    geo.ip = message.ip  
    geo.info = message.info
    message = geo
  }
  if (!message.date)
  {
    message.date = Date.now()
  }
  if (!maptail.config.onlyLookups || message.ll || message.sound) maptail.emit('geoip', message)
})

maptail.lookup = function (ip) {
  return geoip.lookup(ip)
}

maptail.track = function () {
  return function (req, res, next) {
    // get real ip address
    var ip =
    req.headers['ip']
    || req.headers['x-forwarded-for']
    || req.headers['x-real-ip']
    || req.headers['x-ip']
    || req.connection.remoteAddress
    maptail.emit('ip', ip)
    next()
  }
}

maptail.static = function (opts) {
  var express = require('express')
  return express.static(__dirname + '/../public')
}

maptail.attach = function (app) {
  var users = {
    list: []
  , has: function (socket) {
      return !!~this.list.indexOf(socket)
    }
  , add: function (socket) {
      if (!this.has(socket))
	  {
	    this.list.push(socket)
		if (!maptail.config.quiet) console.log('>> New client: ' + socket.remoteAddress)
	  }
    }
  , remove: function (socket) {
      var index = this.list.indexOf(socket)
      if (index > -1)
	  {
	    this.list.splice(index, 1)
		if (!maptail.config.quiet) console.log('>> client has quit: ' + socket.remoteAddress)
	  }
    }
  , forEach: function (fn) {
      this.list.forEach(fn)
    }
  }
  var simpl = require('simpl')
  var ws = simpl.createServer(app)
  ws.use(simpl.events())
  ws.use(simpl.json())
  ws.on('connection', function (socket) {
    socket.on('close', function () {
      users.remove(socket)
    })
    socket.remote
    .on('subscribe', function (what) {
      if (what === 'geoip') {
        users.add(socket)
        maptail.config.dateNow = Date.now()
        socket.remote.emit('config', maptail.config)
        socket.remote.emit('geoip', maptail.history)
      }
    })
    .on('unsubscribe', function (what) {
      if (what === 'geoip') users.remove(socket)
    })
  })
  var before = Date.now()
  maptail.on('geoip', function (geo) {
    maptail.history.push(geo)
    maptail.buffer.push(geo)

    // do not emit duplicate IPs in a same packet
    if (maptail.config.noduplicates && geo.ip) 
    {
      maptail.ipbuffer.contains(geo.ip, function(found) 
	  {
        if(found)
        {
          maptail.buffer.shift()
          maptail.duplicates += 1
        }
        else
        {
          maptail.ipbuffer.push(geo.ip)
        }
      })
    }

	if (geo.sound)
	{
      users.forEach(function (socket) 
	  {
        socket.remote.emit('geoip', [geo])
      })
	  maptail.history.pop()
	  maptail.buffer.pop()
	}
	else
	{
      if (maptail.history.length > maptail.config.historyMax) maptail.history.shift()
      //if (maptail.buffer.length && (maptail.buffer.length >= maptail.config.bufferMax || Date.now() - before > maptail.config.bufferTime && maptail.buffer.length)) 
      if (maptail.buffer.length && (Date.now() - before > maptail.config.bufferTime && maptail.buffer.length)) 
	  {
        if (!maptail.config.quiet) console.log('Emit a packet of ' + maptail.buffer.length + ' objects, ' + (maptail.config.noduplicates ? maptail.duplicates + ' duplicate IP, ' : '') + maptail.discards + ' discarded, ' + users.list.length + ' connected users')

        users.forEach(function (socket) 
	    {
          socket.remote.emit('geoip', maptail.buffer)
        })

        before = Date.now()
        maptail.buffer = []
        maptail.ipbuffer = []
        maptail.duplicates = 0
        maptail.discards = 0
      }
      else 
	  {
        if (geo.ip && maptail.buffer.length > maptail.config.bufferMax)
        {
          maptail.buffer.pop()
          maptail.discards += 1
        }
      }
    }
  })
}
