const WALLETS = {
  USDT: {
    address: 'TC25PoXQYxFzSbMNoFFgVwSna8yBLTxyQh',
    network: 'TRC20',
  },
  BTC: {
    address: '1L4s7WG9X24F8inKsmLWx5GJQzBgm3AbDp',
    network: 'Bitcoin',
  },
  LTC: {
    address: 'LMW6iLGT61rv1rdWFnUP1gEcEpjnM94u1q',
    network: 'Litecoin',
  },
  ETH: {
    address: '0x32a0cc4a7390a9c8a5e21c4e1c92e811c8171699',
    network: 'ERC20',
  },
};

const TX_FORMATS = {
  USDT: /^(0x[a-fA-F0-9]{64}|[a-fA-F0-9]{64})$/, // ERC20 or TRC20 tx hash
  BTC: /^[a-fA-F0-9]{64}$/,
  LTC: /^[a-fA-F0-9]{64}$/,
  ETH: /^0x[a-fA-F0-9]{64}$/,
};

function explorerUrl(coin, txReference) {
  if (!txReference) return null;
  switch (coin) {
    case 'BTC': return `https://www.blockchain.com/explorer/transactions/btc/${txReference}`;
    case 'ETH': return `https://etherscan.io/tx/${txReference}`;
    case 'LTC': return `https://blockchair.com/litecoin/transaction/${txReference}`;
    case 'USDT': return txReference.startsWith('0x')
      ? `https://etherscan.io/tx/${txReference}`
      : `https://tronscan.org/#/transaction/${txReference}`;
    default: return null;
  }
}

function isValidTxFormat(coin, txReference) {
  const pattern = TX_FORMATS[coin];
  return pattern ? pattern.test((txReference || '').trim()) : false;
}

module.exports = { WALLETS, explorerUrl, isValidTxFormat };
