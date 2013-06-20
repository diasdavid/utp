var dgram = require('dgram');
var cyclist = require('cyclist');
var EventEmitter = require('events').EventEmitter;
var Duplex = require('stream').Duplex;

var noop = function() {};

var EXTENSION = 0;
var VERSION   = 1;
var UINT16    = 0xffff;
var ID_MASK   = 0xf << 4;
var MTU       = 1400;

var PACKET_DATA  = 0 << 4;
var PACKET_FIN   = 1 << 4;
var PACKET_STATE = 2 << 4;
var PACKET_RESET = 3 << 4;
var PACKET_SYN   = 4 << 4;

var CONNECTING = 1;
var CONNECTED  = 2;
var HALF_OPEN  = 3;
var CLOSED     = 4;

var MIN_PACKET_SIZE = 20;
var DEFAULT_WINDOW_SIZE = 1 << 18;
var CLOSE_GRACE = 5000;

var BUFFER_SIZE = 512;

var uint32 = function(n) {
	return n >>> 0;
};

var uint16 = function(n) {
	return n & UINT16;
};

var timestamp = function() {
	var offset = process.hrtime();
	var then = Date.now() * 1000;

	return function() {
		var diff = process.hrtime(offset);
		return uint32(then + 1000000 * diff[0] + ((diff[1] / 1000) | 0));
	};
}();

var bufferToPacket = function(buffer) {
	var packet = {};
	packet.id = buffer[0] & ID_MASK;
	packet.connection = buffer.readUInt16BE(2);
	packet.timestamp = buffer.readUInt32BE(4);
	packet.timediff = buffer.readUInt32BE(8);
	packet.window = buffer.readUInt32BE(12);
	packet.seq = buffer.readUInt16BE(16);
	packet.ack = buffer.readUInt16BE(18);
	packet.data = buffer.length > 20 ? buffer.slice(20) : null;
	return packet;
};

var packetToBuffer = function(packet) {
	var buffer = new Buffer(20 + (packet.data ? packet.data.length : 0));
	buffer[0] = packet.id | VERSION;
	buffer[1] = EXTENSION;
	buffer.writeUInt16BE(packet.connection, 2);
	buffer.writeUInt32BE(packet.timestamp, 4);
	buffer.writeUInt32BE(packet.timediff, 8);
	buffer.writeUInt32BE(packet.window, 12);
	buffer.writeUInt16BE(packet.seq, 16);
	buffer.writeUInt16BE(packet.ack, 18);
	if (packet.data) packet.data.copy(buffer, 20);
	return buffer;
};

var Connection = function(port, host, socket, syn) {
	Duplex.call(this);
	var self = this;

	this.port = port;
	this.host = host;
	this.socket = socket;

	this._outgoing = cyclist(BUFFER_SIZE);
	this._incoming = cyclist(BUFFER_SIZE);
	this._inflightPackets = 0;
	this._inflightBytes = 0;
	this._inflightTimeout = 500000;
	this._stack = [];
	this._ondrain = noop;

	if (syn) {
		this.seq = (Math.random() * UINT16) | 0;
		this.ack = syn.seq;
		this.recvId = uint16(syn.connection + 1);
		this.sendId = syn.connection;
		this.readyState = CONNECTED;

		this._sendAck();
	} else {
		this.seq = 1;
		this.ack = 1;
		this.recvId = 0; // tmp value for v8
		this.sendId = 0; // tmp value for v8
		this.readyState = CONNECTING;

		socket.bind(); // we are iniating this connection since we own the socket
		socket.on('listening', function() {
			self.recvId = socket.address().port; // using the port gives us system wide clash protection
			self.sendId = uint16(self.recvId + 1);
			self._sendPacket(PACKET_SYN, self.recvId, null);
		});
		socket.on('error', function(err) {
			self.emit('error', err);
		});
	}

	var resend = setInterval(this._checkTimeout.bind(this), 500);

	var tick = 0;
	var closed = function() {
		if (++tick !== 2) return;
		if (!syn) setTimeout(socket.close.bind(socket), CLOSE_GRACE);
		clearInterval(resend);
		self.readyState = CLOSED;
		self.emit('close');
	};

	this.on('finish', function() {
		self._sendFin(function() {
			process.nextTick(closed);
		});
	});
	this.on('end', function() {
		process.nextTick(closed);
	});
};

Connection.prototype.__proto__ = Duplex.prototype;

Connection.prototype.destroy = function() {
	this.end();
};

Connection.prototype.address = function() {
	return {port:this.port, address:this.host};
};

Connection.prototype._read = noop;

Connection.prototype._write = function(data, enc, callback) {
	if (this.readyState === CONNECTING) return this._stack.push(this._write.bind(this, data, enc, callback));

	for (var i = 0; i < data.length; i += MTU) {
		var flushed = this._sendPacket(PACKET_DATA, this.sendId, data.slice(i, i+MTU), null);
		if (flushed) continue;
		this._ondrain = i+MTU < data.length ? this._write.bind(this, data.slice(i+MTU), enc, callback) : callback;
		return;
	}

	callback();
};

Connection.prototype._sendFin = function(callback) {
	if (this.readyState === CONNECTING) return this._stack.push(this._sendFin.bind(this, callback));
	this._sendPacket(PACKET_FIN, this.sendId, null, callback);
};

Connection.prototype._sendAck = function() {
	this._sendPacket(PACKET_STATE, this.sendId, null, null);
};

