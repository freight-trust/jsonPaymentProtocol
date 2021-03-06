'use strict';

// Native
const crypto = require('crypto');
const https = require('https');
const query = require('querystring');
const url = require('url');

// Modules
const secp256k1 = require('secp256k1');

function PaymentProtocol(requestOptions, trustedKeys) {
  this.options = Object.assign({}, { agent: false }, requestOptions);
  this.trustedKeys = trustedKeys;
  if (!this.trustedKeys || !Object.keys(this.trustedKeys).length) {
    throw new Error('Invalid constructor, no trusted keys added to agent');
  }
}

/**
 * Internal method for making requests asynchronously
 * @param {Object} options
 * @return {Promise<Object{rawBody: String, headers: Object}>}
 * @private
 */
PaymentProtocol.prototype._asyncRequest = async function(options) {
  let requestOptions = Object.assign({}, this.options, options);
  const parsedUrl = url.parse(requestOptions.url);

  // Copy headers directly as they're objects
  requestOptions.headers = Object.assign({}, this.options.headers, options.headers);

  requestOptions.hostname = parsedUrl.hostname;
  requestOptions.path = parsedUrl.path;
  requestOptions.port = parsedUrl.port;
  delete requestOptions.url;

  return new Promise((resolve, reject) => {
    const request = https.request(requestOptions, (response) => {
      const body = [];
      response.on('data', chunk => body.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) {
          console.log('Status', response.statusCode);
          return reject(new Error(body.join('')));
        }
        resolve({
          rawBody: body.join(''),
          headers: response.headers
        });
      });
    });
    request.on('error', reject);
    if (requestOptions.body) {
      request.write(requestOptions.body);
    }
    request.end();
  });
};

/**
 * Makes a request to the given url and returns the raw JSON string retrieved as well as the headers
 * @param {string} paymentUrl the payment protocol specific url
 * @param {boolean} unsafeBypassValidation bypasses signature verification on the request (DO NOT USE IN PRODUCTION)
 */
PaymentProtocol.prototype.getPaymentOptions = async function(paymentUrl, unsafeBypassValidation = false) {
  const paymentUrlObject = url.parse(paymentUrl);

  // Detect 'bitcoin:' urls and extract payment-protocol section
  if (paymentUrlObject.protocol !== 'http:' && paymentUrlObject.protocol !== 'https:') {
    let uriQuery = query.decode(paymentUrlObject.query);
    if (!uriQuery.r) {
      throw new Error('Invalid payment protocol url');
    } else {
      paymentUrl = uriQuery.r;
    }
  }

  const { rawBody, headers } = await this._asyncRequest({
    method: 'GET',
    url: paymentUrl,
    headers: {
      Accept: 'application/payment-options',
      'x-paypro-version': 2
    }
  });

  return await this.verifyResponse(paymentUrl, rawBody, headers, unsafeBypassValidation);
};

/**
 * Selects which chain and currency option the user will be using for payment
 * @param {string} paymentUrl the payment protocol specific url
 * @param chain
 * @param currency
 * @param unsafeBypassValidation
 * @return {Promise<{requestUrl, responseData}|{keyData, requestUrl, responseData}>}
 */
PaymentProtocol.prototype.selectPaymentOption = async function(paymentUrl, chain, currency, unsafeBypassValidation = false) {
  const { rawBody, headers } = await this._asyncRequest({
    url: paymentUrl,
    method: 'POST',
    headers: {
      'Content-Type': 'application/payment-request',
      'x-paypro-version': 2
    },
    body: JSON.stringify({
      chain,
      currency
    })
  });

  return await this.verifyResponse(paymentUrl, rawBody, headers, unsafeBypassValidation);
};

/**
 * Sends an unsigned raw transaction to the server for verification of outputs and fee amount
 * @param {string} paymentUrl - the payment protocol specific url
 * @param {string} chain - The cryptocurrency chain of the payment (BTC, BCH, ETH, etc)
 * @param {string} currency - When spending a token on top of a chain, such as GUSD on ETH this would be GUSD,
 * if no token is used this should be blank
 * @param [{tx: string, weightedSize: number}] unsignedTransactions - Hexadecimal format unsigned transactions
 * @param {boolean} unsafeBypassValidation
 * @return {Promise<{responseData: any}>}
 */
