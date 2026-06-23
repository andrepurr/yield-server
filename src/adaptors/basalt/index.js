// Basalt Vault — delta-neutral GMX v2 BTC/USD yield on Arbitrum.
//
// DRAFT. yield-server only accepts an adapter once the protocol is already listed
// on the TVL page (DefiLlama/DefiLlama-Adapters), and it only surfaces pools with
// > $10k TVL. Basalt is currently in its personal-capital test stage (~$3 TVL), so
// this file is a ready-to-fire scaffold, not yet submittable.
//
// The whole strategy is represented as ONE aggregate pool (not one per NFT vault).
// tvlUsd  = net equity of every vault (GM collateral - WBTC debt), priced on-chain.
// apyBase = realized return (aggregate NAV vs aggregate cost basis) annualized by
//           protocol age. Once there is meaningful TVL and history this should be
//           swapped for a share-price delta over a fixed trailing window (e.g. 7d).

const sdk = require('@defillama/sdk');
const utils = require('../utils');

const CHAIN = 'Arbitrum';
const FACTORY = '0x08e466fb09617d16ed27da9ea43ba601665f3b89'; // VaultCoreNftFactory
const DOLOMITE = '0x6Bd780E7fDf01D77e4d475c821f1e7AE05409072'; // DolomiteMargin
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'; // deposit asset

const GM_MARKET = 32;
const WBTC_MARKET = 4;
const ISO_ACCOUNT = 100;
const ZERO = '0x0000000000000000000000000000000000000000';
const DEPLOY_TS = Date.parse('2026-05-08T00:00:00Z') / 1000; // Deployment 6

const abis = {
  nextTokenId: 'uint256:nextTokenId',
  vaultByTokenId: 'function vaultByTokenId(uint256) view returns (address)',
  basaltState: 'function basaltState() view returns (address)',
  dolomiteIsolationVault: 'function dolomiteIsolationVault() view returns (address)',
  totalDepositedUsdE18: 'uint256:totalDepositedUsdE18',
  getAccountWei:
    'function getAccountWei((address owner, uint256 number) account, uint256 market) view returns ((bool sign, uint256 value))',
  getMarketPrice: 'function getMarketPrice(uint256 market) view returns ((uint256 value))',
};

const call = async (target, abi, params = []) =>
  (await sdk.api.abi.call({ target, abi, params, chain: 'arbitrum' })).output;

const multiCall = async (abi, calls) =>
  (await sdk.api.abi.multiCall({ abi, calls, chain: 'arbitrum' })).output.map((r) => r.output);

const apy = async () => {
  const n = Number(await call(FACTORY, abis.nextTokenId));
  if (!n) return [];

  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const vaults = await multiCall(abis.vaultByTokenId, ids.map((id) => ({ target: FACTORY, params: [id] })));
  const states = await multiCall(abis.basaltState, vaults.map((target) => ({ target })));
  const isos = await multiCall(abis.dolomiteIsolationVault, states.map((target) => ({ target })));

  // Keep only vaults that actually hold a Dolomite position, with their cost basis.
  const live = [];
  for (let i = 0; i < n; i++) {
    if (isos[i] && isos[i].toLowerCase() !== ZERO) live.push({ iso: isos[i], state: states[i] });
  }
  if (!live.length) return [];

  const [gmWei, wbtcWei, gmPrice, wbtcPrice, costs] = await Promise.all([
    multiCall(abis.getAccountWei, live.map((v) => ({ target: DOLOMITE, params: [{ owner: v.iso, number: ISO_ACCOUNT }, GM_MARKET] }))),
    multiCall(abis.getAccountWei, live.map((v) => ({ target: DOLOMITE, params: [{ owner: v.iso, number: ISO_ACCOUNT }, WBTC_MARKET] }))),
    call(DOLOMITE, abis.getMarketPrice, [GM_MARKET]),
    call(DOLOMITE, abis.getMarketPrice, [WBTC_MARKET]),
    multiCall(abis.totalDepositedUsdE18, live.map((v) => ({ target: v.state }))),
  ]);

  const gmP = BigInt(gmPrice.value);
  const wbtcP = BigInt(wbtcPrice.value);

  let nav36 = 0n; // net equity, 36 decimals
  let cost18 = 0n; // cumulative deposits, 18 decimals
  for (let i = 0; i < live.length; i++) {
    const gm = gmWei[i];
    const wb = wbtcWei[i];
    const gmCollateral = gm.sign ? BigInt(gm.value) : 0n;
    const wbtcDebt = !wb.sign ? BigInt(wb.value) : 0n;
    const wbtcSurplus = wb.sign ? BigInt(wb.value) : 0n;
    nav36 += gmCollateral * gmP + wbtcSurplus * wbtcP - wbtcDebt * wbtcP;
    cost18 += BigInt(costs[i]);
  }

  const tvlUsd = Number(nav36) / 1e36;
  const costUsd = Number(cost18) / 1e18;

  // Realized return annualized by protocol age. NOTE: totalDepositedUsd is gross of
  // withdrawals, so this under-states APY when capital has been pulled — fine for a
  // draft, replace with a trailing share-price delta at launch.
  const years = Math.max((Date.now() / 1000 - DEPLOY_TS) / (365 * 86400), 1 / 365);
  const apyBase = costUsd > 0 ? ((tvlUsd / costUsd - 1) / years) * 100 : 0;

  return [
    {
      pool: `${FACTORY}-arbitrum`,
      chain: CHAIN,
      project: 'basalt',
      symbol: utils.formatSymbol('USDC'),
      tvlUsd,
      apyBase,
      underlyingTokens: [USDC],
      poolMeta: 'Delta-neutral GMX v2 BTC/USD — aggregate of all Basalt vaults',
    },
  ];
};

module.exports = {
  timetravel: false,
  apy,
  url: 'https://basalt.finance',
};
