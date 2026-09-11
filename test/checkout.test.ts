import assert from "node:assert/strict";
import { test } from "node:test";
import { AlphaPayCheckout, AlphaPayConflictError, AlphaPaySessionGoneError, isTerminal } from "../src/index.js";

const BASE = "https://api.test/api/v1";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, ...init });
}

test("getSession unwraps the envelope, hits the right URL, and parses the session", async () => {
  const calls: string[] = [];
  const checkout = new AlphaPayCheckout({
    baseUrl: BASE,
    fetch: async (url) => {
      calls.push(String(url));
      return jsonResponse({
        success: true,
        code: 200,
        data: {
          slug: "abc123",
          merchant_name: "Boutique Test",
          amount: "5000.00",
          currency: "XOF",
          status: "PENDING",
          is_usable: true,
          networks: [
            { code: "MTN_BJ", name: "MTN Bénin", otp_required: false, fee: "75.00", total: "5075.00", currency: "XOF", unavailable: false },
          ],
        },
      });
    },
  });

  const session = await checkout.getSession("abc123");

  assert.equal(calls[0], `${BASE}/checkout/abc123/`);
  assert.equal(session.merchant_name, "Boutique Test");
  assert.equal(session.networks.length, 1);
  assert.equal(session.networks[0]!.code, "MTN_BJ");
  assert.equal(session.networks[0]!.unavailable, false);
});

test("pay() sends the network/customer/otp body and NO Authorization header at all", async () => {
  let capturedHeaders: Record<string, string> | undefined;
  let capturedBody: string | undefined;
  const checkout = new AlphaPayCheckout({
    baseUrl: BASE,
    fetch: async (_url, init) => {
      capturedHeaders = init!.headers as Record<string, string>;
      capturedBody = init!.body as string;
      return jsonResponse({
        success: true,
        code: 201,
        data: { message: "Paiement initié", transaction_id: "tx_1", status: "PENDING", payment_url: "", otp_required: false, instructions: "Composez #144#" },
      });
    },
  });

  const result = await checkout.pay("abc123", { network: "MTN_BJ", country: "BJ", customer: { phone: "+22900000000", first_name: "Client" } });

  assert.equal(result.transaction_id, "tx_1");
  assert.equal(capturedHeaders!.Authorization, undefined); // JAMAIS de clé secrète ici
  const sentBody = JSON.parse(capturedBody!);
  assert.equal(sentBody.network, "MTN_BJ");
  assert.equal(sentBody.customer.phone, "+22900000000");
});

test("maps a 410 (session no longer usable) to AlphaPaySessionGoneError", async () => {
  const checkout = new AlphaPayCheckout({
    baseUrl: BASE,
    fetch: async () =>
      jsonResponse(
        { success: false, code: 410, error: { message: "Cette session de paiement n'est plus utilisable.", code: "paid" } },
        { status: 410 }
      ),
  });

  await assert.rejects(
    () => checkout.pay("abc123", { network: "MTN_BJ" }),
    (err: unknown) => {
      assert.ok(err instanceof AlphaPaySessionGoneError);
      assert.equal(err.code, "paid");
      return true;
    }
  );
});

test("maps a 409 double-submission to AlphaPayConflictError", async () => {
  const checkout = new AlphaPayCheckout({
    baseUrl: BASE,
    fetch: async () =>
      jsonResponse(
        { success: false, code: 409, error: { message: "Un paiement est déjà en cours...", code: "payment_already_pending" } },
        { status: 409 }
      ),
  });

  await assert.rejects(
    () => checkout.pay("abc123", { network: "MTN_BJ" }),
    (err: unknown) => {
      assert.ok(err instanceof AlphaPayConflictError);
      assert.equal(err.code, "payment_already_pending");
      return true;
    }
  );
});

test("retries a 429 honoring Retry-After, then resolves", async () => {
  let attempts = 0;
  const checkout = new AlphaPayCheckout({
    baseUrl: BASE,
    maxRetries: 2,
    fetch: async () => {
      attempts++;
      if (attempts < 2) {
        return jsonResponse({ success: false, code: 429, error: { detail: "Throttled" } }, { status: 429, headers: { "Retry-After": "0" } });
      }
      return jsonResponse({ success: true, code: 200, data: { slug: "abc123", status: "PAID", amount: "5000", currency: "XOF", otp_required: false } });
    },
  });

  const status = await checkout.getStatus("abc123");

  assert.equal(attempts, 2);
  assert.equal(status.status, "PAID");
  assert.ok(isTerminal(status));
});

test("pollStatus emits intermediate PENDING results then stops at a terminal status", async () => {
  let attempts = 0;
  const checkout = new AlphaPayCheckout({
    baseUrl: BASE,
    fetch: async () => {
      attempts++;
      const status = attempts < 3 ? "PENDING" : "PAID";
      return jsonResponse({ success: true, code: 200, data: { slug: "abc123", status, amount: "5000", currency: "XOF", otp_required: false } });
    },
  });

  const results: string[] = [];
  for await (const status of checkout.pollStatus("abc123", { interval: 0 })) {
    results.push(status.status);
  }

  assert.deepEqual(results, ["PENDING", "PENDING", "PAID"]);
});
