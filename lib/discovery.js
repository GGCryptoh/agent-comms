// LAN discovery — UDP multicast probe + responder.
//
// Group: 239.42.42.42 (link-local TTL=1, won't escape the LAN)
// Port:  18742
//
// Probe (sender → multicast):
//   { type: "agent-comms.probe.v1", nonce, ts }
//
// Offer (responder → unicast back to sender):
//   { type: "agent-comms.offer.v1", echo_nonce, ts,
//     instance_id, display_name, endpoint, capabilities,
//     auth: "bearer"|"localhost-only", mode }
//
// No signatures here — the offer is information that the human operator
// will verify out-of-band via the 6-word pairing code in the next step.
// The probe is unauthenticated by design (it's broadcast).

const dgram = require('dgram');
const crypto = require('crypto');

const MCAST_GROUP = '239.42.42.42';
const MCAST_PORT = 18742;
const PROBE_TYPE = 'agent-comms.probe.v1';
const OFFER_TYPE = 'agent-comms.offer.v1';

// Send probes for `timeoutMs`, collect offers, return them.
async function discover({ timeoutMs = 5000, repeatMs = 1500, log = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const offers = new Map(); // instance_id -> offer
    const nonce = crypto.randomBytes(16).toString('base64');

    socket.on('error', err => {
      try { socket.close(); } catch {}
      reject(err);
    });

    socket.on('message', (buf, rinfo) => {
      let msg;
      try { msg = JSON.parse(buf.toString('utf-8')); }
      catch { return; }
      if (!msg || msg.type !== OFFER_TYPE) return;
      if (msg.echo_nonce !== nonce) return;
      if (!msg.instance_id) return;
      if (!offers.has(msg.instance_id)) {
        offers.set(msg.instance_id, { ...msg, source_address: rinfo.address });
        log(`offer: ${msg.display_name || msg.instance_id} @ ${rinfo.address}`);
      }
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(1);
      } catch (e) {
        log(`socket setup warning: ${e.message}`);
      }
      const probe = JSON.stringify({
        type: PROBE_TYPE,
        nonce,
        ts: Date.now(),
      });
      const send = () => {
        socket.send(probe, MCAST_PORT, MCAST_GROUP, err => {
          if (err) log(`probe send error: ${err.message}`);
        });
      };
      send();
      const interval = setInterval(send, repeatMs);
      setTimeout(() => {
        clearInterval(interval);
        try { socket.close(); } catch {}
        resolve(Array.from(offers.values()));
      }, timeoutMs);
    });
  });
}

// Bind UDP responder. `getOffer()` is invoked on each probe to build the
// reply (so display_name etc. can change without restart). Returns a
// `stop()` function.
function startResponder({ getOffer, log = () => {} } = {}) {
  if (typeof getOffer !== 'function') {
    throw new Error('startResponder requires getOffer()');
  }
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', err => {
    log(`[discovery] responder error: ${err.message}`);
  });

  socket.on('message', (buf, rinfo) => {
    let msg;
    try { msg = JSON.parse(buf.toString('utf-8')); }
    catch { return; }
    if (!msg || msg.type !== PROBE_TYPE) return;
    if (!msg.nonce) return;

    let offer;
    try {
      offer = getOffer();
    } catch (e) {
      log(`[discovery] getOffer threw: ${e.message}`);
      return;
    }

    const reply = JSON.stringify({
      type: OFFER_TYPE,
      echo_nonce: msg.nonce,
      ts: Date.now(),
      ...offer,
    });
    socket.send(reply, rinfo.port, rinfo.address, err => {
      if (err) log(`[discovery] offer send error: ${err.message}`);
    });
    log(`[discovery] probe from ${rinfo.address} → offer sent`);
  });

  socket.bind(MCAST_PORT, () => {
    try {
      socket.addMembership(MCAST_GROUP);
      socket.setMulticastTTL(1);
      log(`[discovery] responder listening on udp/${MCAST_PORT} group ${MCAST_GROUP}`);
    } catch (e) {
      log(`[discovery] addMembership failed: ${e.message} — discovery disabled`);
    }
  });

  return () => {
    try { socket.dropMembership(MCAST_GROUP); } catch {}
    try { socket.close(); } catch {}
  };
}

module.exports = {
  MCAST_GROUP,
  MCAST_PORT,
  PROBE_TYPE,
  OFFER_TYPE,
  discover,
  startResponder,
};
