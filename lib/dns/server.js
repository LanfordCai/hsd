/*!
 * dns.js - dns server for hsd
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const assert = require('bsert');
const IP = require('binet');
const Logger = require('blgr');
const bns = require('bns');
const UnboundResolver = require('bns/lib/resolver/unbound');
const RootResolver = require('bns/lib/resolver/root');
const secp256k1 = require('bcrypto/lib/secp256k1');
const blake2b = require('bcrypto/lib/blake2b');
const LRU = require('blru');
const NameState = require('../covenants/namestate');
const rules = require('../covenants/rules');
const reserved = require('../covenants/reserved');
const Resource = require('./resource');
const key = require('./key');

const {
  DNSServer,
  hsig,
  wire,
  util
} = bns;

const {
  Message,
  Record,
  ARecord,
  AAAARecord,
  NSRecord,
  SOARecord,
  NSECRecord,
  types,
  codes
} = wire;

/*
 * Constants
 */

// NS SOA RRSIG NSEC DNSKEY
// Possibly add A, AAAA, and DS
const TYPE_MAP = Buffer.from('000722000000000380', 'hex');
const RES_OPT = { inet6: false, tcp: true };

/**
 * RootCache
 */

class RootCache {
  constructor(size) {
    this.cache = new LRU(size);
  }

  set(name, type, msg) {
    const key = toKey(name, type);
    const raw = msg.compress();

    this.cache.set(key, {
      time: Date.now(),
      raw
    });

    return this;
  }

  get(name, type) {
    const key = toKey(name, type);
    const item = this.cache.get(key);

    if (!item)
      return null;

    if (Date.now() > item.time + 6 * 60 * 60 * 1000)
      return null;

    return Message.decode(item.raw);
  }
}

/**
 * RootServer
 * @extends {DNSServer}
 */

class RootServer extends DNSServer {
  constructor(options) {
    super(RES_OPT);

    this.ra = false;
    this.edns = true;
    this.dnssec = true;
    this.icann = new RootResolver(RES_OPT);

    this.logger = Logger.global;
    this.key = secp256k1.privateKeyGenerate();
    this.host = '127.0.0.1';
    this.port = 5300;
    this.lookup = null;
    this.publicHost = '127.0.0.1';

    this.cache = new RootCache(3000);

    this.initNode();

    if (options)
      this.initOptions(options);
  }

  initOptions(options) {
    assert(options);

    this.parseOptions(options);

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger.context('ns');
    }

    if (options.key != null) {
      assert(Buffer.isBuffer(options.key));
      assert(options.key.length === 32);
      this.key = options.key;
    }

    if (options.host != null) {
      assert(typeof options.host === 'string');
      this.host = IP.normalize(options.host);
      this.publicHost = this.host;
    }

    if (options.port != null) {
      assert((options.port & 0xffff) === options.port);
      assert(options.port !== 0);
      this.port = options.port;
    }

    if (options.lookup != null) {
      assert(typeof options.lookup === 'function');
      this.lookup = options.lookup;
    }

    if (options.publicHost != null) {
      assert(typeof options.publicHost === 'string');
      this.publicHost = IP.normalize(options.publicHost);
    }

