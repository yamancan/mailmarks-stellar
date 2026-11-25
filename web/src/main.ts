import './tokens.css';
import { Chain, friendbot, loadDeployment } from './chain.ts';
import { Flow } from './flow.ts';
import { intro } from './intro.ts';
import { mount } from './view.ts';
import { kitWallet } from './wallet.ts';

const flow = new Flow({
  loadDeployment: () => loadDeployment(),
  chain: (dep) => new Chain(dep),
  wallet: kitWallet(),
  fund: (address) => friendbot(address),
});
mount(flow);
void flow.start();
// After the intro: the error's action when the page could not start, else the drop zone (the first one on screen).
// checkVisibility is missing before Safari 17.4: an element with no boxes is not on screen.
intro(() =>
  ['error-action', 'drop']
    .map((id) => document.getElementById(id))
    .find((el) => el && (el.checkVisibility?.() ?? !!el.getClientRects().length))
    ?.focus(),
);
