'use strict';
const { webSocketOrdersBinance } = require('./depositMonitor');
const { enterDeltaHedge } = require('./deltaHedge');
const civfund = require('@civfund/fund-libraries');
const { dbMongoose } = require('@civfund/fund-libraries');
const { getTransactionDetails } = require('./RPCCalls');
const { averageYieldsGlobal,webSocketConnections,averageYieldsPostExecutionGlobal, averageDiscountFactorPostExecutionGlobal } = require('./yieldDisplay'); // Adjust the path as necessary
const { executeOracleDiscountFactor } = require('./oracle_discountFactor'); // Adjust the path as necessary


const mainFunction = async () => {
  let liveStrategiesObj = await getLiveStrategiesMongo();
  const onMessageCallback = async (response) => {
    if (response.e =="outboundAccountPosition"){ // need to change this to balanceUpdate on main, testing done with 'outboundAccountPosition'
      let depositResults = await getBinanceDeposits('binance','Test','USDT',getUnixTimestampForLastDay());
      for (let deposit in depositResults){
        if (depositResults[deposit].network == 'SOL' && depositResults[deposit].currency == 'USDT'){ // need to change this to USDT on main testing
          if (!(await checkExecutedTransaction(depositResults[deposit].txid))){
            let senderAddress = await getTransactionDetails(depositResults[deposit].txid);
            let executedLiveStrategy; let profitPercent; let amount;
            for (let liveStrategy in liveStrategiesObj) {
              let strategy = liveStrategiesObj[liveStrategy];
              let clientOrderId = `V${strategy.strategy}-${depositResults[deposit].id}`;
              profitPercent = calculateProfitPercent(strategy.symbolFuture);
              amount = depositResults[deposit].amount/(webSocketConnections[strategy.symbolFuture].getPrice())
              if (strategy.poolAddress === senderAddress) {
                await enterDeltaHedge(
                  strategy.spotExchange,
                  strategy.futuresExchange,
                  strategy.subaccount,
                  clientOrderId,
                  strategy.symbolSpot,
                  strategy.symbolFuture,
                  amount,
                  strategy.spotDecimals,
                  strategy.futuresDecimals,
                  1,
                  profitPercent*100
                );
                executedLiveStrategy = strategy;
                break;
              }
            };
            uploadExecutedTransaction(depositResults[deposit],executedLiveStrategy,profitPercent,amount);
            // transfer the assets from spot to future
          } else {
            console.log('Transaction already executed');
          }
        }
      }
    }
  };
  webSocketOrdersBinance('Test', onMessageCallback);
};

// Check for the funds have been deposited into the Binance wallet
const getBinanceDeposits = async function(exchangeName,subaccount,assetName,since,limit=10) {
  let cex = civfund.initializeCcxt(exchangeName,subaccount);
  return await cex.fetchDeposits(assetName, since, limit);
};

function getUnixTimestampForLastDay() {
  const oneDayInMilliseconds = 2 * 24 * 60 * 60 * 1000; // hours*minutes*seconds*milliseconds
  const currentDate = new Date(); // Current date and time
  const lastDayTimestamp = new Date(currentDate.getTime() - oneDayInMilliseconds); // Subtract 1 day from the current date
  
  return Math.floor(lastDayTimestamp.getTime()); // Convert to Unix timestamp (in seconds) and return
}

async function getLiveStrategiesMongo() {
  const dbName = 'bond-hive'; 
  const collectionName = 'LiveStrategies'; 
  let dataCollections = await dbMongoose.getCollection(dbName, collectionName);
  if (dataCollections.length === 0) {
    throw new Error('No documents found in the collection');
  }
  const currentDate = new Date();
  let liveStrategiesObj = {};
  for (let document of dataCollections) {
    const plainDoc = document.toObject ? document.toObject() : document;
    const symbolFuture = plainDoc.symbolFuture; // Ensure symbolFuture is defined for logging
    // Extract maturity date from symbolFuture
    const maturityMatch = symbolFuture.match(/_(\d{6})/);
    if (!maturityMatch) {
      console.error(`Maturity date format error in symbolFuture: ${symbolFuture}`);
      continue; // Skip this iteration if the format does not match
    }
    const maturityStr = maturityMatch[1];
    const maturity = `20${maturityStr.slice(0, 2)}-${maturityStr.slice(2, 4)}-${maturityStr.slice(4, 6)}`;
    
    // Convert maturity string to Date object
    const maturityDate = new Date(maturity);
    
    // Check if maturity date has not passed
    if (maturityDate < currentDate) {
      console.log(`Maturity date for ${symbolFuture} has passed. Ignoring...`);
      continue; // Skip to the next document if the maturity date has passed
    }
    
    // Assign plainDoc properties to liveStrategiesObj[document.strategy] and add maturityDate
    liveStrategiesObj[plainDoc.strategy] = {
      ...plainDoc,
      maturityDate // This adds the maturityDate as a property
    };
  }
  return liveStrategiesObj; // Optionally return the object if needed elsewhere
}