    return this;
  }

  initNode() {
    this.on('error', (err) => {
      this.logger.error(err);
    });

    this.on('query', (req, res) => {
      this.logMessage('DNS Request:', req);
      this.logMessage('DNS Response:', res);
    });

    return this;
  }

  logMessage(prefix, msg) {
    if (this.logger.level < 5)
      return;

    const logs = msg.toString().trim().split('\n');

    this.logger.spam(prefix);

    for (const log of logs)
      this.logger.spam(log);
  }

  signSize() {
    return 94;
  }

  sign(msg, host, port) {
    return hsig.sign(msg, this.key, blake2b, secp256k1);
  }

  async lookupName(name) {
    if (!this.lookup)
      throw new Error('Tree not available.');

    if (!rules.verifyName(name))
      return null;

    const hash = rules.hashName(name);
    const data = await this.lookup(hash);

    if (!data)
      return null;

    const ns = NameState.decode(data);

    if (ns.data.length === 0)
      return null;

    return ns.data;
  }

  async response(req, rinfo) {
    const [qs] = req.question;
    const name = qs.name.toLowerCase();
    const type = qs.type;

    // Our root zone.
    if (name === '.') {
      const res = new Message();

      res.aa = true;

      switch (type) {
        case types.ANY:
        case types.NS:
          res.answer.push(this.toNS());
          key.signZSK(res.answer, types.NS);

          if (IP.family(this.publicHost) === 4) {
            res.additional.push(this.toA());
            key.signZSK(res.additional, types.A);
          } else {
            res.additional.push(this.toAAAA());
            key.signZSK(res.additional, types.AAAA);
          }

          break;
        case types.SOA:
          res.answer.push(this.toSOA());
          key.signZSK(res.answer, types.SOA);

          res.authority.push(this.toNS());
          key.signZSK(res.authority, types.NS);

          if (IP.family(this.publicHost) === 4) {
            res.additional.push(this.toA());
            key.signZSK(res.additional, types.A);
          } else {
            res.additional.push(this.toAAAA());
            key.signZSK(res.additional, types.AAAA);
          }

          break;
        case types.DNSKEY:
          res.answer.push(key.ksk.deepClone());
          res.answer.push(key.zsk.deepClone());
          key.signKSK(res.answer, types.DNSKEY);
          break;
        case types.DS:
          res.answer.push(key.ds.deepClone());
          key.signZSK(res.answer, types.DS);
          break;
        default:
          // Empty Proof:
          res.authority.push(this.toNSEC());
          key.signZSK(res.authority, types.NSEC);
          res.authority.push(this.toSOA());
          key.signZSK(res.authority, types.SOA);
          break;
      }

      return res;
    }

    // Process the name.
    const labels = util.split(name);
    const tld = util.label(name, labels, -1);

    // Ask the urkel tree for the name data.
    const data = await this.lookupName(tld);

    // Non-existent domain.
    if (!data) {
      const item = reserved.getByName(tld);

      // This name is in the existing root zone.
      // Fall back to ICANN's servers if not yet
      // registered on the handshake blockchain.
      // This is an example of "Dynamic Fallback"
      // as mentioned in the whitepaper.
      if (item && item.root) {
        const res = await this.icann.lookup(tld);

        if (res.ad && res.code !== codes.NXDOMAIN) {
          res.ad = false;
          res.question = [qs];
          key.signZSK(res.authority, types.DS);
          key.signZSK(res.authority, types.NSEC);
          key.signZSK(res.authority, types.NSEC3);
          return res;
        }
      }

      const res = new Message();

      res.code = codes.NXDOMAIN;
      res.aa = true;

      // Doesn't exist.
      //
      // We should be giving a real NSEC proof
      // here, but I don't think it's possible
      // with the current construction.
      //
      // I imagine this would only be possible
      // if NSEC3 begins to support BLAKE2b for
      // name hashing. Even then, it's still
      // not possible for SPV nodes since they
      // can't arbitrarily iterate over the tree.
      //
      // Instead, we give a phony proof, which
      // makes the root zone look empty.
      res.authority.push(this.toNSEC());
      res.authority.push(this.toNSEC());
      key.signZSK(res.authority, types.NSEC);
      res.authority.push(this.toSOA());
      key.signZSK(res.authority, types.SOA);

      return res;
    }

    // Our resolution.
    const resource = Resource.decode(data);
    const res = resource.toDNS(name, type);

    if (res.answer.length === 0
        && res.authority.length === 0) {
      res.authority.push(this.toSOA());
      key.signZSK(res.authority, types.SOA);
    }

    return res;
  }

  async resolve(req, rinfo) {
    const [qs] = req.question;
    const {name, type} = qs;

    // Hit the cache first.
    const cache = this.cache.get(name, type);

    if (cache)
      return cache;

    const res = await this.response(req, rinfo);

    this.cache.set(name, type, res);

    return res;
  }

  async open() {
    await super.open(this.port, this.host);

    this.logger.info('Root nameserver listening on port %d.', this.port);
  }

  serial() {
    const date = new Date();
    const y = date.getUTCFullYear() * 1e6;
    const m = (date.getUTCMonth() + 1) * 1e4;
    const d = date.getUTCDate() * 1e2;
    const h = date.getUTCHours();
    return y + m + d + h;
  }

  toSOA() {
    const rr = new Record();
    const rd = new SOARecord();

    rr.name = '.';
    rr.type = types.SOA;
    rr.ttl = 86400;
    rr.data = rd;
    rd.ns = '.';
    rd.mbox = '.';
    rd.serial = this.serial();
    rd.refresh = 1800;
    rd.retry = 900;
    rd.expire = 604800;
    rd.minttl = 86400;

    return rr;
  }

  toNS() {
    const rr = new Record();
    const rd = new NSRecord();
    rr.name = '.';
    rr.type = types.NS;
    rr.ttl = 518400;
    rr.data = rd;
    rd.ns = '.';
    return rr;
  }

  toA() {
    const rr = new Record();
    const rd = new ARecord();
    rr.name = '.';
    rr.type = types.A;
    rr.ttl = 518400;
    rr.data = rd;
    rd.address = this.publicHost;
    return rr;
  }

  toAAAA() {
    const rr = new Record();
    const rd = new AAAARecord();
    rr.name = '.';
    rr.type = types.AAAA;
    rr.ttl = 518400;
    rr.data = rd;
    rd.address = this.publicHost;
    return rr;
  }

  toNSEC() {
    const rr = new Record();
    const rd = new NSECRecord();
    rr.name = '.';
    rr.type = types.NSEC;
    rr.ttl = 86400;
    rr.data = rd;
    rd.nextDomain = '.';
    rd.typeBitmap = TYPE_MAP;
    return rr;
  }
}

