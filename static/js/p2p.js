// vim: set et sw=2 ts=2 sts=2 ff=unix fenc=utf8:
// Author: Binux<i@binux.me>
//         http://binux.me
// Created on 2013-04-22 17:20:48

define(['peer', 'file_system', 'underscore', 'lib/sha1.min'], function(peer, FileSystem) {
  function Client() {
    this.peerid = null;
    this.file_meta = null;
    this.file = null;
    this.ws = null;
    this.peers = {};
    this.ready = false;
    this.min_speed_limit = 4*1024; // 4kb/s

    this.piece_queue = [];
    this.finished_piece = [];

    this.cur_piece = null;
    this.request_block_size = 1 << 19; // request up to 512K data from one peer
    this.inuse_peer = {};
    this.blocked_peer = {};
    this.finished_block = [];
    this.pending_block = [];

    this.init();
  }

  Client.prototype = {
    init: function() {
      this.ws = new WebSocket(
        (location.protocol == 'https:' ? 'wss://' : 'ws://')+location.host+'/room/ws');
      this.ws.onopen = _.bind(this.onwsopen, this);
      this.ws.onmessage = _.bind(this.onwsmessage, this);
    },

    new_room: function(file_meta, callback) {
      this.ws.send(JSON.stringify({cmd: 'new_room', file_meta: file_meta}));
    },

    join_room: function(room_id) {
      this.ws.send(JSON.stringify({cmd: 'join_room', roomid: room_id}));
    },

    update_peer_list: function() {
      this.ws.send(JSON.stringify({cmd: 'get_peer_list'}));
    },

    update_bitmap: function() {
      this.ws.send(JSON.stringify({cmd: 'update_bitmap', bitmap: client.finished_piece.join('')}));
    },

    // export 
    onready: function() { console.log('onready'); },
    onfilemeta: function(file_meta) { console.log('onfilemeta', file_meta); },
    onpeerlist: function(peer_list) { console.log('onpeerlist', peer_list); },
    onpiece: function(piece) { console.log('onpiece', piece); },
    onfinished: function() { console.log('onfinished'); },

    // private
    ensure_connection: function(peerid, connect) {
      if (this.peers[peerid]) {
        return this.peers[peerid];
      } else {
        var p = new peer.Peer(this.ws, this.peerid, peerid);
        p.onclose = _.bind(function() {
          console.log('peer connect with '+peerid+' disconnected;');
          this.peers[peerid] = null;
          delete this.peers[peerid];
        }, this);
        p.onmessage = _.bind(function(data) {
          var msg = JSON.parse(data);
          //console.log('FROM:'+p.target+': '+(msg.cmd||msg));
          switch (msg.cmd) {
            case 'request_block':
              for (var i=0; i<msg.blocks.length; i++) {
                this.send_block(p, msg.piece, msg.blocks[i]);
              }
              break;
            case 'block':
              this.recv_block(p, msg.piece, msg.block, msg.data);
              break;
            default:
              break;
          } 
        }, this);
        p.onspeedreport = function(a) { console.log(a); };
        if (connect) {
          p.connect();
        }
        this.peers[peerid] = p;
        return p;
      }
    },

    send_block: function(peer, piece, block) {
      //console.log('sending block '+piece+','+block);
      if (!this.file) return;
      if (this.finished_piece[piece] != 1) return;

      var start = this.file_meta.piece_size*piece + this.file_meta.block_size*block;
      this.file.readAsBinaryString(start, start+this.file_meta.block_size, function(data) {
        peer.send({
          cmd: 'block',
          piece: piece,
          block: block,
          data: data
        });
      });
    },

    request_block: function(peer, piece, blocks) {
      peer.send({cmd: 'request_block', piece: piece, blocks: blocks});
    },

    recv_block: function(peer, piece, block, data) {
      //console.log('recv block '+piece+','+block);
      if (piece == this.cur_piece && this.pending_block[block] == peer.target) {
        this.pending_block[block] = 0;
        this.finished_block[block] = 1;
        if (!_.contains(this.pending_block, peer.target) && _.has(this.inuse_peer, peer.target))
          delete this.inuse_peer[peer.target];
        // save as binnary data
        var binarray = new Uint8Array(data.length);
        for (var i=0;i<data.length;i++) {
          binarray[i] = data.charCodeAt(i) & 0xff;
        }
        this.block_chunks[block] = binarray;
        this.onblock_finished(piece, block);
      }
    },

    pickup_block: function(limit) {
      if (_.isEmpty(this.piece_queue) && this.cur_piece === null) {
        return null;
      }

      // choice a piece
      var i, block_cnt = Math.ceil(1.0 * this.file_meta.piece_size / this.file_meta.block_size);
      if (this.cur_piece === null) {
        this.cur_piece = this.piece_queue.pop();
        this.block_chunks = [];
        this.finished_block = [];
        this.pending_block = [];
        for (i=0; i<block_cnt; ++i) {
          this.finished_block[i] = 0;
          this.pending_block[i] = 0;
        }
      }

      // piece finished
      if (this.cur_piece !== null && _.every(this.finished_block, _.identity)) {
        var blob = new Blob(this.block_chunks);
        var This = this;
        this.file.write(blob, this.file_meta.piece_size * this.cur_piece, function() {
          if (_.isFunction(This.onpiece)) {
            This.onpiece(This.cur_piece);
          }
          This.finished_piece[This.cur_piece] = 1;
          This.cur_piece = null;

          // check all finished
          if (_.every(This.finished_piece, _.identity) && _.isEmpty(This.piece_queue)) {
            if (_.isFunction(This.onfinished)) {
              This.onfinished();
            }
          } else {
            _.defer(_.bind(This.start_process, This));
          }
        });
        return null;
      }


      // pick up
      result = [];
      limit = limit || this.request_block_size / this.file_meta.block_size;
      for (i=0; i<block_cnt; ++i) {
        if (this.finished_block[i] || this.pending_block[i])
          continue;
        result.push(i);
        if (result.length >= limit)
          break;
      }
      if (result.length > 0) {
        return [this.cur_piece, result];
      }
      return null;
    },

    find_available_peer: function(piece) {
      for (var key in this.peer_list) {
        if (key == this.peerid) continue;
        if (this.peer_list[key].bitmap[piece] && !_.has(this.inuse_peer, key) && !_.has(this.blocked_peer, key)) {
          return key;
        }
      }
      return null;
    },

    start_process: _.throttle(function() {
      // pickup block
      var blocks = this.pickup_block();
      if (blocks === null) {
        console.debug('no block to go.');
        return ;
      }
      var piece = blocks[0]; blocks = blocks[1];

      // find available peer
      var best_peer = this.find_available_peer(piece);
      if (best_peer === null) {
        console.debug('no peer has the piece.');
        return ;
      }
      var peer = this.ensure_connection(best_peer, true);

      // mark
      this.inuse_peer[best_peer] = 1;
      for (var i=0; i<blocks.length; i++) {
        this.pending_block[blocks[i]] = best_peer;
      }
      //console.debug('request_block: '+piece+','+blocks);
      this.request_block(peer, piece, blocks);

      // set timeout for blocks
      var This = this;
      _.delay(function() {
        for (var i=0; i<blocks.length; i++) {
          if (This.cur_piece == piece && This.pending_block[blocks[i]] == best_peer) {
            This.pending_block[blocks[i]] = 0;
            if (_.has(This.inuse_peer, best_peer))
              delete This.inuse_peer[best_peer];
            _.defer(_.bind(This.start_process, This));
          }
        }
      }, This.file_meta.block_size / This.min_speed_limit * 1000);
    }, 100),

    onblock_finished: function(piece, block) {
      //console.debug('recv_block: '+piece+','+block);
      this.start_process();
    },

    onwsopen: function() { },

    onwsmessage: function(evt) {
      var msg = JSON.parse(evt.data);

      if (!msg.cmd && msg.type && msg.origin) {
        var peer = this.ensure_connection(msg.origin, false);
        peer.onwsmessage(msg);
      } else if (msg.cmd) {
        console.debug('p2p:', msg);
        switch (msg.cmd) {
          case 'peerid':
            this.peerid = msg.peerid;
            this.ready = true;
            if (_.isFunction(this.onready)) {
              this.onready();
            }
            break;
          case 'file_meta':
            if (this.file_meta !== null)
              break;
            this.file_meta = msg.file_meta;
            for (var i=0; i<this.file_meta.piece_cnt; ++i) {
              this.finished_piece[i] = 0;
              this.piece_queue.push(i);
            }
            this.piece_queue.reverse();

            var This = this;
            this.file = new FileSystem.File(this.file_meta.size, function() {
              if (_.isFunction(This.onfilemeta)) {
                This.onfilemeta(This.file_meta);
              }
            });
            break;
          case 'peer_list':
            this.peer_list = msg.peer_list;
            if (_.isFunction(this.onpeerlist)) {
              this.onpeerlist(this.peer_list);
            }
            break;
          default:
            break;
        }
      }
    }
  };

  return {
    Client: Client
  };
});