async function checkExecutedTransaction(txid) {
  const dbName = 'bond-hive'; 
  const collectionName = 'executedTransaction'; 
  let dataCollection = await dbMongoose.findOne(dbName, collectionName, "txid", txid);
  if (!dataCollection) {
    return false; // No document found
  }
  return true; // Document found
}

const oracleFunction = async (contractAddress) => {
  // Fetch the live strategies from MongoDB
  let liveStrategiesObj = await getLiveStrategiesMongo();

  // Find the strategy with the matching symbolFuture
  let toSearch = Object.keys(liveStrategiesObj).find(key => liveStrategiesObj[key].oracleAddress === contractAddress);
  
  // If no matching strategy is found, exit the function
  if (!toSearch) {
    console.error("No matching strategy found for the given symbolFuture.");
    return;
  }

  // Extract the contract address and determine the RPC server URL
  let rpcServerUrl = liveStrategiesObj[toSearch].oracleNetwork === "testnet"
  ? "https://soroban-testnet.stellar.org:443"
  : null; // Modify this line if you have URLs for other networks

  // Assume averageDiscountFactorPostExecutionGlobal is available globally
  let operationValue = Math.round(Number(averageDiscountFactorPostExecutionGlobal[liveStrategiesObj[toSearch].symbolFuture]) * Math.pow(10, 7));
  let operationValueType = "i128";
  let secretKey = process.env.STELLAR_SECRET;

  // Execute the operation
  executeOracleDiscountFactor({
    secretKey,
    rpcServerUrl,
    contractAddress,
    operationName: "set_discount",
    operationValue,
    operationValueType,
  });
  return "Oracle Txn executed"
}

// Sample usage, assuming "BTC/USDT_240628" is a valid symbolFuture in liveStrategiesObj
// oracleFunction("BTC/USDT_240628");

async function uploadExecutedTransaction(depositResults,executedLiveStrategy,profitPercent,amount) {
  const dbName = 'bond-hive'; 
  const collectionName = 'executedTransaction';
  let modelName = 'ExecutedTransaction';
  const newRecord = {
    strategy: executedLiveStrategy.strategy,
    name: executedLiveStrategy.name,
    symbolSpot: executedLiveStrategy.symbolSpot,
    symbolFuture: executedLiveStrategy.symbolFuture,
    depositAddress: executedLiveStrategy.poolAddress,
    exchangeId: depositResults.id,
    txid: depositResults.txid,
    depositTimestamp: depositResults.timestamp,
    executedTimestamp: Date.now(),
    actionType: depositResults.type,
    network: depositResults.network,
    currency: depositResults.currency,
    amount: amount,
    profitPercent: profitPercent*100,
    profitPercentPostExecution: calculateProfitPercent(executedLiveStrategy.symbolFuture,true)*100,
    APY: averageYieldsGlobal[executedLiveStrategy.symbolFuture]*100,
    APYPostexecution: averageYieldsPostExecutionGlobal[executedLiveStrategy.symbolFuture]*100,
  };
  await civfund.dbMongoose.insertOne(dbName, collectionName, modelName, newRecord);
}

function calculateProfitPercent(symbolFuture,postExecution = false) {
  // Extracting maturity date from symbolFuture
  const maturityMatch = symbolFuture.match(/_(\d{6})/);
  if (!maturityMatch) {
    console.error(`Maturity date format error in symbolFuture: ${symbolFuture}`);
    return null; // Return null or handle as appropriate for your application
  }
  const maturityStr = maturityMatch[1];
  const maturity = `20${maturityStr.slice(0, 2)}-${maturityStr.slice(2, 4)}-${maturityStr.slice(4, 6)}`;
  const maturityDate = new Date(maturity);

  // Getting the APY for the future symbol
  const apy = postExecution? averageYieldsPostExecutionGlobal[symbolFuture] :averageYieldsGlobal[symbolFuture];
  if (typeof apy !== 'number') {
      console.error(`APY for ${symbolFuture} is not available or invalid.`);
      return null; // Return null or handle as appropriate for your application
  }

  // Calculate the number of days to maturity from today
  const currentDate = new Date();
  const timeToMaturity = maturityDate - currentDate;
  const daysToMaturity = timeToMaturity / (1000 * 60 * 60 * 24);

  // Convert APY to absolute percentage return over the period to maturity
  const absolutePercent = (apy / 365) * daysToMaturity;
  return Math.abs(absolutePercent); // Ensure it's an absolute value
}

mainFunction();

module.exports = {
  mainFunction,
  oracleFunction
};