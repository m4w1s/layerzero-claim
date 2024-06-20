import { readFileSync, writeFileSync } from 'node:fs';
import pMap from 'p-map';
import { ethers } from 'ethers';
import { gotScraping } from 'got-scraping';

//-------------------- USER CONFIG START --------------------//

/**
 * Включение или отключение функций.
 */
const features = {
  claim: true, // Клейм монеты
  withdraw: true, // Вывод монеты
};
/**
 * Сеть.
 *
 * Варианты: arbitrum, bsc, avalanche, base, ethereum, optimism, polygon
 *
 * ПРОВЕРЕНО ТОЛЬКО НА СЕТИ ARBITRUM!
 */
const chain = 'arbitrum';
/**
 * Список RPC.
 */
const rpcUrls = [
  'https://rpc.ankr.com/arbitrum',
  'https://arbitrum.llamarpc.com',
  'https://arbitrum.drpc.org',
  'https://arbitrum.meowrpc.com',
];
/**
 * Цена газа для клейма и для вывода монет.
 */
const gasPrice = {
  claim: {
    maxFeePerGas: ethers.parseUnits('10', 'gwei'),
    maxPriorityFeePerGas: ethers.parseUnits('3', 'gwei'),
  },
  withdraw: {
    maxFeePerGas: ethers.parseUnits('10', 'gwei'),
    maxPriorityFeePerGas: ethers.parseUnits('3', 'gwei'),
  },
};
/**
 * Количество потоков = количество одновременных кошельков в обработке.
 */
const concurrency = 3;
/**
 * Задержка между onchain операциями в каждом потоке.
 */
const delay = {
  min: 10_000, // 10 секунд
  max: 30_000, // 30 секунд
};

//-------------------- USER CONFIG END --------------------//

const providers = rpcUrls.map((url) => new ethers.JsonRpcProvider(url));
const allocations = readAllocations();
const wallets = readWallets();
const claimContracts = {
  arbitrum: '0xB09F16F625B363875e39ADa56C03682088471523',
  bsc: '0x9c26831a80Ef7Fb60cA940EB9AA22023476B3468',
  avalanche: '0x9FE91fE878b35c8a3C8c5f8c18c68e5c85FeD144',
  base: '0xf19ccb20726Eab44754A59eFC4Ad331e3bF4F248',
  ethereum: '0xC28C2b2F5A9B2aF1ad5878E5b1AF5F9bAEa2F971',
  optimism: '0x3Ef4abDb646976c096DF532377EFdfE0E6391ac3',
  polygon: '0x9c26831a80Ef7Fb60cA940EB9AA22023476B3468',
};

pMap(wallets, processWallet, { concurrency, stopOnError: false })
  .then(() => {
    console.log('All wallets processed!');
  })
  .catch((err) => {
    console.error(err);
  });

async function processWallet({ wallet, withdrawAddress, proxy }) {
  const balance = await Promise.any(
    providers.map((provider) => getTokenContract(provider).balanceOf.staticCall(wallet.address)),
  );

  if (features.claim) {
    const allocation = await getAllocation(wallet, proxy);

    if (balance > 0n) {
      allocation.isClaimed = true;
      writeAllocations();
    }

    console.log(`\x1b[36m[${wallet.address}] Allocation of ${ethers.formatUnits(allocation.amount, 18)} ZRO loaded!\x1b[0m`);
    console.log(`\x1b[36m[${wallet.address}] Claiming...\x1b[0m`);

    await claim(wallet, allocation);

    await sleep(delay.min, delay.max);
  }

  if (features.withdraw) {
    if (withdrawAddress) {
      console.log(`\x1b[36m[${wallet.address}] Withdraw...\x1b[0m`);

      if (balance <= 0n) {
        console.log(`[${wallet.address}] Nothing to withdraw!`);

        return;
      }

      await withdraw(wallet, withdrawAddress, balance);

      await sleep(delay.min, delay.max);
    }
  }
}

