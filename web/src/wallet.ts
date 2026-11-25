// Stellar Wallets Kit behind the page's WalletPort. Modules are listed one by one:
// no WalletConnect, Lobstr, Ledger or Trezor code. The page draws its own wallet list; the kit's modal is never opened.
import { StellarWalletsKit } from '@creit.tech/stellar-wallets-kit/sdk';
import { Networks } from '@creit.tech/stellar-wallets-kit/types';
import { VarialModule } from '@creit.tech/stellar-wallets-kit/modules/varial';
import { xBullModule } from '@creit.tech/stellar-wallets-kit/modules/xbull';
import { AlbedoModule } from '@creit.tech/stellar-wallets-kit/modules/albedo';
import { HanaModule } from '@creit.tech/stellar-wallets-kit/modules/hana';
import { RabetModule } from '@creit.tech/stellar-wallets-kit/modules/rabet';
import type { WalletInfo, WalletPort } from './flow.ts';

export function kitWallet(): WalletPort {
  StellarWalletsKit.init({
    modules: [new VarialModule(), new xBullModule(), new AlbedoModule(), new HanaModule(), new RabetModule()],
    network: Networks.TESTNET,
  });
  return {
    async list(): Promise<WalletInfo[]> {
      const ws = await StellarWalletsKit.refreshSupportedWallets();
      return ws.map((w) => ({ id: w.id, name: w.name, available: w.isAvailable, url: w.url }));
    },
    async connect(id) {
      StellarWalletsKit.setWallet(id);
      return (await StellarWalletsKit.fetchAddress()).address;
    },
    async network() {
      try {
        return (await StellarWalletsKit.getNetwork()).networkPassphrase;
      } catch {
        // Most wallets cannot say (code -3, unsupported); the signature check before sending covers them.
        return null;
      }
    },
    signTransaction: (xdr, opts) => StellarWalletsKit.signTransaction(xdr, opts),
  };
}
