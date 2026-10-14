import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { TronWeb } from 'tronweb';
import {
  addBusinessDays,
  addBusinessHours,
  addressKey,
  allowedActions,
  challengeMessage,
  checkAddress,
  checkAddressForNetwork,
  DEFAULT_FEE_SCHEDULE,
  deserializeRules,
  DEFAULT_RULES,
  escrowFeeTerms,
  explainReason,
  formatNairaReference,
  formatUnits,
  formatUsd,
  hexToTron,
  isLookalike,
  matchNames,
  namesAgree,
  networksForAddress,
  onChainFee,
  orderRefFor,
  parseUnits,
  quoteEscrowFee,
  quoteSendFee,
  recoverSigner,
  scanForContactDetails,
  serializeRules,
  tronToHex,
  verifyOwnership,
  type EscrowView,
} from '../src/index.ts';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

describe('addresses', () => {
  it('accepts a valid EIP-55 address and rejects a bad checksum', () => {
    const ok = checkAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(ok).toMatchObject({ valid: true, family: 'evm', checksummed: true });
    const bad = checkAddress('0x833589fcD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(bad).toEqual({ valid: false, reason: 'bad_checksum' });
  });

  it('accepts single-case EVM addresses but marks them as not checksummed', () => {
    expect(checkAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toMatchObject({ valid: true, checksummed: false, normalized: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' });
  });

  it('validates TRON Base58Check', () => {
    expect(checkAddress(USDT_TRON)).toMatchObject({ valid: true, family: 'tron' });
    // flip one character -> checksum failure
    expect(checkAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toMatchObject({ valid: false });
    expect(checkAddress('hello')).toEqual({ valid: false, reason: 'bad_format' });
    expect(checkAddress('')).toEqual({ valid: false, reason: 'empty' });
  });

  it('agrees with TronWeb on TRON <-> hex conversion', () => {
    const hex = tronToHex(USDT_TRON);
    expect(TronWeb.address.toHex(USDT_TRON).toLowerCase()).toBe(`41${hex.slice(2).toLowerCase()}`);
    expect(hexToTron(hex)).toBe(USDT_TRON);
    expect(TronWeb.isAddress(USDT_TRON)).toBe(true);
  });

  it('keeps a leading 41 byte that belongs to a 20-byte address', () => {
    const hex = '0x41aabbccddeeff00112233445566778899aabbcc';
    const tron = hexToTron(hex);
    expect(TronWeb.address.fromHex(`41${hex.slice(2)}`)).toBe(tron);
    expect(hexToTron(`41${hex.slice(2)}`)).toBe(tron);
    expect(hexToTron(hex.slice(2))).toBe(tron);
    expect(tronToHex(tron).toLowerCase()).toBe(hex);
  });

  it('lists all EVM networks for an EVM address (L1-3) and only TRON for a TRON address', () => {
    expect(networksForAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toEqual(['base', 'arc', 'ethereum']);
    expect(networksForAddress(USDT_TRON)).toEqual(['tron']);
    expect(checkAddressForNetwork(USDT_TRON, 'base').valid).toBe(false);
  });

  it('detects look-alike addresses', () => {
    const a = '0x1234567890abcdef1234567890abcdef1234abcd';
    const b = '0x1234000000000000000000000000000000ffabcd';
    expect(isLookalike(a, b)).toBe(true);
    expect(isLookalike(a, a.toUpperCase().replace('0X', '0x'))).toBe(false); // same address
    expect(isLookalike(a, '0x9999567890abcdef1234567890abcdef1234abcd')).toBe(false);
    expect(addressKey('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  });
});

describe('ownership signatures', () => {
  const account = privateKeyToAccount(PK);
  const msg = challengeMessage({ address: account.address, nonce: 'abc123', purpose: 'appeal', issuedAt: '2026-10-14T00:00:00Z', expiresAt: '2026-10-14T00:15:00Z' });

  it('verifies EIP-191 personal_sign', async () => {
    const sig = await account.signMessage({ message: msg });
    expect(await verifyOwnership(account.address, msg, sig)).toBe(true);
    expect(await verifyOwnership('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', msg, sig)).toBe(false);
    expect(await verifyOwnership(account.address, `${msg}x`, sig)).toBe(false);
    expect(await verifyOwnership(account.address, msg, '0x1234')).toBe(false);
  });

  it('verifies TRON signMessageV2 signatures produced by TronWeb', async () => {
    const tw = new TronWeb({ fullHost: 'http://127.0.0.1:1' });
    const tronAddr = TronWeb.address.fromPrivateKey(PK.slice(2)) as string;
    expect(tronAddr).toBe(hexToTron(account.address));
    const sig = tw.trx.signMessageV2(msg, PK.slice(2));
    expect(await recoverSigner('tron', msg, sig)).toBe(tronAddr);
    expect(await verifyOwnership(tronAddr, msg, sig)).toBe(true);
    expect(await tw.trx.verifyMessageV2(msg, sig)).toBe(tronAddr);
    expect(await verifyOwnership(USDT_TRON, msg, sig)).toBe(false);
    // an EIP-191 signature must not pass as a TRON one
    expect(await verifyOwnership(tronAddr, msg, await account.signMessage({ message: msg }))).toBe(false);
  });
});

describe('money', () => {
  it('parses dollars with token precision (L1-6)', () => {
    expect(parseUnits('12.34')).toBe(12_340_000n);
    expect(parseUnits('$1,000')).toBe(1_000_000_000n);
    expect(parseUnits('0.000001')).toBe(1n);
    expect(() => parseUnits('0.0000001')).toThrow();
    expect(() => parseUnits('-1')).toThrow();
    expect(formatUnits(12_340_000n)).toBe('12.34');
    expect(formatUsd(1_234_567_890n)).toBe('$1,234.57');
  });

  it('formats the naira reference value', () => {
    expect(formatNairaReference(parseUnits('10'), { ngnPerUsd: '1530.25', source: 'x', asOf: 'now' })).toBe('₦15,302.50');
  });
});

describe('fees', () => {
  it('matches the contract fee formula and applies dollar caps via feeBps', () => {
    expect(onChainFee(parseUnits('100'), 100)).toBe(parseUnits('1'));
    const small = escrowFeeTerms(parseUnits('1000'), DEFAULT_FEE_SCHEDULE.l2);
    expect(small).toEqual({ feeBps: 100, feeUnits: parseUnits('10') });
    const big = escrowFeeTerms(parseUnits('20000'), DEFAULT_FEE_SCHEDULE.l2);
    expect(big.feeUnits <= parseUnits('50')).toBe(true);
    expect(big.feeBps).toBe(25);
  });

  it('quotes L2 split fees with the client topping up half', () => {
    const q = quoteEscrowFee('L2', parseUnits('1000'), DEFAULT_FEE_SCHEDULE, true);
    expect(q.payerFundsUnits).toBe(q.amountUnits);
    expect(q.payeeReceivesUnits + q.feeUnits).toBe(q.amountUnits);
    // freelancer receives roughly amount - half the fee
    expect(q.payeeReceivesUnits > parseUnits('994')).toBe(true);
  });

  it('charges nothing between Backstop users and a flat fee on external USDT', () => {
    expect(quoteSendFee({ internal: true, token: 'USDT' })).toBe(0n);
    expect(quoteSendFee({ internal: false, token: 'USDT' })).toBe(parseUnits('1'));
    expect(quoteSendFee({ internal: false, token: 'USDC' })).toBe(0n);
  });
});

describe('escrow helpers', () => {
  const base: EscrowView = { status: 'delivered', deliverBy: 1000, holdUntil: 2000, disputedAt: null, autoRelease: true, arbiterTimeout: 100, feeOwed: 0n, feeCollected: false };

  it('mirrors the dispute / releaseAfterHold time boundary', () => {
    expect(allowedActions(base, 'payer', 1999)).toContain('dispute');
    expect(allowedActions(base, 'anyone', 1999)).not.toContain('releaseAfterHold');
    expect(allowedActions(base, 'payer', 2000)).not.toContain('dispute');
    expect(allowedActions(base, 'anyone', 2000)).toContain('releaseAfterHold');
  });

  it('mirrors the arbiter timeout boundary', () => {
    const d: EscrowView = { ...base, status: 'disputed', disputedAt: 5000 };
    expect(allowedActions(d, 'arbiter', 5099)).toEqual(['resolveRelease', 'resolveRefund']);
    expect(allowedActions(d, 'arbiter', 5100)).toEqual(['refundAfterArbiterTimeout']);
  });

  it('only lets the payee dispute from Funded before deliverBy (D4)', () => {
    const f: EscrowView = { ...base, status: 'funded', holdUntil: null };
    expect(allowedActions(f, 'payee', 1000)).toContain('dispute');
    expect(allowedActions(f, 'payee', 1001)).not.toContain('dispute');
    expect(allowedActions(f, 'payer', 1001)).toContain('reclaimAfterDeadline');
  });

  it('derives distinct orderRefs per tenant and payment', () => {
    expect(orderRefFor(1, 'a')).not.toBe(orderRefFor(1, 'b'));
    expect(orderRefFor(1, 'a')).not.toBe(orderRefFor(2, 'a'));
    expect(orderRefFor(1, 'a')).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('time', () => {
  it('skips weekends and holidays', () => {
    const fri = new Date('2026-10-16T10:00:00Z');
    expect(addBusinessDays(fri, 1).toISOString()).toBe('2026-10-19T10:00:00.000Z');
    expect(addBusinessDays(fri, 1, new Set(['2026-10-19'])).toISOString()).toBe('2026-10-20T10:00:00.000Z');
  });

  it('adds business hours within 09:00-17:00 Lagos', () => {
    // Friday 15:00 Lagos (14:00Z) + 4h -> Monday 11:00 Lagos (10:00Z)
    expect(addBusinessHours(new Date('2026-10-16T14:00:00Z'), 4).toISOString()).toBe('2026-10-19T10:00:00.000Z');
  });
});

describe('text rules', () => {
  it('blocks contact details in trade chat', () => {
    expect(scanForContactDetails('call me 0803 123 4567').blocked).toBe(true);
    expect(scanForContactDetails('zero eight zero three one two three four five six seven').blocked).toBe(true);
    expect(scanForContactDetails('email ada@example.com').kinds).toContain('email');
    expect(scanForContactDetails('message me on whatsapp').blocked).toBe(true);
    expect(scanForContactDetails('I have sent 150,000 naira, please confirm').blocked).toBe(false);
  });

  it('matches names across order, case and initials', () => {
    expect(matchNames('Ada Chioma Okafor', 'OKAFOR ADA CHIOMA')).toBe('exact');
    expect(matchNames('Ada Okafor', 'OKAFOR ADA CHIOMA')).toBe('strong');
    expect(matchNames('Ada C. Okafor', 'Okafor Ada Chioma')).toBe('strong');
    expect(namesAgree('Ada Okafor', 'Bola Okafor')).toBe(false);
  });

  it('fills reason templates', () => {
    expect(explainReason('invalid_address', { network: 'TRON' }).body).toContain('TRON');
  });

  it('round-trips versioned rules with bigints', () => {
    expect(deserializeRules(serializeRules(DEFAULT_RULES))).toEqual(DEFAULT_RULES);
  });
});
