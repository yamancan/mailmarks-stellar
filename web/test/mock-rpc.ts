// A fake Soroban RPC behind globalThis.fetch: answers JSON-RPC per method with XDR built by the sdk, and records
// every request so tests can assert the page talks to nothing but the deployment's rpcUrl.
import { Address, Keypair, SorobanDataBuilder, xdr } from '@stellar/stellar-sdk';
import { approvalKey } from '../src/chain.ts';
import { hexToBytes } from '../../shared/encode.js';

export type Handler = (params: any) => unknown;
export interface Rpc {
  calls: { url: string; method: string; params: any }[];
  restore(): void;
}

/** A handler that throws is answered as a JSON-RPC error; `'offline'` makes fetch itself reject. */
/** `'hang'` never answers (until the request's abort signal fires, as a real stalled connection would). */
export function mockRpc(handlers: Record<string, Handler | 'offline' | 'hang'>): Rpc {
  const real = globalThis.fetch;
  const calls: Rpc['calls'] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? (input as Request).body));
    calls.push({ url, method: body.method, params: body.params });
    const h = handlers[body.method];
    if (h === 'offline') throw new TypeError('fetch failed');
    if (h === 'hang') {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }
    if (!h) return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: `no mock for ${body.method}` } });
    try {
      return json({ jsonrpc: '2.0', id: body.id, result: h(body.params) });
    } catch (e) {
      return json({ jsonrpc: '2.0', id: body.id, error: { code: -32600, message: String((e as Error).message) } });
    }
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = real) };
}

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });

export interface AccountOpts {
  balance: bigint;
  seq?: bigint;
  numSubEntries?: number;
  selling?: bigint;
  sponsoring?: number;
  sponsored?: number;
}

export function accountEntry(address: string, o: AccountOpts): string {
  const v2 = new xdr.AccountEntryExtensionV2({
    numSponsored: o.sponsored ?? 0,
    numSponsoring: o.sponsoring ?? 0,
    signerSponsoringIDs: [],
    ext: xdr.AccountEntryExtensionV2Ext.v0(),
  });
  const v1 = new xdr.AccountEntryExtensionV1({
    liabilities: new xdr.Liabilities({ buying: 0n, selling: o.selling ?? 0n }),
    ext: xdr.AccountEntryExtensionV1Ext.v2(v2),
  });
  const acc = new xdr.AccountEntry({
    accountId: Keypair.fromPublicKey(address).xdrPublicKey(),
    balance: o.balance,
    seqNum: o.seq ?? 100n,
    numSubEntries: o.numSubEntries ?? 0,
    inflationDest: null,
    flags: 0,
    homeDomain: '',
    thresholds: new Uint8Array([1, 0, 0, 0]),
    signers: [],
    ext: xdr.AccountEntryExt.v1(v1),
  });
  return xdr.LedgerEntryData.account(acc).toXdr('base64');
}

export function approvalEntry(registry: string, artifactHex: string, rec: { wallet: string; nullifier: string; ledger: number }): string {
  const val = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('ledger'), val: xdr.ScVal.scvU32(rec.ledger) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('nullifier'), val: xdr.ScVal.scvBytes(hexToBytes(rec.nullifier)) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('wallet'), val: new Address(rec.wallet).toScVal() }),
  ]);
  const entry = new xdr.ContractDataEntry({
    ext: xdr.ExtensionPoint.v0(),
    contract: new Address(registry).toScAddress(),
    key: approvalKey(artifactHex),
    durability: xdr.ContractDataDurability.persistent,
    val,
  });
  return xdr.LedgerEntryData.contractData(entry).toXdr('base64');
}

/** getLedgerEntries answer: one entry per requested key that `lookup` knows (by the key's base64). */
export function ledgerEntries(lookup: (key: xdr.LedgerKey) => string | undefined, liveUntil = 5_000_000): Handler {
  return (params) => ({
    latestLedger: 1000,
    entries: (params.keys as string[]).flatMap((k) => {
      const v = lookup(xdr.LedgerKey.fromXdr(k, 'base64'));
      return v ? [{ key: k, xdr: v, lastModifiedLedgerSeq: 900, liveUntilLedgerSeq: liveUntil }] : [];
    }),
  });
}

export function simSuccess(retval: xdr.ScVal, minResourceFee = 123_456): unknown {
  return {
    latestLedger: 1000,
    minResourceFee: String(minResourceFee),
    transactionData: new SorobanDataBuilder().setResourceFee(minResourceFee).build().toXdr('base64'),
    results: [{ auth: [], xdr: retval.toXdr('base64') }],
    cost: { cpuInsns: '0', memBytes: '0' },
  };
}

export const simError = (text: string) => ({ latestLedger: 1000, error: text });

export function txResult(code: string): string {
  const result = (xdr.TransactionResultResult as any)[code]();
  return new xdr.TransactionResult({ feeCharged: 100n, result, ext: xdr.TransactionResultExt.v0() }).toXdr('base64');
}
