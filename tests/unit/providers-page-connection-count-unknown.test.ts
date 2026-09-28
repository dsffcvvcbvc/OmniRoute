import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * THE INVARIANT: a count the page could not obtain is never drawn as a number.
 *
 * The providers dashboard shows, for every section, "how many of these
 * providers are configured". That number is a count of CONNECTIONS, and
 * connections are only knowable from the admin plane. When the admin plane does
 * not answer, the count is UNKNOWN — and the page renders `connections: []`,
 * which downstream reads as `0`: "this gateway has no providers configured".
 *
 * That is the exact claim a 401 cannot support, and it survived the first fix
 * because the flag was computed from the STATUS of a failed read rather than
 * from the ABSENCE of a body. `classifyAisixAdminStatus` answers "what did the
 * gateway refuse", so a 500, a 502, a 503, a connection reset and the 20 s
 * fetch timeout all left the flag `false` and every badge drew `0/N` — the
 * failure the flag was added to remove, on the failure path most likely to
 * occur in ordinary use.
 *
 * These cases are the regression guard for that hole. Each one is a way the
 * body can fail to arrive that is NOT a credential refusal, and each must leave
 * `connectionsUnknown` true. Reverting the fix (deriving the flag from the
 * status instead of the absence) turns every non-401 row below red.
 */

import {
  loadProviderPageData,
  readConnectionCount,
} from "@/app/(dashboard)/dashboard/providers/providerPageUtils";

const KEYS_URL = "http://127.0.0.1:3001/admin/v1/provider_keys";
const MODELS_URL = "http://127.0.0.1:3001/admin/v1/models";
const METRICS_URL = "http://127.0.0.1:9090/metrics";

/** A fetch that fails the admin plane but leaves the metrics plane alone. */
function adminStatusFetch(status: number): typeof fetch {
  return ((url: string | URL) => {
    if (String(url) === METRICS_URL) {
      return Promise.resolve(
        new Response(JSON.stringify({ object: "list", data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ error_msg: "upstream" }), {
        status,
        headers: { "content-type": "application/json" },
      })
    );
  }) as unknown as typeof fetch;
}

/** A fetch that never settles and rejects with an AbortError once timed out. */
function hangingFetch(): typeof fetch {
  return ((_url: string | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }
    })) as unknown as typeof fetch;
}

/** A 2xx whose body is not JSON — the body was still not obtained. */
function unparseableBodyFetch(): typeof fetch {
  return ((url: string | URL) => {
    if (String(url) === METRICS_URL) {
      return Promise.resolve(
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      );
    }
    return Promise.resolve(
      new Response("<html>gateway</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    );
  }) as unknown as typeof fetch;
}

function okFetch(): typeof fetch {
  return ((url: string | URL) => {
    const body =
      String(url) === KEYS_URL
        ? { connections: [{ id: "c1" }] }
        : String(url) === MODELS_URL
          ? { nodes: [] }
          : { object: "list", data: [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  }) as unknown as typeof fetch;
}

describe("a count the admin plane did not give us is UNKNOWN, whatever the reason", () => {
  // Every row here is a way the connection list can fail to arrive that is NOT
  // a credential refusal. `connectionsUnknown` is the flag the page withholds the
  // "0/N" number on, so `false` in any of these rows is the bug.
  const unobtained: Array<[string, () => Promise<{ connectionsUnknown: boolean }>]> = [
    ["500 — an internal error", () => loadProviderPageData(adminStatusFetch(500), 1000)],
    [
      "502 — a gateway restart in front of the admin API",
      () => loadProviderPageData(adminStatusFetch(502), 1000),
    ],
    ["503 — the admin API is unavailable", () => loadProviderPageData(adminStatusFetch(503), 1000)],
    [
      "504 — the proxy gave up on the admin API",
      () => loadProviderPageData(adminStatusFetch(504), 1000),
    ],
    [
      "404 — a route this build does not have",
      () => loadProviderPageData(adminStatusFetch(404), 1000),
    ],
    [
      "405 — the method this build does not accept",
      () => loadProviderPageData(adminStatusFetch(405), 1000),
    ],
    [
      "a connection reset mid-request",
      () =>
        loadProviderPageData(
          (() => Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch,
          1000
        ),
    ],
    ["the 20s fetch timeout elapsing", () => loadProviderPageData(hangingFetch(), 50)],
    [
      "a 2xx whose body is not readable JSON",
      () => loadProviderPageData(unparseableBodyFetch(), 1000),
    ],
  ];

  for (const [label, run] of unobtained) {
    test(`${label} leaves the count unknown`, async () => {
      const data = await run();
      assert.equal(
        data.connectionsUnknown,
        true,
        `${label}: an unobtained connection list is not an empty one`
      );
      // And the two must not be conflated downstream either: the page renders
      // `connections` either way, so the flag is the only thing standing between
      // a failed read and a rendered "0".
      const { known, none } = readConnectionCount(data.connections, data.connectionsUnknown);
      assert.equal(known, false, `${label}: no claim about the count may be licensed`);
      assert.equal(
        none,
        false,
        `${label}: "you configured nothing" is exactly the claim this read cannot support`
      );
    });
  }

  test("a read that DID answer leaves the count known and zero is a real zero", async () => {
    const data = await loadProviderPageData(
      (() =>
        Promise.resolve(
          new Response(JSON.stringify({ connections: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        )) as unknown as typeof fetch,
      1000
    );
    assert.deepEqual(data.connections, []);
    assert.equal(data.connectionsUnknown, false);
    // The positive half: an answered empty list really is "nothing configured",
    // and the page is entitled to say so.
    const { known, none } = readConnectionCount(data.connections, data.connectionsUnknown);
    assert.equal(known, true);
    assert.equal(none, true);
  });

  test("a full successful read reports a known count and no refusal", async () => {
    const data = await loadProviderPageData(okFetch(), 1000);
    assert.deepEqual(data.connections, [{ id: "c1" }]);
    assert.equal(data.connectionsUnknown, false);
    assert.equal(data.adminRefused, false);
  });
});

describe("the sign-in banner is narrower than the unknown count", () => {
  test("a 5xx is not a credential problem, so nothing is offered to fix it", async () => {
    // A key prompt on an unhealthy gateway sends the operator to the wrong fix,
    // which is why the two facts are separate: `connectionsUnknown` licenses
    // withholding the number, `adminRefused` licenses offering the button.
    const data = await loadProviderPageData(adminStatusFetch(500), 1000);
    assert.equal(data.connectionsUnknown, true);
    assert.equal(data.adminRefused, false);
  });

  test("a refused credential is both unknown AND refused", async () => {
    const data = await loadProviderPageData(adminStatusFetch(401), 1000);
    assert.equal(data.connectionsUnknown, true);
    assert.equal(data.adminRefused, true);
  });

  test("a 403 same-origin refusal is a credential refusal too", async () => {
    const data = await loadProviderPageData(adminStatusFetch(403), 1000);
    assert.equal(data.connectionsUnknown, true);
    assert.equal(data.adminRefused, true);
  });
});
