'use strict';

/**
 * Network-prefix comparison for session binding.
 *
 * Pinning a handshake to the exact IP that opened it sounds strict and is, in
 * practice, mostly a way to break paying customers. A phone that hands off
 * between wifi and mobile data, a carrier rotating its NAT pool, a dual-stack
 * client that picks v6 for one request and v4 for the next — all of them change
 * address between the handshake and the auth a second later, and all of them saw
 * nothing but "authentication failed".
 *
 * Comparing the network instead keeps what the binding was actually for (a
 * handshake taken on one host can't be spent from somewhere else entirely, so
 * relay/resale services don't work) while leaving normal address churn alone.
 * /24 and /64 are the smallest blocks that are reliably one network in practice.
 */

/** Strip an IPv4-mapped IPv6 prefix so an address is spelled one way. */
function normalise(ip) {
  return String(ip || '').replace(/^::ffff:/i, '');
}

/**
 * The network an address belongs to: /24 for IPv4, /64 for IPv6.
 * Anything unparseable is returned as-is, which degrades to an exact match.
 * @returns {string} '' for a missing address
 */
function netPrefix(ip) {
  const s = normalise(ip);
  if (!s) return '';

  if (s.includes(':')) {
    // IPv6 /64 — the first four hextets. Expand a "::" run first so the groups
    // line up; without that, "2001:db8::1" and "2001:db8:0:0:...:1" would look
    // like different networks.
    const [head, tail] = s.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups =
      s.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
    return groups
      .slice(0, 4)
      .map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, ''))
      .join(':');
  }

  const octets = s.split('.');
  if (octets.length !== 4) return s;
  return octets.slice(0, 3).join('.');
}

/** True when both addresses sit on the same network (see netPrefix). */
function sameNetwork(a, b) {
  const pa = netPrefix(a);
  const pb = netPrefix(b);
  return pa !== '' && pa === pb;
}

module.exports = { normalise, netPrefix, sameNetwork };