/**
 * RecursiveServer
 * @extends {DNSServer}
 */

class RecursiveServer extends DNSServer {
  constructor(options) {
    super(RES_OPT);

    this.ra = true;
    this.edns = true;
    this.dnssec = true;
    this.noAny = true;

    this.logger = Logger.global;
    this.key = secp256k1.privateKeyGenerate();

    this.host = '127.0.0.1';
    this.port = 5301;
    this.stubHost = '127.0.0.1';
    this.stubPort = 5300;

    this.hns = new UnboundResolver({
      inet6: false,
      tcp: true,
      edns: true,
      dnssec: true,
      minimize: true
    });

    this.initNode();

    if (options)
      this.initOptions(options);

    this.hns.setStub(this.stubHost, this.stubPort, key.ds);
  }

  initOptions(options) {
    assert(options);

    this.parseOptions(options);

    if (options.logger != null) {
      assert(typeof options.logger === 'object');
      this.logger = options.logger.context('rs');
    }

    if (options.key != null) {
      assert(Buffer.isBuffer(options.key));
      assert(options.key.length === 32);
      this.key = options.key;
    }

    if (options.host != null) {
      assert(typeof options.host === 'string');
      this.host = IP.normalize(options.host);
    }

    if (options.host != null) {
      assert(typeof options.host === 'string');
      this.host = IP.normalize(options.host);
    }

    if (options.port != null) {
      assert((options.port & 0xffff) === options.port);
      assert(options.port !== 0);
      this.port = options.port;
    }

    if (options.stubHost != null) {
      assert(typeof options.stubHost === 'string');

      this.stubHost = IP.normalize(options.stubHost);

      if (this.stubHost === '0.0.0.0' || this.stubHost === '::')
        this.stubHost = '127.0.0.1';
    }

    if (options.stubPort != null) {
      assert((options.stubPort & 0xffff) === options.stubPort);
      assert(options.stubPort !== 0);
      this.stubPort = options.stubPort;
    }

    return this;
  }

  initNode() {
    this.hns.on('log', (...args) => {
      this.logger.debug(...args);
    });

    this.on('error', (err) => {
      this.logger.error(err);
    });

    this.on('query', (req, res) => {
      this.logMessage('DNS Request:', req);
      this.logMessage('DNS Response:', res);
    });

    return this;
  }

  logMessage(prefix, msg) {
    if (this.logger.level < 5)
      return;

    const logs = msg.toString().trim().split('\n');

    this.logger.spam(prefix);

    for (const log of logs)
      this.logger.spam(log);
  }

  signSize() {
    return 94;
  }

  sign(msg, host, port) {
    return hsig.sign(msg, this.key, blake2b, secp256k1);
  }

  async open(...args) {
    await this.hns.open();

    await super.open(this.port, this.host);

    this.logger.info('Recursive server listening on port %d.', this.port);
  }

  async close() {
    await super.close();
    await this.hns.close();
  }

  async resolve(req, rinfo) {
    const [qs] = req.question;
    return this.hns.resolve(qs);
  }
}

/*
 * Helpers
 */

function toKey(name, type) {
  let labels = util.countLabels(name);
  let ref = false;

  switch (labels) {
    case 0:
    case 1:
      ref = false;
      break;
    case 2:
      ref = !Resource.isPointer(name);
      break;
    case 3:
      switch (type) {
        case types.SRV: {
          ref = !Resource.isSRV(name);
          break;
        }
        case types.TLSA: {
          ref = !Resource.isTLSA(name);
          break;
        }
        case types.SMIMEA: {
          ref = !Resource.isSMIMEA(name);
          break;
        }
        case types.OPENPGPKEY: {
          ref = !Resource.isOPENPGPKEY(name);
          break;
        }
        default: {
          ref = true;
          break;
        }
      }
      break;
    default:
      ref = true;
      break;
  }

  if (ref)
    labels = 1;

  const label = util.from(name, -labels, name);

  // Ignore type if we're a referral.
  if (ref)
    return label.toLowerCase();

  let key = '';
  key += label.toLowerCase();
  key += ';';
  key += type.toString(10);

  return key;
}

/*
 * Expose
 */

exports.RootServer = RootServer;
exports.RecursiveServer = RecursiveServer;
