// ================= FILE: src/market/bitgetClient.js =================
//
// Complete Bitget API client for USDT perpetuals
// Handles all market data fetching needed by scanner
//

import axios from 'axios';
import { createHmac } from 'node:crypto';

const API_BASE_URL = 'https://api.bitget.com/v2';

export class BitgetClient {
  constructor(apiKey = '', secretKey = '', passphrase = '') {
    this.apiKey = apiKey;
    this.secretKey = secretKey;
    this.passphrase = passphrase;
    
    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Get all USDT perpetuals tickers
   */
  async getTickers(productType = 'usdt-futures', limit = 500) {
    try {
      const response = await this.client.get('/public/market/tickers', {
        params: {
          productType,
          limit: Math.min(limit, 500)
        }
      });

      if (!response.data || !response.data.data) {
        return [];
      }

      return response.data.data.map(ticker => ({
        symbol: ticker.symbol,
        lastPr: parseFloat(ticker.lastPr || 0),
        highPr: parseFloat(ticker.highPr || 0),
        lowPr: parseFloat(ticker.lowPr || 0),
        openUtc: parseFloat(ticker.openUtc || 0),
        baseVolume: parseFloat(ticker.baseVolume || 0),
        quoteVolume: parseFloat(ticker.quoteVolume || 0),
        ts: parseInt(ticker.ts || Date.now()),
        fundingRate: parseFloat(ticker.fundingRate || 0),
        change24h: parseFloat(ticker.change24h || 0)
      }));
    } catch (err) {
      console.error('getTickers error:', err.message);
      return [];
    }
  }

  /**
   * Get OHLCV candles for a symbol
   */
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

      const response = await this.client.get('/public/market/candles', { params });

      if (!response.data || !response.data.data) {
        return [];
      }

      return response.data.data.map(candle => ({
        ts: candle[0],
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        quoteVolume: parseFloat(candle[6] || 0)
      }));
    } catch (err) {
      console.error(`getCandles error for ${symbol}:`, err.message);
      return [];
    }
  }

  /**
   * Get order book for a symbol
   */
  async getOrderBook(symbol = '', limit = 20) {
    try {
      if (!symbol) return null;

      const response = await this.client.get('/public/market/books', {
        params: {
          symbol,
          limit: Math.min(limit, 100)
        }
      });

      if (!response.data || !response.data.data) {
        return null;
      }

      const data = response.data.data;
      return {
        symbol,
        asks: (data.asks || []).map(a => ({
          price: parseFloat(a[0]),
          size: parseFloat(a[1])
        })),
        bids: (data.bids || []).map(b => ({
          price: parseFloat(b[0]),
          size: parseFloat(b[1])
        })),
        ts: parseInt(data.ts || Date.now())
      };
    } catch (err) {
      console.error(`getOrderBook error for ${symbol}:`, err.message);
      return null;
    }
  }

  /**
   * Get current price for a symbol
   */
  async getPrice(symbol = '') {
    try {
      if (!symbol) return null;

      const response = await this.client.get('/public/market/tickers', {
        params: { symbol }
      });

      if (!response.data || !response.data.data || response.data.data.length === 0) {
        return null;
      }

      const ticker = response.data.data[0];
      return {
        symbol,
        last: parseFloat(ticker.lastPr || 0),
        high: parseFloat(ticker.highPr || 0),
        low: parseFloat(ticker.lowPr || 0),
        open: parseFloat(ticker.openUtc || 0),
        volume: parseFloat(ticker.baseVolume || 0),
        change24h: parseFloat(ticker.change24h || 0),
        fundingRate: parseFloat(ticker.fundingRate || 0),
        timestamp: parseInt(ticker.ts || Date.now())
      };
    } catch (err) {
      console.error(`getPrice error for ${symbol}:`, err.message);
      return null;
    }
  }

  /**
   * Get 24h statistics for a symbol
   */
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

  /**
   * Get recent trades for a symbol
   */
  async getRecentTrades(symbol = '', limit = 50) {
    try {
      if (!symbol) return [];

      const response = await this.client.get('/public/market/trades', {
        params: {
          symbol,
          limit: Math.min(limit, 100)
        }
      });

      if (!response.data || !response.data.data) {
        return [];
      }

      return response.data.data.map(trade => ({
        tradeId: trade.tradeId,
        price: parseFloat(trade.price),
        size: parseFloat(trade.size),
        side: trade.side,
        ts: parseInt(trade.ts)
      }));
    } catch (err) {
      console.error(`getRecentTrades error for ${symbol}:`, err.message);
      return [];
    }
  }

  /**
   * Get funding rate history for a symbol
   */
  async getFundingRateHistory(symbol = '', limit = 100) {
    try {
      if (!symbol) return [];

      const response = await this.client.get('/public/market/funding-rates', {
        params: {
          symbol,
          limit: Math.min(limit, 500)
        }
      });

      if (!response.data || !response.data.data) {
        return [];
      }

      return response.data.data.map(rate => ({
        symbol: rate.symbol,
        fundingRate: parseFloat(rate.fundingRate),
        fundingTime: parseInt(rate.fundingTime),
        predictedRate: parseFloat(rate.predictedRate || 0)
      }));
    } catch (err) {
      console.error(`getFundingRateHistory error for ${symbol}:`, err.message);
      return [];
    }
  }

  /**
   * Get open interest for a symbol
   */
  async getOpenInterest(symbol = '') {
    try {
      if (!symbol) return null;

      const response = await this.client.get('/public/market/open-interest', {
        params: { symbol }
      });

      if (!response.data || !response.data.data) {
        return null;
      }

      const data = response.data.data;
      return {
        symbol,
        openInterest: parseFloat(data.openInterest || 0),
        openInterestValue: parseFloat(data.openInterestValue || 0),
        timestamp: parseInt(data.timestamp || Date.now())
      };
    } catch (err) {
      console.error(`getOpenInterest error for ${symbol}:`, err.message);
      return null;
    }
  }

  /**
   * Get mark price for a symbol
   */
  async getMarkPrice(symbol = '') {
    try {
      if (!symbol) return null;

      const response = await this.client.get('/public/market/mark-price', {
        params: { symbol }
      });

      if (!response.data || !response.data.data) {
        return null;
      }

      const data = response.data.data[0];
      return {
        symbol,
        markPrice: parseFloat(data.markPrice || 0),
        indexPrice: parseFloat(data.indexPrice || 0),
        lastFundingRate: parseFloat(data.lastFundingRate || 0),
        nextFundingTime: parseInt(data.nextFundingTime || 0),
        timestamp: parseInt(data.timestamp || Date.now())
      };
    } catch (err) {
      console.error(`getMarkPrice error for ${symbol}:`, err.message);
      return null;
    }
  }

  /**
   * Verify API connection
   */
  async healthCheck() {
    try {
      const response = await this.client.get('/public/system-status');
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

  /**
   * Get all USDT futures symbols
   */
  async getAllSymbols() {
    try {
      const tickers = await this.getTickers('usdt-futures', 500);
      return tickers.map(t => t.symbol).filter(s => s.includes('USDT'));
    } catch (err) {
      console.error('getAllSymbols error:', err.message);
      return [];
    }
  }
}

export default BitgetClient;
