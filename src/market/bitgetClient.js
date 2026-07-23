// ================= FILE: src/market/bitgetClient.js =================
// COMPLEET Bitget API client for USDT perpetuals

import axios from 'axios';
import { createHmac } from 'node:crypto';
import { CONFIG } from '../config.js';
import { safeNumber } from '../utils.js';

export class BitgetClient {
  constructor(apiKey = '', secretKey = '', passphrase = '') {
    this.apiKey = apiKey || CONFIG.API_KEYS.BITGET_API_KEY;
    this.secretKey = secretKey || CONFIG.API_KEYS.BITGET_SECRET_KEY;
    this.passphrase = passphrase || CONFIG.API_KEYS.BITGET_PASSPHRASE;

    this.baseURL = CONFIG.API.BITGET_BASE_URL;
    this.timeout = CONFIG.API.BITGET_TIMEOUT;

    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  _sign(method, path, body = '') {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = timestamp + method + path + body;
    const signature = createHmac('sha256', this.secretKey)
      .update(message)
      .digest('base64');

    return {
      'ACCESS-KEY': this.apiKey,
      'ACCESS-SIGN': signature,
      'ACCESS-TIMESTAMP': timestamp,
      'ACCESS-PASSPHRASE': this.passphrase
    };
  }

  async _get(path, params = {}) {
    try {
      const response = await this.client.get(path, { params });
      return response.data;
    } catch (err) {
      console.error(`BitgetClient GET ${path} error:`, err.message);
      throw err;
    }
  }

  async _post(path, body = {}) {
    try {
      const bodyStr = JSON.stringify(body);
      const headers = this._sign('POST', path, bodyStr);
      
      const response = await this.client.post(path, body, { headers });
      return response.data;
    } catch (err) {
      console.error(`BitgetClient POST ${path} error:`, err.message);
      throw err;
    }
  }

  async getTickers(productType = 'usdt-futures', limit = 500) {
    try {
      const response = await this._get('/public/market/tickers', {
        productType,
        limit: Math.min(limit, 500)
      });

      if (!response.data || !Array.isArray(response.data)) {
        return [];
      }

      return response.data.map(ticker => ({
        symbol: ticker.symbol || '',
        lastPr: safeNumber(ticker.lastPr, 0),
        highPr: safeNumber(ticker.highPr, 0),
        lowPr: safeNumber(ticker.lowPr, 0),
        openUtc: safeNumber(ticker.openUtc, 0),
        baseVolume: safeNumber(ticker.baseVolume, 0),
        quoteVolume: safeNumber(ticker.quoteVolume, 0),
        ts: parseInt(ticker.ts || Date.now()),
        fundingRate: safeNumber(ticker.fundingRate, 0),
        change24h: safeNumber(ticker.change24h, 0)
      }));
    } catch (err) {
      console.error('getTickers error:', err.message);
      return [];
    }
  }

  async getCandles(symbol = '', granularity = '1H', limit = 100, endTime = null) {
    try {
      if (!symbol) return [];

      const params = {
        symbol,
        granularity,
        limit: Math.min(limit, 500)
      };

      if (endTime) {
        params.endTime = endTime;
      }

      const response = await this._get('/public/market/candles', params);

      if (!response.data || !Array.isArray(response.data)) {
        return [];
      }

      return response.data.map(candle => ({
        ts: candle[0],
        open: safeNumber(candle[1], 0),
        high: safeNumber(candle[2], 0),
        low: safeNumber(candle[3], 0),
        close: safeNumber(candle[4], 0),
        volume: safeNumber(candle[5], 0),
        quoteVolume: safeNumber(candle[6], 0)
      }));
    } catch (err) {
      console.error(`getCandles error for ${symbol}:`, err.message);
      return [];
    }
  }

  async getOrderBook(symbol = '', limit = 20) {
    try {
      if (!symbol) return null;

      const response = await this._get('/public/market/books', {
        symbol,
        limit: Math.min(limit, 100)
      });

      if (!response.data) {
        return null;
      }

      const data = response.data;
      return {
        symbol,
        asks: (data.asks || []).map(a => ({
          price: safeNumber(a[0], 0),
          size: safeNumber(a[1], 0)
        })),
        bids: (data.bids || []).map(b => ({
          price: safeNumber(b[0], 0),
          size: safeNumber(b[1], 0)
        })),
        ts: parseInt(data.ts || Date.now())
      };
    } catch (err) {
      console.error(`getOrderBook error for ${symbol}:`, err.message);
      return null;
    }
  }

  async getPrice(symbol = '') {
    try {
      if (!symbol) return null;

      const response = await this._get('/public/market/tickers', { symbol });

      if (!response.data || response.data.length === 0) {
        return null;
      }

      const ticker = response.data[0];
      return {
        symbol,
        last: safeNumber(ticker.lastPr, 0),
        high: safeNumber(ticker.highPr, 0),
        low: safeNumber(ticker.lowPr, 0),
        open: safeNumber(ticker.openUtc, 0),
        volume: safeNumber(ticker.baseVolume, 0),
        change24h: safeNumber(ticker.change24h, 0),
        fundingRate: safeNumber(ticker.fundingRate, 0),
        timestamp: parseInt(ticker.ts || Date.now())
      };
    } catch (err) {
      console.error(`getPrice error for ${symbol}:`, err.message);
      return null;
    }
  }

  async get24hStats(symbol = '') {
    try {
      if (!symbol) return null;

      const tickers = await this.getTickers('usdt-futures', 500);
      const ticker = tickers.find(t => t.symbol === symbol);

      if (!ticker) return null;

      return {
        symbol,
        highPrice: ticker.highPr,
        lowPrice: ticker.lowPr,
        openPrice: ticker.openUtc,
        lastPrice: ticker.lastPr,
        baseVolume: ticker.baseVolume,
        quoteVolume: ticker.quoteVolume,
        priceChange: ticker.change24h,
        priceChangePercent: ticker.change24h,
        fundingRate: ticker.fundingRate
      };
    } catch (err) {
      console.error(`get24hStats error for ${symbol}:`, err.message);
      return null;
    }
  }

  async getRecentTrades(symbol = '', limit = 50) {
    try {
      if (!symbol) return [];

      const response = await this._get('/public/market/trades', {
        symbol,
        limit: Math.min(limit, 100)
      });

      if (!response.data || !Array.isArray(response.data)) {
        return [];
      }

      return response.data.map(trade => ({
        tradeId: trade.tradeId,
        price: safeNumber(trade.price, 0),
        size: safeNumber(trade.size, 0),
        side: trade.side,
        ts: parseInt(trade.ts || Date.now())
      }));
    } catch (err) {
      console.error(`getRecentTrades error for ${symbol}:`, err.message);
      return [];
    }
  }

  async getFundingRateHistory(symbol = '', limit = 100) {
    try {
      if (!symbol) return [];

      const response = await this._get('/public/market/funding-rates', {
        symbol,
        limit: Math.min(limit, 500)
      });

      if (!response.data || !Array.isArray(response.data)) {
        return [];
      }

      return response.data.map(rate => ({
        symbol: rate.symbol,
        fundingRate: safeNumber(rate.fundingRate, 0),
        fundingTime: parseInt(rate.fundingTime || 0),
        predictedRate: safeNumber(rate.predictedRate, 0)
      }));
    } catch (err) {
      console.error(`getFundingRateHistory error for ${symbol}:`, err.message);
      return [];
    }
  }

  async getOpenInterest(symbol = '') {
    try {
      if (!symbol) return null;

      const response = await this._get('/public/market/open-interest', {
        symbol
      });

      if (!response.data) {
        return null;
      }

      const data = response.data;
      return {
        symbol,
        openInterest: safeNumber(data.openInterest, 0),
        openInterestValue: safeNumber(data.openInterestValue, 0),
        timestamp: parseInt(data.timestamp || Date.now())
      };
    } catch (err) {
      console.error(`getOpenInterest error for ${symbol}:`, err.message);
      return null;
    }
  }

  async getMarkPrice(symbol = '') {
    try {
      if (!symbol) return null;

      const response = await this._get('/public/market/mark-price', {
        symbol
      });

      if (!response.data || response.data.length === 0) {
        return null;
      }

      const data = response.data[0];
      return {
        symbol,
        markPrice: safeNumber(data.markPrice, 0),
        indexPrice: safeNumber(data.indexPrice, 0),
        lastFundingRate: safeNumber(data.lastFundingRate, 0),
        nextFundingTime: parseInt(data.nextFundingTime || 0),
        timestamp: parseInt(data.timestamp || Date.now())
      };
    } catch (err) {
      console.error(`getMarkPrice error for ${symbol}:`, err.message);
      return null;
    }
  }

  async getAllSymbols() {
    try {
      const tickers = await this.getTickers('usdt-futures', 500);
      return tickers.map(t => t.symbol).filter(s => s.includes('USDT'));
    } catch (err) {
      console.error('getAllSymbols error:', err.message);
      return [];
    }
  }

  async healthCheck() {
    try {
      const response = await this._get('/public/system-status');
      return {
        ok: true,
        status: response.data?.code === '00000' ? 'healthy' : 'degraded'
      };
    } catch (err) {
      console.error('healthCheck error:', err.message);
      return {
        ok: false,
        error: err.message
      };
    }
  }

  async getPrices(symbols = []) {
    try {
      const prices = {};
      const results = await Promise.all(
        symbols.map(symbol => this.getPrice(symbol).catch(() => null))
      );

      for (let i = 0; i < symbols.length; i++) {
        if (results[i]) {
          prices[symbols[i]] = results[i];
        }
      }

      return prices;
    } catch (err) {
      console.error('getPrices error:', err.message);
      return {};
    }
  }

  async getMultipleCandles(symbols = [], granularity = '1H', limit = 100) {
    try {
      const candles = {};
      const results = await Promise.all(
        symbols.map(symbol => this.getCandles(symbol, granularity, limit).catch(() => []))
      );

      for (let i = 0; i < symbols.length; i++) {
        if (results[i] && results[i].length > 0) {
          candles[symbols[i]] = results[i];
        }
      }

      return candles;
    } catch (err) {
      console.error('getMultipleCandles error:', err.message);
      return {};
    }
  }
}

export default BitgetClient;