async function withdraw(wallet, withdrawAddress, amount) {
  let nonce;

  for (let attempts = 4; attempts >= 0; attempts--) {
    try {
      if (nonce == null) {
        nonce = await Promise.any(
          providers.map((provider) => provider.getTransactionCount(wallet.address)),
        );
      }

      const transaction = await Promise.any(
        providers.map((provider) => {
          return getTokenContract(wallet.connect(provider)).transfer(
            withdrawAddress,
            amount,
            {
              ...gasPrice.withdraw,
              nonce,
            },
          );
        }),
      );

      await transaction.wait(1, 60_000);

      break;
    } catch (e) {
      if (e instanceof AggregateError) {
        e = e.errors[0];
      }

      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${wallet.address}] Withdraw error${attempts ? '. Try again in 3 sec' : ''}\x1b[0m`);
      console.log();

      if (attempts) {
        await sleep(3000);

        continue;
      }

      throw e;
    }
  }

  console.log(`\x1b[32m[${wallet.address}] Withdrawn ${ethers.formatUnits(amount, 18)} ZRO to ${withdrawAddress} successfully!\x1b[0m`);
}

async function claim(wallet, allocation) {
  if (allocation.isClaimed) {
    console.log(`[${wallet.address}] Already claimed!`);

    return;
  }

  const currency = 2;
  const ethValue = (await getAmountToDonate(allocation))[currency];

  let nonce;

  for (let attempts = 4; attempts >= 0; attempts--) {
    try {
      if (nonce == null) {
        nonce = await Promise.any(
          providers.map((provider) => provider.getTransactionCount(wallet.address)),
        );
      }

      const transaction = await Promise.any(
        providers.map((provider) => {
          return getClaimContract(wallet.connect(provider)).donateAndClaim(
            currency,
            ethValue,
            allocation.amount,
            allocation.proof.split('|'),
            wallet.address,
            '0x',
            {
              ...gasPrice.claim,
              nonce,
              value: ethValue,
            },
          );
        }),
      );

      await transaction.wait(1, 60_000);

      allocation.isClaimed = true;
      writeAllocations();

      break;
    } catch (e) {
      if (e instanceof AggregateError) {
        e = e.errors[0];
      }

      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${wallet.address}] Claim error${attempts ? '. Try again in 3 sec' : ''}\x1b[0m`);
      console.log();

      if (attempts) {
        await sleep(3000);

        continue;
      }

      throw e;
    }
  }

  console.log(`\x1b[32m[${wallet.address}] Claimed ${ethers.formatUnits(allocation.amount, 18)} ZRO successfully!\x1b[0m`);
}

function getAmountToDonate(allocation) {
  return Promise.any(
    providers.map(async (provider) => {
      const data = await provider.call({
        to: '0xd6b6a6701303b5ea36fa0edf7389b562d8f894db',
        data: '0xd6d754db' + BigInt(allocation.amount).toString(16).padStart(64, '0'),
      });

      return ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256', 'uint256'], data);
    }),
  );
}

async function getAllocation(wallet, proxy) {
  const address = wallet.address.toLowerCase();

  let allocation = allocations.find((alloc) => alloc.address.toLowerCase() === address);

  if (allocation) {
    return allocation;
  }

  try {
    const body = await gotScraping.get({
      url: 'https://www.layerzero.foundation/api/proof/' + address,
      headers: {
        'Referer': 'https://www.layerzero.foundation/claim/' + address,
      },
      proxyUrl: proxy,
      throwHttpErrors: true,
      resolveBodyOnly: true,
      responseType: 'json',
    });

    if (!body.amount || body.amount === '0') {
      console.error(`\x1b[31m[${wallet.address}] Not eligible!\x1b[0m`);

      const err = new Error('Not eligible!');
      err.silent = true;

      throw err;
    }

    allocation = {
      address,
      amount: body.amount,
      proof: body.proof,
    };

    if (!allocation.amount || !allocation.proof) {
      throw new Error('Malformed eligibility response: ' + JSON.stringify(body));
    }

    const ethDonate = (await getAmountToDonate(allocation))[2];
    const ethBalance = await Promise.any(
      providers.map((provider) => provider.getBalance(wallet.address)),
    );

    allocation.ethBalance = ethers.formatEther(ethBalance);
    allocation.ethDonate = ethers.formatEther(ethDonate);

    if (ethDonate > ethBalance) {
      allocation.insufficientEth = ethers.formatEther(ethDonate - ethBalance);
    }
  } catch (e) {
    if (!e.silent) {
      console.log();
      console.error('\x1b[31m' + e.message + '\x1b[0m');
      console.error(`\x1b[31m[${wallet.address}] Allocation loading error\x1b[0m`);
      console.log();
    }

    throw e;
  }

  allocations.push(allocation);
  writeAllocations();

  return allocation;
}

function readWallets() {
  const wallets = readFileSync(new URL('./data/wallets.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(isNonEmptyLine);
  const proxies = readFileSync(new URL('./data/proxies.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(isNonEmptyLine);

  return wallets.map((wallet, index) => {
    const [privateKey, withdrawAddress] = wallet.trim().split(':');
    let proxy = proxies[index]?.trim() || undefined;

    if (proxy) {
      if (!proxy.includes('@')) {
        const [host, port, username, password] = proxy.split(':');

        proxy = `http://${username ? `${username}:${password}@` : ''}${host}:${port}`;
      }

      if (!proxy.includes('://')) {
        proxy = 'http://' + proxy;
      }

      proxy = new URL(proxy).href.replace(/\/$/, '');
    }

    return {
      wallet: new ethers.Wallet(privateKey),
      withdrawAddress: ethers.isAddress(withdrawAddress) ? withdrawAddress : undefined,
      proxy,
    };
  });

  function isNonEmptyLine(line) {
    line = line.trim();

    return line && !line.startsWith('#');
  }
}

function readAllocations() {
  try {
    const data = readFileSync(new URL('./data/allocations.json', import.meta.url), 'utf8');
    const json = JSON.parse(data);

    if (Array.isArray(json)) {
      return json;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('\x1b[33mwarn!\x1b[0m \x1b[34m[reading data/allocations.json]\x1b[0m', e.message);
    }
  }

  return [];
}

function writeAllocations() {
  const data = JSON.stringify(allocations, null, 2);

  writeFileSync(new URL('./data/allocations.json', import.meta.url), data, 'utf8');
}

function sleep(min, max) {
  const ms = max != null
    ? Math.floor(Math.random() * (max - min) ) + min
    : min;

  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTokenContract(runner) {
  const CONTRACT_ADDRESS = '0x6985884C4392D348587B19cb9eAAf157F13271cd';
  const ABI = JSON.parse('[{"inputs":[{"internalType":"string","name":"_name","type":"string"},{"internalType":"string","name":"_symbol","type":"string"},{"internalType":"address","name":"_lzEndpoint","type":"address"},{"internalType":"address","name":"_delegate","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},{"inputs":[{"internalType":"address","name":"target","type":"address"}],"name":"AddressEmptyCode","type":"error"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"AddressInsufficientBalance","type":"error"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"allowance","type":"uint256"},{"internalType":"uint256","name":"needed","type":"uint256"}],"name":"ERC20InsufficientAllowance","type":"error"},{"inputs":[{"internalType":"address","name":"sender","type":"address"},{"internalType":"uint256","name":"balance","type":"uint256"},{"internalType":"uint256","name":"needed","type":"uint256"}],"name":"ERC20InsufficientBalance","type":"error"},{"inputs":[{"internalType":"address","name":"approver","type":"address"}],"name":"ERC20InvalidApprover","type":"error"},{"inputs":[{"internalType":"address","name":"receiver","type":"address"}],"name":"ERC20InvalidReceiver","type":"error"},{"inputs":[{"internalType":"address","name":"sender","type":"address"}],"name":"ERC20InvalidSender","type":"error"},{"inputs":[{"internalType":"address","name":"spender","type":"address"}],"name":"ERC20InvalidSpender","type":"error"},{"inputs":[],"name":"FailedInnerCall","type":"error"},{"inputs":[],"name":"InvalidDelegate","type":"error"},{"inputs":[],"name":"InvalidEndpointCall","type":"error"},{"inputs":[],"name":"InvalidLocalDecimals","type":"error"},{"inputs":[{"internalType":"bytes","name":"options","type":"bytes"}],"name":"InvalidOptions","type":"error"},{"inputs":[],"name":"LzTokenUnavailable","type":"error"},{"inputs":[{"internalType":"uint32","name":"eid","type":"uint32"}],"name":"NoPeer","type":"error"},{"inputs":[{"internalType":"uint256","name":"msgValue","type":"uint256"}],"name":"NotEnoughNative","type":"error"},{"inputs":[{"internalType":"address","name":"addr","type":"address"}],"name":"OnlyEndpoint","type":"error"},{"inputs":[{"internalType":"uint32","name":"eid","type":"uint32"},{"internalType":"bytes32","name":"sender","type":"bytes32"}],"name":"OnlyPeer","type":"error"},{"inputs":[],"name":"OnlySelf","type":"error"},{"inputs":[{"internalType":"address","name":"owner","type":"address"}],"name":"OwnableInvalidOwner","type":"error"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"OwnableUnauthorizedAccount","type":"error"},{"inputs":[{"internalType":"address","name":"token","type":"address"}],"name":"SafeERC20FailedOperation","type":"error"},{"inputs":[{"internalType":"bytes","name":"result","type":"bytes"}],"name":"SimulationResult","type":"error"},{"inputs":[{"internalType":"uint256","name":"amountLD","type":"uint256"},{"internalType":"uint256","name":"minAmountLD","type":"uint256"}],"name":"SlippageExceeded","type":"error"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"owner","type":"address"},{"indexed":true,"internalType":"address","name":"spender","type":"address"},{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"Approval","type":"event"},{"anonymous":false,"inputs":[{"components":[{"internalType":"uint32","name":"eid","type":"uint32"},{"internalType":"uint16","name":"msgType","type":"uint16"},{"internalType":"bytes","name":"options","type":"bytes"}],"indexed":false,"internalType":"struct EnforcedOptionParam[]","name":"_enforcedOptions","type":"tuple[]"}],"name":"EnforcedOptionSet","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"inspector","type":"address"}],"name":"MsgInspectorSet","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"guid","type":"bytes32"},{"indexed":false,"internalType":"uint32","name":"srcEid","type":"uint32"},{"indexed":true,"internalType":"address","name":"toAddress","type":"address"},{"indexed":false,"internalType":"uint256","name":"amountReceivedLD","type":"uint256"}],"name":"OFTReceived","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"guid","type":"bytes32"},{"indexed":false,"internalType":"uint32","name":"dstEid","type":"uint32"},{"indexed":true,"internalType":"address","name":"fromAddress","type":"address"},{"indexed":false,"internalType":"uint256","name":"amountSentLD","type":"uint256"},{"indexed":false,"internalType":"uint256","name":"amountReceivedLD","type":"uint256"}],"name":"OFTSent","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"previousOwner","type":"address"},{"indexed":true,"internalType":"address","name":"newOwner","type":"address"}],"name":"OwnershipTransferred","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"uint32","name":"eid","type":"uint32"},{"indexed":false,"internalType":"bytes32","name":"peer","type":"bytes32"}],"name":"PeerSet","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"preCrimeAddress","type":"address"}],"name":"PreCrimeSet","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"from","type":"address"},{"indexed":true,"internalType":"address","name":"to","type":"address"},{"indexed":false,"internalType":"uint256","name":"value","type":"uint256"}],"name":"Transfer","type":"event"},{"inputs":[],"name":"SEND","outputs":[{"internalType":"uint16","name":"","type":"uint16"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"SEND_AND_CALL","outputs":[{"internalType":"uint16","name":"","type":"uint16"}],"stateMutability":"view","type":"function"},{"inputs":[{"components":[{"internalType":"uint32","name":"srcEid","type":"uint32"},{"internalType":"bytes32","name":"sender","type":"bytes32"},{"internalType":"uint64","name":"nonce","type":"uint64"}],"internalType":"struct Origin","name":"origin","type":"tuple"}],"name":"allowInitializePath","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"owner","type":"address"},{"internalType":"address","name":"spender","type":"address"}],"name":"allowance","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"approvalRequired","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"pure","type":"function"},{"inputs":[{"internalType":"address","name":"spender","type":"address"},{"internalType":"uint256","name":"value","type":"uint256"}],"name":"approve","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint32","name":"_eid","type":"uint32"},{"internalType":"uint16","name":"_msgType","type":"uint16"},{"internalType":"bytes","name":"_extraOptions","type":"bytes"}],"name":"combineOptions","outputs":[{"internalType":"bytes","name":"","type":"bytes"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"decimalConversionRate","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"decimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"endpoint","outputs":[{"internalType":"contract ILayerZeroEndpointV2","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint32","name":"eid","type":"uint32"},{"internalType":"uint16","name":"msgType","type":"uint16"}],"name":"enforcedOptions","outputs":[{"internalType":"bytes","name":"enforcedOption","type":"bytes"}],"stateMutability":"view","type":"function"},{"inputs":[{"components":[{"internalType":"uint32","name":"srcEid","type":"uint32"},{"internalType":"bytes32","name":"sender","type":"bytes32"},{"internalType":"uint64","name":"nonce","type":"uint64"}],"internalType":"struct Origin","name":"","type":"tuple"},{"internalType":"bytes","name":"","type":"bytes"},{"internalType":"address","name":"_sender","type":"address"}],"name":"isComposeMsgSender","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint32","name":"_eid","type":"uint32"},{"internalType":"bytes32","name":"_peer","type":"bytes32"}],"name":"isPeer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"components":[{"internalType":"uint32","name":"srcEid","type":"uint32"},{"internalType":"bytes32","name":"sender","type":"bytes32"},{"internalType":"uint64","name":"nonce","type":"uint64"}],"internalType":"struct Origin","name":"_origin","type":"tuple"},{"internalType":"bytes32","name":"_guid","type":"bytes32"},{"internalType":"bytes","name":"_message","type":"bytes"},{"internalType":"address","name":"_executor","type":"address"},{"internalType":"bytes","name":"_extraData","type":"bytes"}],"name":"lzReceive","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"components":[{"components":[{"internalType":"uint32","name":"srcEid","type":"uint32"},{"internalType":"bytes32","name":"sender","type":"bytes32"},{"internalType":"uint64","name":"nonce","type":"uint64"}],"internalType":"struct Origin","name":"origin","type":"tuple"},{"internalType":"uint32","name":"dstEid","type":"uint32"},{"internalType":"address","name":"receiver","type":"address"},{"internalType":"bytes32","name":"guid","type":"bytes32"},{"internalType":"uint256","name":"value","type":"uint256"},{"internalType":"address","name":"executor","type":"address"},{"internalType":"bytes","name":"message","type":"bytes"},{"internalType":"bytes","name":"extraData","type":"bytes"}],"internalType":"struct InboundPacket[]","name":"_packets","type":"tuple[]"}],"name":"lzReceiveAndRevert","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[{"components":[{"internalType":"uint32","name":"srcEid","type":"uint32"},{"internalType":"bytes32","name":"sender","type":"bytes32"},{"internalType":"uint64","name":"nonce","type":"uint64"}],"internalType":"struct Origin","name":"_origin","type":"tuple"},{"internalType":"bytes32","name":"_guid","type":"bytes32"},{"internalType":"bytes","name":"_message","type":"bytes"},{"internalType":"address","name":"_executor","type":"address"},{"internalType":"bytes","name":"_extraData","type":"bytes"}],"name":"lzReceiveSimulate","outputs":[],"stateMutability":"payable","type":"function"},{"inputs":[],"name":"msgInspector","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"name","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint32","name":"","type":"uint32"},{"internalType":"bytes32","name":"","type":"bytes32"}],"name":"nextNonce","outputs":[{"internalType":"uint64","name":"nonce","type":"uint64"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"oApp","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"oAppVersion","outputs":[{"internalType":"uint64","name":"senderVersion","type":"uint64"},{"internalType":"uint64","name":"receiverVersion","type":"uint64"}],"stateMutability":"pure","type":"function"},{"inputs":[],"name":"oftVersion","outputs":[{"internalType":"bytes4","name":"interfaceId","type":"bytes4"},{"internalType":"uint64","name":"version","type":"uint64"}],"stateMutability":"pure","type":"function"},{"inputs":[],"name":"owner","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"uint32","name":"eid","type":"uint32"}],"name":"peers","outputs":[{"internalType":"bytes32","name":"peer","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"preCrime","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"components":[{"internalType":"uint32","name":"dstEid","type":"uint32"},{"internalType":"bytes32","name":"to","type":"bytes32"},{"internalType":"uint256","name":"amountLD","type":"uint256"},{"internalType":"uint256","name":"minAmountLD","type":"uint256"},{"internalType":"bytes","name":"extraOptions","type":"bytes"},{"internalType":"bytes","name":"composeMsg","type":"bytes"},{"internalType":"bytes","name":"oftCmd","type":"bytes"}],"internalType":"struct SendParam","name":"_sendParam","type":"tuple"}],"name":"quoteOFT","outputs":[{"components":[{"internalType":"uint256","name":"minAmountLD","type":"uint256"},{"internalType":"uint256","name":"maxAmountLD","type":"uint256"}],"internalType":"struct OFTLimit","name":"oftLimit","type":"tuple"},{"components":[{"internalType":"int256","name":"feeAmountLD","type":"int256"},{"internalType":"string","name":"description","type":"string"}],"internalType":"struct OFTFeeDetail[]","name":"oftFeeDetails","type":"tuple[]"},{"components":[{"internalType":"uint256","name":"amountSentLD","type":"uint256"},{"internalType":"uint256","name":"amountReceivedLD","type":"uint256"}],"internalType":"struct OFTReceipt","name":"oftReceipt","type":"tuple"}],"stateMutability":"view","type":"function"},{"inputs":[{"components":[{"internalType":"uint32","name":"dstEid","type":"uint32"},{"internalType":"bytes32","name":"to","type":"bytes32"},{"internalType":"uint256","name":"amountLD","type":"uint256"},{"internalType":"uint256","name":"minAmountLD","type":"uint256"},{"internalType":"bytes","name":"extraOptions","type":"bytes"},{"internalType":"bytes","name":"composeMsg","type":"bytes"},{"internalType":"bytes","name":"oftCmd","type":"bytes"}],"internalType":"struct SendParam","name":"_sendParam","type":"tuple"},{"internalType":"bool","name":"_payInLzToken","type":"bool"}],"name":"quoteSend","outputs":[{"components":[{"internalType":"uint256","name":"nativeFee","type":"uint256"},{"internalType":"uint256","name":"lzTokenFee","type":"uint256"}],"internalType":"struct MessagingFee","name":"msgFee","type":"tuple"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"renounceOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"components":[{"internalType":"uint32","name":"dstEid","type":"uint32"},{"internalType":"bytes32","name":"to","type":"bytes32"},{"internalType":"uint256","name":"amountLD","type":"uint256"},{"internalType":"uint256","name":"minAmountLD","type":"uint256"},{"internalType":"bytes","name":"extraOptions","type":"bytes"},{"internalType":"bytes","name":"composeMsg","type":"bytes"},{"internalType":"bytes","name":"oftCmd","type":"bytes"}],"internalType":"struct SendParam","name":"_sendParam","type":"tuple"},{"components":[{"internalType":"uint256","name":"nativeFee","type":"uint256"},{"internalType":"uint256","name":"lzTokenFee","type":"uint256"}],"internalType":"struct MessagingFee","name":"_fee","type":"tuple"},{"internalType":"address","name":"_refundAddress","type":"address"}],"name":"send","outputs":[{"components":[{"internalType":"bytes32","name":"guid","type":"bytes32"},{"internalType":"uint64","name":"nonce","type":"uint64"},{"components":[{"internalType":"uint256","name":"nativeFee","type":"uint256"},{"internalType":"uint256","name":"lzTokenFee","type":"uint256"}],"internalType":"struct MessagingFee","name":"fee","type":"tuple"}],"internalType":"struct MessagingReceipt","name":"msgReceipt","type":"tuple"},{"components":[{"internalType":"uint256","name":"amountSentLD","type":"uint256"},{"internalType":"uint256","name":"amountReceivedLD","type":"uint256"}],"internalType":"struct OFTReceipt","name":"oftReceipt","type":"tuple"}],"stateMutability":"payable","type":"function"},{"inputs":[{"internalType":"address","name":"_delegate","type":"address"}],"name":"setDelegate","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"components":[{"internalType":"uint32","name":"eid","type":"uint32"},{"internalType":"uint16","name":"msgType","type":"uint16"},{"internalType":"bytes","name":"options","type":"bytes"}],"internalType":"struct EnforcedOptionParam[]","name":"_enforcedOptions","type":"tuple[]"}],"name":"setEnforcedOptions","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"_msgInspector","type":"address"}],"name":"setMsgInspector","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"uint32","name":"_eid","type":"uint32"},{"internalType":"bytes32","name":"_peer","type":"bytes32"}],"name":"setPeer","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"_preCrime","type":"address"}],"name":"setPreCrime","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"sharedDecimals","outputs":[{"internalType":"uint8","name":"","type":"uint8"}],"stateMutability":"pure","type":"function"},{"inputs":[],"name":"symbol","outputs":[{"internalType":"string","name":"","type":"string"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"token","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"totalSupply","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"value","type":"uint256"}],"name":"transfer","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"from","type":"address"},{"internalType":"address","name":"to","type":"address"},{"internalType":"uint256","name":"value","type":"uint256"}],"name":"transferFrom","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"newOwner","type":"address"}],"name":"transferOwnership","outputs":[],"stateMutability":"nonpayable","type":"function"}]');

  return new ethers.Contract(CONTRACT_ADDRESS, ABI, runner);
}

function getClaimContract(runner) {
  const CONTRACT_ADDRESS = claimContracts[chain];

  if (!CONTRACT_ADDRESS) {
    throw new Error(`Invalid chain: ${chain}`);
  }

  const ABI = JSON.parse('[{"inputs":[{"internalType":"address","name":"_donateContract","type":"address"},{"internalType":"address","name":"_claimContract","type":"address"},{"internalType":"address","name":"_stargateUsdc","type":"address"},{"internalType":"address","name":"_stargateUsdt","type":"address"},{"internalType":"address","name":"_stargateNative","type":"address"}],"stateMutability":"nonpayable","type":"constructor"},{"inputs":[{"internalType":"address","name":"target","type":"address"}],"name":"AddressEmptyCode","type":"error"},{"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"AddressInsufficientBalance","type":"error"},{"inputs":[],"name":"FailedInnerCall","type":"error"},{"inputs":[],"name":"InsufficientMsgValue","type":"error"},{"inputs":[],"name":"InvalidNativeStargate","type":"error"},{"inputs":[{"internalType":"address","name":"token","type":"address"}],"name":"SafeERC20FailedOperation","type":"error"},{"inputs":[{"internalType":"enum Currency","name":"currency","type":"uint8"}],"name":"UnsupportedCurrency","type":"error"},{"inputs":[],"name":"claimContract","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"enum Currency","name":"currency","type":"uint8"},{"internalType":"uint256","name":"amountToDonate","type":"uint256"},{"internalType":"uint256","name":"_zroAmount","type":"uint256"},{"internalType":"bytes32[]","name":"_proof","type":"bytes32[]"},{"internalType":"address","name":"_to","type":"address"},{"internalType":"bytes","name":"_extraBytes","type":"bytes"}],"name":"donateAndClaim","outputs":[{"components":[{"internalType":"bytes32","name":"guid","type":"bytes32"},{"internalType":"uint64","name":"nonce","type":"uint64"},{"components":[{"internalType":"uint256","name":"nativeFee","type":"uint256"},{"internalType":"uint256","name":"lzTokenFee","type":"uint256"}],"internalType":"struct MessagingFee","name":"fee","type":"tuple"}],"internalType":"struct MessagingReceipt","name":"receipt","type":"tuple"}],"stateMutability":"payable","type":"function"},{"inputs":[],"name":"donateContract","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"stargateNative","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"stargateUsdc","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"stargateUsdt","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"tokenUsdc","outputs":[{"internalType":"contract IERC20","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"tokenUsdt","outputs":[{"internalType":"contract IERC20","name":"","type":"address"}],"stateMutability":"view","type":"function"}]');

  return new ethers.Contract(CONTRACT_ADDRESS, ABI, runner);
}