PaymentProtocol.prototype.verifyUnsignedPayment = async function({
  paymentUrl,
  chain,
  currency,
  unsignedTransactions,
  unsafeBypassValidation = false
}) {
  const { rawBody, headers } = await this._asyncRequest({
    url: paymentUrl,
    method: 'POST',
    headers: {
      'Content-Type': 'application/payment-verification',
      'x-paypro-version': 2
    },
    body: JSON.stringify({
      chain,
      currency,
      transactions: unsignedTransactions
    })
  });

  return await this.verifyResponse(paymentUrl, rawBody, headers, unsafeBypassValidation);
};

/**
 * Sends a signed transaction as the final step for payment
 * @param {string} paymentUrl the payment protocol specific url
 * @param {string} chain
 * @param {string} currency
 * @param {[string]} signedTransactions
 * @param {number} weightedSize
 * @param {boolean} unsafeBypassValidation
 * @return {Promise<{keyData: Object, requestUrl: String, responseData: Object}|{requestUrl: String, responseData: Object}>}
 */
PaymentProtocol.prototype.sendSignedPayment = async function({
  paymentUrl,
  chain,
  currency,
  signedTransactions,
  unsafeBypassValidation = false
}) {
  const { rawBody, headers } = await this._asyncRequest({
    url: paymentUrl,
    method: 'POST',
    headers: {
      'Content-Type': 'application/payment',
      'x-paypro-version': 2
    },
    body: JSON.stringify({
      chain,
      currency,
      transactions: signedTransactions
    })
  });

  return await this.verifyResponse(paymentUrl, rawBody, headers, unsafeBypassValidation);
};

/**
 * Verifies the signature on any response from the payment requestor
 * @param {String} requestUrl - Url which the request was made to
 * @param {String} rawBody - The raw string body of the response
 * @param {Object} headers -
 * @param {Boolean} unsafeBypassValidation
 * @return {Promise<{keyData: Object, requestUrl: String, responseData: Object}|{requestUrl: String, responseData: Object}>}
 */
PaymentProtocol.prototype.verifyResponse = async function(requestUrl, rawBody, headers, unsafeBypassValidation) {
  if (!requestUrl) {
    throw new Error('Parameter requestUrl is required');
  }
  if (!rawBody) {
    throw new Error('Parameter rawBody is required');
  }
  if (!headers) {
    throw new Error('Parameter headers is required');
  }

  let responseData;
  try {
    responseData = JSON.parse(rawBody);
  } catch (e) {
    throw new Error('Invalid JSON in response body');
  }

  if (unsafeBypassValidation) {
    return { requestUrl, responseData };
  }

  const hash = headers.digest.split('=')[1];
  const signature = headers.signature;
  const signatureType = headers['x-signature-type'];
  const identity = headers['x-identity'];
  let host;

  try {
    host = url.parse(requestUrl).hostname;
  } catch (e) {
  }

  if (!host) {
    throw new Error('Invalid requestUrl');
  }
  if (!signatureType) {
    throw new Error('Response missing x-signature-type header');
  }
  if (typeof signatureType !== 'string') {
    throw new Error('Invalid x-signature-type header');
  }
  if (signatureType !== 'ecc') {
    throw new Error(`Unknown signature type ${signatureType}`);
  }
  if (!signature) {
    throw new Error('Response missing signature header');
  }
  if (typeof signature !== 'string') {
    throw new Error('Invalid signature header');
  }
  if (!identity) {
    throw new Error('Response missing x-identity header');
  }
  if (typeof identity !== 'string') {
    throw new Error('Invalid identity header');
  }

  if (!this.trustedKeys[identity]) {
    throw new Error(`Response signed by unknown key (${identity}), unable to validate`);
  }

  const keyData = this.trustedKeys[identity];
  const actualHash = crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex');

  if (hash !== actualHash) {
    throw new Error(`Response body hash does not match digest header. Actual: ${actualHash} Expected: ${hash}`);
  }

  if (!keyData.domains.includes(host)) {
    throw new Error(`The key on the response (${identity}) is not trusted for domain ${host}`);
  }

  let valid = secp256k1.verify(
    Buffer.from(hash, 'hex'),
    Buffer.from(signature, 'hex'),
    Buffer.from(keyData.publicKey, 'hex')
  );

  if (!valid) {
    throw new Error('Response signature invalid');
  }

  return { requestUrl, responseData, keyData };
};

module.exports = PaymentProtocol;
