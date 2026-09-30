// ---------------------------------------------------------------------------
// Fill in YOUR real wallet addresses below. These are shown to users on the
// Billing page so they know where to send payment, and used by the admin
// panel to build a block-explorer link for manually verifying a transaction.
// ---------------------------------------------------------------------------

const WALLETS = {
  USDT: {
    address: 'PUT-YOUR-USDT-ADDRESS-HERE',
    network: 'TRC20', // or 'ERC20' — must match whichever address you paste above
  },
  BTC: {
    address: 'PUT-YOUR-BTC-ADDRESS-HERE',
    network: 'Bitcoin',
  },
  LTC: {
    address: 'PUT-YOUR-LTC-ADDRESS-HERE',
    network: 'Litecoin',
  },
  ETH: {
    address: 'PUT-YOUR-ETH-ADDRESS-HERE',
    network: 'ERC20',
  },
};

// Loose format checks only — this confirms the transaction ID at least LOOKS
// like a real hash for that chain before it's submitted. It does NOT check
// the blockchain itself (that requires a paid explorer API per chain), so a
// human admin still needs to manually confirm the transaction actually
// happened and paid the right amount to the right address.
const TX_FORMATS = {
  USDT: /^(0x[a-fA-F0-9]{64}|[a-fA-F0-9]{64})$/, // ERC20 or TRC20 tx hash
  BTC: /^[a-fA-F0-9]{64}$/,
  LTC: /^[a-fA-F0-9]{64}$/,
  ETH: /^0x[a-fA-F0-9]{64}$/,
};

// Builds a block-explorer link so an admin can look the transaction up
// with one tap instead of pasting it into a search engine manually.
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
