import { expect, test } from "bun:test";
import { subtotal, total } from "./cart";

const cart = [
  { name: "mug", priceCents: 1500, qty: 2 },
  { name: "tea", priceCents: 2000, qty: 1 },
];

test("subtotal adds price times quantity", () => {
  expect(subtotal(cart)).toBe(5000);
});

test("unknown codes leave the total unchanged", () => {
  expect(total(cart, "BOGUS")).toBe(5000);
});
