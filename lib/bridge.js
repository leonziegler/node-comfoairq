'use strict';

const debug = require('debug')('comfoq-bridge');
const debugError = require('debug')('comfoq-bridge:error');
const debugVerbose = require('debug')('comfoq-bridge:details');
const debugRaw = require('debug')('comfoq-bridge:raw-data');

const Buffer = require('safe-buffer').Buffer;
const udp = require('dgram');
const tcp = require('net');
const events = require('events');

const protoBuf = require('protobufjs');
const messages = protoBuf.loadSync(__dirname + '/protocol/zehnder.proto');
const config = require('./const');

class ComfoAirQBridge extends events {

  constructor(options) {
    super();

    this._settings = options;

    debug.enabled = true;
    debugError.enabled = true;
    debugVerbose.enabled = this._settings.verbose;
    debugRaw.enabled = this._settings.debug;
    
    this.isdiscovered = false;
    this.isconnected = false;

    this.txheader = Buffer.alloc(38).fill(0);
    // if comfouuid is already known, the TX header can be prepared
    if (this._settings.comfouuid) {

      debugVerbose('bridge constructor: comfouuid already known');

      this._settings.uuid.copy(this.txheader, 4);
      this._settings.comfouuid.copy(this.txheader, 20);

      this.isdiscovered = true;
    } else { 
      debugVerbose('bridge constructor: comfouuid not known -> discovery needed');
    }

    this.initSocket();
    
  }

  initSocket () {
    this.sock = new tcp.Socket();

    this.sock.setNoDelay(true);
    this.sock.setTimeout(15000);
    this.sock.setKeepAlive(true, 5000);

    this.sock.on('connect', () => {
      debug('bridge : connected to comfoAir unit -> ' + config.getTimestamp());

      this.isconnected = true;
    });

    this.sock.on('timeout', () => {
      debugError('bridge : TCP socket timeout -> ' + config.getTimestamp());
      const reason = {
        error: 'timeout'
      };
      if (this.isconnected) {
        this.emit('error', reason);
        this.sock.end('timeout detected');
      }
      //this.sock.destroy('timeout detected');
      this.isconnected = false;
    });

    this.sock.on('data', (data) => {
      let msglen = -1 ;
      let offset = 0;
      const datalen = data.length;

      // search the receive buffer for multiple messages received at the same time
      while (offset < datalen) {
        msglen = data.readInt32BE(offset);
        const buffer = data.slice(offset, offset + msglen + 4);
        const rxdata = {
          'time': new Date(),
          'data': buffer,
          'kind': -1,
          'msg': null
        };

        debugRaw(' <- RX : ' + buffer.toString('hex'));

        this.emit('received', rxdata);

        offset += msglen + 4;
      }

    });

    this.sock.on('error', (err) => {
      debugError('bridge : sock error: ' + err + ' -> ' + config.getTimestamp());
      const reason = {
        error: err
      };
      this.sock.end('socket error');
      this.emit('error', reason);
    });

    this.sock.on('close', (had_error) => {

      if (had_error) {
        debugError('bridge : TCP socket closed with error -> ' + config.getTimestamp());
      } else {
        debug('bridge : TCP socket closed -> ' + config.getTimestamp());
      }

      //this.sock.end('socket closed');
      this.isconnected = false;
      this.emit('disconnect');
      this.sock.destroy();
      
    });

    this.sock.on('end', () => {
      debug('bridge : TCP socket ended -> ' + config.getTimestamp());
    });

  }

  // discovery of the ventilation unit / LAN C adapter
  async discovery() {
    const listener = udp.createSocket('udp4');
    
    return new Promise((resolve, reject) => {
      listener.bind(this._settings.port, () => {
        const txdata = Buffer.from('0a00', 'hex');
    
        debugRaw(' -> TX (UDP) : ' + txdata.toString('hex'));

        if (this._settings.comfoair == null) {
          listener.addMembership(this._settings.multicast);
          listener.setBroadcast(true);
  
          listener.send(txdata, this._settings.port, null);
        } else {
          listener.send(txdata, this._settings.port, this._settings.comfoair);
        }
      });

      listener.on('error', (err) => {
        reject(err);
      });

      listener.on('close', () => {
        // preparation of the TX header
        this._settings.uuid.copy(this.txheader, 4);
        this._settings.comfouuid.copy(this.txheader, 20);

        const result = {
          'localuuid' : this._settings.uuid,
          'comfouuid' : this._settings.comfouuid,
          'device'    : this._settings.comfoair,
          'port'      : this._settings.port
        };
        resolve(result);
      });
    
      listener.on('message', (message, remote) => {

        debugRaw(' <- RX (UDP) : ' + message.toString('hex'));
        debugRaw('         (' + remote.address + ':' + remote.port +  ')');
    
        const protoData = messages.DiscoveryOperation.decode(message);
        this._settings.comfoair = protoData.searchGatewayResponse.ipaddress;
        this._settings.comfouuid = protoData.searchGatewayResponse.uuid;

        listener.close();
      });

    });
  }

  get settings() {
    return this._settings;
  }
  set settings(value) {
    this._settings = value;
  }
}

ComfoAirQBridge.prototype.discover =  async function () {

  return new Promise((resolve,reject) => {
  
    try {
      this.discovery()
        .then((result) => {
          debug('  discovery complete -> ' + config.getTimestamp());

          this.isdiscovered = true;
          resolve(result);
        });
      
    } 
    catch (exc) {
      reject(exc);
    }
  });
    
};

ComfoAirQBridge.prototype.transmit = async function (data) {

  // the bridge should be connected in order to transmit something
  if (!this.isconnected) {
   
    while (!this.isdiscovered) {
      await config.sleep(25);
    }

    if (this.sock.destroyed) {
      this.initSocket();
    }

    this.sock.connect(this._settings.port, this._settings.comfoair);

    while (!this.isconnected && !this.sock.destroyed) {
      await config.sleep(25);
    }

    if (!this.isconnected) {
      return Promise.reject('bridge not connected')
    }
  }

  return new Promise((resolve, reject) => {

    // preparation of the transmit buffer
    const op_len = data.operation.length;
    const msg_len = 16 + 16 + 2 + data.command.length + data.operation.length;
    const txdata = Buffer.concat([this.txheader, data.operation, data.command]);
    
    txdata.writeInt16BE(op_len, 36);
    txdata.writeInt32BE(msg_len, 0);

    debugRaw(' -> TX : ' + txdata.toString('hex'));

    this.sock.write(txdata, (err) => {
      if (err) {
        debugError('bridge : error sending data -> ' + err + ' -> ' + config.getTimestamp());
        reject(err);
      }
      
      resolve('OK');
    });
  });
};

module.exports = ComfoAirQBridge;