Connection.prototype._sendPacket = function(id, connection, data, callback) {
	var now = timestamp();
	var seq = this.seq;
	this.seq = uint16(this.seq+1);

	var packet = {
		id: id,
		connection: connection,
		timestamp: now,
		timediff: 0,
		window: DEFAULT_WINDOW_SIZE,
		seq: seq,
		ack: this.ack,
		data: data,
		sent: now,
		callback: callback
	};

	if (id !== PACKET_STATE) this._outgoing.put(packet.seq, packet);
	if (data) this._inflightBytes += data.length;

	this._inflightPackets++;
	this._send(packet);

	return this._inflightBytes < DEFAULT_WINDOW_SIZE || this._inflightPackets < BUFFER_SIZE-10;
};

Connection.prototype._send = function(packet) {
	var message = packetToBuffer(packet);
	this.socket.send(message, 0, message.length, this.port, this.host);
};

Connection.prototype._checkTimeout = function() {
	for (var i = 0; i < this._inflightPackets; i++) {
		var packet = this._outgoing.get(this.seq - i - 1);
		if (!packet) continue;
		var now = timestamp();
		if (uint32(now - packet.sent) < this._inflightTimeout) continue;
		packet.sent = now;
		this._send(packet);
	}
};

Connection.prototype._recvAck = function(seq) {
	var prevAcked = uint16(this.seq - this._inflightPackets - 1); // last packet that was acked
	var acks = uint16(seq - prevAcked); // amount of acks we just recv
	if (acks >= BUFFER_SIZE) return; // sanity check

	for (var i = 0; i < acks; i++) {
		this._inflightPackets--;
		var packet = this._outgoing.del(prevAcked+i+1);
		if (packet && packet.data) this._inflightBytes -= packet.data.length;
		if (packet && packet.callback) packet.callback();
	}

	if (!this._inflightBytes) {
		process.nextTick(this._ondrain);
		this._ondrain = noop;
	}
};

Connection.prototype._recvPacket = function(packet) {
	if (this.readyState === CLOSED) return;

	if (this.readyState === CONNECTING) {
		if (packet.id !== PACKET_STATE) return this._incoming.put(packet.seq, packet);

		this.emit('connect');
		this.ack = packet.seq;
		this.readyState = CONNECTED;
		this._recvAck(packet.ack);

		while (this._stack.length) this._stack.shift()();
		packet = this._incoming.del(this.ack+1);
		if (!packet) return;
	}

	if (uint16(packet.seq - this.ack) >= BUFFER_SIZE) return this._sendAck(); // old packet
	this._incoming.put(packet.seq, packet);

	var shouldAck = false;
	while (packet = this._incoming.del(this.ack+1)) {
		if (packet.seq !== uint16(this.ack+1)) break; // sanity check

		this.ack = packet.seq;

		if (this.readyState !== CONNECTED) { // not connected -> handle everything as PACKET_STATE packets
			this._recvAck(packet.ack);
			continue;
		}

		if (packet.id === PACKET_DATA) {
			this.push(packet.data);
		}
		if (packet.id === PACKET_FIN) {
			this.readyState = HALF_OPEN;
			this.push(null);
		}
		if (packet.id === PACKET_RESET) {
			this.readyState = CLOSED;
			this.push(null);
			this.end();
		}

		shouldAck = shouldAck || packet.id !== PACKET_STATE;
		this._recvAck(packet.ack);
	}

	if (shouldAck) this._sendAck();
};

var Server = function() {
	EventEmitter.call(this);
	this.socket = null;
};

Server.prototype.__proto__ = EventEmitter.prototype;

Server.prototype.address = function() {
	return this.socket && this.socket.address();
};

Server.prototype.listen = function(socket, onlistening) {
	if (typeof socket !== 'object') {
		var port = socket;
		socket = dgram.createSocket('udp4');
		socket.bind(port);
		return this.listen(socket, onlistening);
	}

	var self = this;
	var connections = {};

	this.socket = socket;

	socket.on('listening', function() {
		self.emit('listening');
	});
	socket.on('error', function(err) {
		self.emit('error', err);
	});

	socket.on('message', function(message, rinfo) {
		if (message.length < MIN_PACKET_SIZE) return;
		var packet = bufferToPacket(message);
		var id = rinfo.address+':'+(packet.id === PACKET_SYN ? uint16(packet.connection+1) : packet.connection);
		var connection = connections[id];

		if (connection) {
			if (packet.id === PACKET_SYN) return;
			connection.port = rinfo.port; // do know if port can change when behind routers - investigate
			connection._recvPacket(packet);
			return;
		}
		if (packet.id !== PACKET_SYN) return;

		connection = new Connection(rinfo.port, rinfo.address, socket, packet);
		connections[id] = connection;
		connection.on('close', function() {
			delete connections[id];
		});
		self.emit('connection', connection);
	});

	if (onlistening) this.on('listening', onlistening);
};

exports.createServer = function(onconnection) {
	var server = new Server();
	if (onconnection) server.on('connection', onconnection);
	return server;
};

exports.connect = function(port, host) {
	var socket = dgram.createSocket('udp4');
	var conn = new Connection(port, host || '127.0.0.1', socket, null);

	socket.on('message', function(message) {
		if (message.length < MIN_PACKET_SIZE) return;
		conn._recvPacket(bufferToPacket(message));
	});

	return conn;
};