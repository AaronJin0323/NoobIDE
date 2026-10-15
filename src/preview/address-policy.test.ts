import { describe, expect, it } from 'vitest';
import { embeddedIpv4, inNetwork, isPublicAddress, normalizeIp } from './address-policy';

describe('preview address policy (S05.5, decision 0015)', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '[2a00:1450:4001:80b::200e]',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:808:808::1',
  ])('allows public %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '0.1.2.3',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.20',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '192.0.2.1',
    '198.18.0.1',
    '224.0.0.251',
    '239.255.255.250',
    '255.255.255.255',
    '240.0.0.1',
    '::1',
    '::',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:192.168.0.1',
    '::127.0.0.1',
    'fe80::1',
    'fe80::1%en0',
    'fc00::1',
    'fd12:3456:789a::1',
    'ff02::1',
    'fec0::1',
    '2001:db8::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '64:ff9b::7f00:1',
    '64:ff9b::a00:1',
    '2002:7f00:1::1',
    '2002:c0a8:101::1',
    '100::1',
    '3fff::1'.replace('3fff', '4000'),
    'localhost',
    'example.com',
    '',
    '1.2.3',
    '1.2.3.256',
    '::g',
  ])('refuses %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it('normalises IP literals and rejects names', () => {
    expect(normalizeIp('[::1]')).toBe('0:0:0:0:0:0:0:1');
    expect(normalizeIp('0:0:0:0:0:0:0:1')).toBe('0:0:0:0:0:0:0:1');
    expect(normalizeIp('::ffff:127.0.0.1')).toBe('0:0:0:0:0:ffff:7f00:1');
    expect(normalizeIp('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp('FE80::1%en0')).toBe('fe80:0:0:0:0:0:0:1');
    expect(normalizeIp('example.com')).toBeNull();
  });

  it('finds the IPv4 address inside mapped, NAT64 and 6to4 forms', () => {
    expect(embeddedIpv4('::ffff:81.2.69.160')).toBe('81.2.69.160');
    expect(embeddedIpv4('::ffff:5102:45a0')).toBe('81.2.69.160');
    expect(embeddedIpv4('64:ff9b::5102:45a0')).toBe('81.2.69.160');
    expect(embeddedIpv4('2002:5102:45a0::1')).toBe('81.2.69.160');
    expect(embeddedIpv4('2606:4700::1')).toBeNull();
    expect(embeddedIpv4('81.2.69.160')).toBeNull();
  });

  it('matches addresses against interface networks', () => {
    expect(inNetwork('192.168.1.20', '192.168.1.5/24')).toBe(true);
    expect(inNetwork('192.168.2.20', '192.168.1.5/24')).toBe(false);
    expect(inNetwork('2a02:1810:1234:5600::20', '2a02:1810:1234:5600:abcd::1/64')).toBe(true);
    expect(inNetwork('2a02:1810:1234:5601::20', '2a02:1810:1234:5600::/64')).toBe(false);
    expect(inNetwork('192.168.1.20', '2a02::/16')).toBe(false);
    expect(inNetwork('192.168.1.20', 'garbage')).toBe(false);
  });
});
