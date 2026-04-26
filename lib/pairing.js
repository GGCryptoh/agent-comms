// Pairing code generation + verification.
//
// A pairing code is six words from the BIP-39 English wordlist (2048 words).
// Six words × 11 bits = 66 bits of entropy — strong enough that a brute-force
// pair-request flood within a 30-second discovery window is not feasible.
//
// Codes are compared with constant-time equality to avoid timing leaks
// (paranoid given we're on LAN, but cheap to do right).

const crypto = require('crypto');
const wordlist = require('./wordlist');

const CODE_LENGTH = 6;

function generateCode() {
  const words = [];
  for (let i = 0; i < CODE_LENGTH; i++) {
    // crypto.randomInt is uniform; wordlist.length is 2048 (a power of two)
    const idx = crypto.randomInt(0, wordlist.length);
    words.push(wordlist[idx]);
  }
  return words.join(' ');
}

function normalizeCode(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function isValidCode(input) {
  const norm = normalizeCode(input);
  const words = norm.split(' ');
  if (words.length !== CODE_LENGTH) return false;
  return words.every(w => wordlist.includes(w));
}

function compareCodes(a, b) {
  const na = normalizeCode(a);
  const nb = normalizeCode(b);
  if (na.length !== nb.length) return false;
  // constant-time comparison
  return crypto.timingSafeEqual(Buffer.from(na), Buffer.from(nb));
}

module.exports = {
  CODE_LENGTH,
  generateCode,
  normalizeCode,
  isValidCode,
  compareCodes,
};
