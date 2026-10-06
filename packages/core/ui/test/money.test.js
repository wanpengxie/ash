import assert from "node:assert/strict";
import test from "node:test";
import { usdToCnyText, balanceText } from "../js/money.js";

test("USD usage is converted to CNY, with small costs and unknown values preserved", () => {
  assert.equal(usdToCnyText(1), "¥6.74");
  assert.equal(usdToCnyText(1.5), "¥10.11");
  assert.equal(usdToCnyText(0.001), "¥0.0067");
  assert.equal(usdToCnyText(0), "¥0.00");
  for (const value of [null, undefined, NaN, Infinity]) assert.equal(usdToCnyText(value), "—");
});

test("CNY balance is not converted twice; USD balance is explicitly approximate", () => {
  assert.equal(balanceText({ total: "12.34", currency: "CNY" }), "¥12.34");
  assert.equal(balanceText({ total: "12.34", currency: "USD" }), "约 ¥83.17");
  assert.equal(balanceText({ total: "12.34", currency: "EUR" }), "12.34 EUR");
  assert.equal(balanceText({ total: "invalid", currency: "CNY" }), "—");
});
