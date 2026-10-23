// Prices are CNY; paid usage periods last exactly 30 days from membership activation; trial is one-time.
export const PERIOD_MS=30*86400000;
export const SERVICE_PLANS=Object.freeze({
 regular:{minutes:1800,summaries:10,inputTokens:null,outputTokens:null},
 premium:{minutes:null,summaries:null,inputTokens:null,outputTokens:null},
 trial:{minutes:60,summaries:0,inputTokens:null,outputTokens:null}
});
export const USD_CNY=8; // Conservative budget conversion, not a live FX quote.
export const PRICING_VERSION='2026-10-23';
export const audioCost=ms=>Math.ceil(ms*0.075); // USD millionths: $0.0045/min
export const textCost=(input,output,cached=0)=>Math.ceil(Math.max(0,input-cached)*0.4+cached*0.1+output*1.6);
export const planFor=tier=>SERVICE_PLANS[tier]||{minutes:0,summaries:0,inputTokens:null,outputTokens:null};
export const moneyCny=micros=>Math.round(micros*USD_CNY/10000)/100;
