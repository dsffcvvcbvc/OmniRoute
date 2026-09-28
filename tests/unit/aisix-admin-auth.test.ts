/**
 * The admin-key exchange: classification, the edge-triggered signed-out signal,
 * and the "never retry in a loop" property.
 *
 * Every fetch is a local stub, so what is under test is the CLIENT's decisions —
 * which request shape it builds, which header it attaches, and what it concludes
 * from a status. The server's own answers are pinned against the deployed
 * binary in `tests/integration/aisix-admin-session.test.ts`.
 */

import test, { afterEach, describe } from "node:test";
import assert from "node:assert/strict";

import {
  __resetAisixAdminAuthForTests,
  aisixAdminFetch,
  classifyAisixAdminStatus,
  exchangeAdminKeyForSession,
  getAisixSessionEpoch,
  getAisixSessionState,
  isAisixAdminUrl,
  isAisixSignedOut,
  noteAisixAdminStatus,
  requestAdminLogin,
  revokeAdminSession,
  subscribeAisixLoginRequested,
  subscribeAisixSessionEpoch,
  subscribeAisixSignedOut,
} from "../../src/shared/utils/aisixAdminAuth.ts";
import { getAisixAdminBase } from "../../src/shared/utils/aisixTransportBase.ts";

/** One recorded request, so a test can assert on the shape that was sent. */
interface Recorded {
  url: string;
  init: RequestInit;
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  calls: Recorded[];
  restore: () => void;
} {
  const calls: Recorded[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : String((input as Request).url ?? input);
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function noContent(status = 204, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

/**
 * Narrow a failed outcome to its fields, without `any`. The union members are
 * all `{ ok: false; failure; errorMsg }`, so a single shape describes every one
 * of them and a test can read `.failure` / `.errorMsg` honestly.
 */
function failed(outcome: Awaited<ReturnType<typeof exchangeAdminKeyForSession>>) {
  assert.equal(outcome.ok, false, "expected a failed outcome");
  if (outcome.ok) throw new Error("unreachable: the outcome is successful");
  return outcome;
}

const ADMIN = getAisixAdminBase();
const SESSION_URL = `${ADMIN}/admin/v1/auth/session`;
const MODELS_URL = `${ADMIN}/admin/v1/models`;

afterEach(() => {
  __resetAisixAdminAuthForTests();
});

describe("classifyAisixAdminStatus — 401/400/403 are four different facts", () => {
  test("401, 400, 403 and 404 each classify to their own kind", () => {
    assert.equal(classifyAisixAdminStatus(401), "unauthorized");
    assert.equal(classifyAisixAdminStatus(403), "forbidden");
    assert.equal(classifyAisixAdminStatus(400), "bad_request");
    assert.equal(classifyAisixAdminStatus(404), "missing");
    assert.equal(classifyAisixAdminStatus(405), "missing");
  });

  test("a status that is not a credential problem classifies to null", () => {
    // The regression this pins: 5xx and friends must NOT be classified, or a
    // gateway that is merely unhealthy sends the operator to the key prompt.
    for (const status of [200, 201, 204, 409, 422, 429, 500, 502, 503]) {
      assert.equal(classifyAisixAdminStatus(status), null, `status ${status}`);
    }
  });

  test("a 400 is never reported as a wrong key", () => {
    // The distinction the whole classification exists for: the server refused
    // the SHAPE, so the key was never compared.
    assert.notEqual(classifyAisixAdminStatus(400), classifyAisixAdminStatus(401));
  });
});

describe("isAisixAdminUrl — only the admin plane is auth-scoped", () => {
  test("an admin-base URL is admin; the metrics and data planes are not", () => {
    assert.equal(isAisixAdminUrl(MODELS_URL), true);
    assert.equal(isAisixAdminUrl(SESSION_URL), true);
    // :9090 is unauthenticated by construction and :3000 speaks OpenAI; a 401
    // from either has nothing to do with a gateway session, so routing them
    // through the auth transport would open a login prompt for the wrong reason.
    assert.equal(isAisixAdminUrl("http://127.0.0.1:9090/status/models"), false);
    assert.equal(isAisixAdminUrl("http://127.0.0.1:3000/v1/chat/completions"), false);
    assert.equal(isAisixAdminUrl("/api/auth/login"), false);
  });
});

describe("aisixAdminFetch — the transport policies", () => {
  test("attaches credentials so a same-origin cookie authenticates unchanged", async () => {
    const stub = stubFetch(() => json({ models: [] }));
    try {
      await aisixAdminFetch(MODELS_URL);
    } finally {
      stub.restore();
    }
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].init.credentials, "include");
  });

  test("sends no Authorization header when the caller supplied no key", async () => {
    const stub = stubFetch(() => json({ models: [] }));
    try {
      await aisixAdminFetch(MODELS_URL);
    } finally {
      stub.restore();
    }
    const headers = (stub.calls[0].init.headers ?? {}) as Record<string, string>;
    // A PRESENT Authorization decides on the server and short-circuits the
    // cookie, so the default must be "no header at all".
    assert.equal("Authorization" in headers, false);
  });

  test("sends Authorization ONLY when a caller explicitly supplied a key", async () => {
    const stub = stubFetch(() => json({ models: [] }));
    try {
      await aisixAdminFetch(MODELS_URL, { adminKey: "  ingress-key  " });
    } finally {
      stub.restore();
    }
    const headers = (stub.calls[0].init.headers ?? {}) as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer ingress-key");
  });

  test("a blank key produces no header rather than an empty Bearer", async () => {
    const stub = stubFetch(() => json({ models: [] }));
    try {
      await aisixAdminFetch(MODELS_URL, { adminKey: "   " });
    } finally {
      stub.restore();
    }
    const headers = (stub.calls[0].init.headers ?? {}) as Record<string, string>;
    assert.equal("Authorization" in headers, false);
  });

  test("a 401 raises the signed-out signal", async () => {
    const stub = stubFetch(() => json({ error_msg: "unauthorized" }, 401));
    let fired = 0;
    const off = subscribeAisixSignedOut(() => {
      fired += 1;
    });
    try {
      await aisixAdminFetch(MODELS_URL);
    } finally {
      off();
      stub.restore();
    }
    assert.equal(fired, 1);
    assert.equal(isAisixSignedOut(), true);
  });
});

describe("the signed-out signal is EDGE-triggered — no retry loop, no prompt storm", () => {
  test("five reads during one page load notify once, not five times", () => {
    let fired = 0;
    const off = subscribeAisixSignedOut(() => {
      fired += 1;
    });
    try {
      for (let i = 0; i < 5; i += 1) noteAisixAdminStatus(401);
    } finally {
      off();
    }
    // A level-triggered signal would fire here and the operator would get five
    // prompts for one condition.
    assert.equal(fired, 1);
  });

  test("a surface that keeps polling a dead session never re-notifies", () => {
    let fired = 0;
    const off = subscribeAisixSignedOut(() => {
      fired += 1;
    });
    try {
      for (let i = 0; i < 50; i += 1) noteAisixAdminStatus(401);
    } finally {
      off();
    }
    assert.equal(fired, 1, "a re-polling surface must not produce a second notification");
  });

  test("a 403 or 400 does NOT claim the session is gone", () => {
    const offSignedOut = subscribeAisixSignedOut(() => {
      throw new Error("a 403 must not open the key prompt");
    });
    try {
      assert.equal(noteAisixAdminStatus(403), "forbidden");
      assert.equal(noteAisixAdminStatus(400), "bad_request");
      assert.equal(isAisixSignedOut(), false);
    } finally {
      offSignedOut();
    }
  });

  test("a successful exchange re-arms the edge, so a later expiry notifies again", async () => {
    let fired = 0;
    const off = subscribeAisixSignedOut(() => {
      fired += 1;
    });
    const stub = stubFetch((url) => {
      if (url === SESSION_URL) return noContent(204);
      // First confirming read refuses, then the post-login expiry refuses.
      return json({}, 401);
    });
    try {
      noteAisixAdminStatus(401);
      assert.equal(fired, 1, "the first expiry notifies");

      // Re-arming goes through a SUCCESSFUL exchange, not through a test
      // reset: that is the only thing a real re-login does.
      const ok = stubFetch((url) => (url === SESSION_URL ? noContent(204) : json({ models: [] })));
      try {
        assert.equal((await exchangeAdminKeyForSession("correct-key")).ok, true);
      } finally {
        ok.restore();
      }
      assert.equal(isAisixSignedOut(), false);

      // The NEXT expiry is a new edge and must notify again.
      noteAisixAdminStatus(401);
      assert.equal(fired, 2, "a later expiry is a new notification");
    } finally {
      off();
      stub.restore();
    }
  });

  test("one broken subscriber does not stop the others being told", () => {
    let reached = 0;
    const offBad = subscribeAisixSignedOut(() => {
      throw new Error("this subscriber is broken");
    });
    const offGood = subscribeAisixSignedOut(() => {
      reached += 1;
    });
    try {
      noteAisixAdminStatus(401);
    } finally {
      offBad();
      offGood();
    }
    assert.equal(reached, 1);
  });
});

describe("the session epoch — a re-read hook, not a poller", () => {
  test("the epoch is stable until an exchange succeeds, then bumps once", async () => {
    assert.equal(getAisixSessionEpoch(), 0);
    let bumps = 0;
    const off = subscribeAisixSessionEpoch(() => {
      bumps += 1;
    });
    const stub = stubFetch((url) => {
      if (url === SESSION_URL) return noContent(204);
      return json({ models: [] });
    });
    try {
      // The POST then the confirming read: two requests, ONE epoch bump.
      const outcome = await exchangeAdminKeyForSession("correct-key");
      assert.equal(outcome.ok, true);
      assert.equal(bumps, 1);
      assert.equal(getAisixSessionEpoch(), 1);
    } finally {
      off();
      stub.restore();
    }
  });
});

describe("exchangeAdminKeyForSession — the 204/401/400/403 contract", () => {
  test("204 then a readable admin read is the ONLY signed-in verdict", async () => {
    const stub = stubFetch((url) => (url === SESSION_URL ? noContent(204) : json({ models: [] })));
    try {
      const outcome = await exchangeAdminKeyForSession("correct-key");
      assert.equal(outcome.ok, true);
    } finally {
      stub.restore();
    }
    // The 204 carries no body by contract, so a success must not be derived
    // from parsing one — and the confirmation is what makes the claim true.
    assert.deepEqual(
      stub.calls.map((c) => c.url),
      [SESSION_URL, MODELS_URL]
    );
    // The wire body carries the key and NOTHING ELSE: an extra field is what
    // turns a 204 into a 400, and the server refuses unknown fields on purpose.
    const wire = stub.calls[0].init.body;
    const body: unknown = JSON.parse(typeof wire === "string" ? wire : String(wire));
    assert.deepEqual(Object.keys(body as Record<string, unknown>), ["admin_key"]);
  });

  test("401 is 'unauthorized' and carries the server's own message", async () => {
    const stub = stubFetch(() => json({ error_msg: "unauthorized" }, 401));
    try {
      const outcome = await exchangeAdminKeyForSession("wrong-key");
      assert.equal(outcome.ok, false);
      assert.equal(failed(outcome).failure, "unauthorized");
      assert.equal(failed(outcome).errorMsg, "unauthorized");
    } finally {
      stub.restore();
    }
  });

  test("400 is 'bad_request' and is NOT reported as a wrong key", async () => {
    const stub = stubFetch(() => json({ error_msg: "`remember` is not a field" }, 400));
    try {
      const outcome = await exchangeAdminKeyForSession("any-key");
      assert.equal(outcome.ok, false);
      // The key was never compared; saying "wrong key" would be a lie about
      // what the server checked.
      assert.equal(failed(outcome).failure, "bad_request");
      assert.notEqual(failed(outcome).failure, "unauthorized");
    } finally {
      stub.restore();
    }
  });

  test("403 is 'forbidden' — a same-origin dashboard cannot produce it", async () => {
    const stub = stubFetch(() => json({ error_msg: "cross-origin request refused" }, 403));
    try {
      const outcome = await exchangeAdminKeyForSession("any-key");
      assert.equal(failed(outcome).failure, "forbidden");
    } finally {
      stub.restore();
    }
  });

  test("an empty key is refused WITHOUT a round-trip", async () => {
    const stub = stubFetch(() => json({}, 400));
    try {
      const outcome = await exchangeAdminKeyForSession("   ");
      assert.equal(failed(outcome).failure, "bad_request");
    } finally {
      stub.restore();
    }
    // The server answers 400 for an empty `admin_key`; asking it to be told
    // teaches the operator nothing and puts a key-shaped value on the wire.
    assert.equal(stub.calls.length, 0);
  });

  test("204 but the cookie was not kept is 'session_not_kept', not a false success", async () => {
    // The Secure-over-plain-HTTP failure mode: the gateway accepted the key and
    // answered 204, and the browser dropped the cookie, so the confirming read
    // still 401s. Reporting success on the 204 alone is the optimistic lie the
    // contract forbids.
    const stub = stubFetch((url) => (url === SESSION_URL ? noContent(204) : json({}, 401)));
    try {
      const outcome = await exchangeAdminKeyForSession("correct-key");
      assert.equal(outcome.ok, false);
      assert.equal(failed(outcome).failure, "session_not_kept");
    } finally {
      stub.restore();
    }
  });

  test("an unreachable gateway is 'unreachable', never a claim about the key", async () => {
    const stub = stubFetch(() => {
      throw new Error("network down");
    });
    try {
      const outcome = await exchangeAdminKeyForSession("some-key");
      assert.equal(failed(outcome).failure, "unreachable");
    } finally {
      stub.restore();
    }
  });

  test("with an explicit key the confirming read is skipped (the header already authenticates)", async () => {
    const stub = stubFetch(() => noContent(204));
    try {
      // This is the ingress / integration-suite path: a header key authorizes
      // every read, so a cookie-only confirmation would report a false
      // `session_not_kept` for a request that is in fact authorized.
      const outcome = await exchangeAdminKeyForSession("ingress-key", { adminKey: "ingress-key" });
      assert.equal(outcome.ok, true);
    } finally {
      stub.restore();
    }
    assert.equal(stub.calls.length, 1);
  });

  test("the exchange never puts the key in a URL", async () => {
    const stub = stubFetch(() => noContent(204));
    try {
      await exchangeAdminKeyForSession("secret-key-value", { adminKey: "secret-key-value" });
    } finally {
      stub.restore();
    }
    // A key in a URL lands in access logs, Referer headers and browser history.
    for (const call of stub.calls) {
      assert.equal(call.url.includes("secret-key-value"), false, call.url);
    }
  });
});

describe("revokeAdminSession — a 401 logout is a success", () => {
  test("a 204 clears the local state", async () => {
    const stub = stubFetch(() => noContent(204));
    try {
      await revokeAdminSession();
    } finally {
      stub.restore();
    }
    assert.equal(stub.calls[0].init.method, "DELETE");
    assert.equal(stub.calls[0].url, SESSION_URL);
    assert.equal(isAisixSignedOut(), true);
  });

  test("a 401 is treated as already signed out, and does not throw", async () => {
    const stub = stubFetch(() => json({ error_msg: "unauthorized" }, 401));
    try {
      await revokeAdminSession();
    } finally {
      stub.restore();
    }
    // The observable outcome the operator asked for — no live session — holds.
    assert.equal(isAisixSignedOut(), true);
  });

  test("an unreachable gateway still drops local state", async () => {
    const stub = stubFetch(() => {
      throw new Error("gateway down");
    });
    try {
      await revokeAdminSession();
    } finally {
      stub.restore();
    }
    // Otherwise an operator could be unable to escape a signed-in state.
    assert.equal(isAisixSignedOut(), true);
  });
});

describe("requestAdminLogin — the per-surface action", () => {
  test("notifies every subscriber", () => {
    let fired = 0;
    const off = subscribeAisixLoginRequested(() => {
      fired += 1;
    });
    try {
      requestAdminLogin();
    } finally {
      off();
    }
    assert.equal(fired, 1);
  });

  test("asking for the prompt does not claim the session is gone", () => {
    requestAdminLogin();
    // The 401 state belongs to the surface that observed the 401; a button press
    // is not evidence of anything about the credential.
    assert.equal(isAisixSignedOut(), false);
  });
});

/**
 * The three-valued session state.
 *
 * `signedOut` alone cannot separate "this browser never had a credential" from
 * "this browser's credential stopped working", and the dashboard told the first
 * one that their session had ended. These cases pin the evidence each state
 * requires, so the two cannot be collapsed again without a test going red.
 */
describe("getAisixSessionState — never-signed-in is not an ended session", () => {
  test("a page load that has only ever been refused is anonymous, not ended", async () => {
    const stub = stubFetch(() => json({ error_msg: "unauthorized" }, 401));
    try {
      await aisixAdminFetch(MODELS_URL);
    } finally {
      stub.restore();
    }
    // `isAisixSignedOut()` is true — and that is still correct: there is no
    // usable session. What must not follow is a claim that one existed.
    assert.equal(isAisixSignedOut(), true);
    assert.equal(getAisixSessionState(), "anonymous");
  });

  test("a 2xx admin read is what turns anonymous into active", async () => {
    const stub = stubFetch(() => json({ models: [] }));
    try {
      await aisixAdminFetch(MODELS_URL);
    } finally {
      stub.restore();
    }
    assert.equal(getAisixSessionState(), "active");
  });

  test("a 401 AFTER a successful read is an ended session", async () => {
    // The reload case: the exchange that set the cookie is history, and the
    // cookie is HttpOnly, so a successful read is the only surviving evidence
    // that a session existed. Without it this lands on "anonymous" and the
    // operator is never told their real session lapsed.
    const ok = stubFetch(() => json({ models: [] }));
    try {
      await aisixAdminFetch(MODELS_URL);
    } finally {
      ok.restore();
    }
    const refused = stubFetch(() => json({ error_msg: "unauthorized" }, 401));
    try {
      await aisixAdminFetch(MODELS_URL);
    } finally {
      refused.restore();
    }
    assert.equal(getAisixSessionState(), "ended");
  });

  test("an explicit sign-out is ended, because it proves a session existed", async () => {
    const stub = stubFetch(() => noContent(204));
    try {
      await revokeAdminSession();
    } finally {
      stub.restore();
    }
    assert.equal(getAisixSessionState(), "ended");
  });

  test("a successful exchange is active", async () => {
    const stub = stubFetch((url) => (url === SESSION_URL ? noContent(204) : json({ models: [] })));
    try {
      const outcome = await exchangeAdminKeyForSession("key");
      assert.equal(outcome.ok, true);
    } finally {
      stub.restore();
    }
    assert.equal(getAisixSessionState(), "active");
  });

  test("an UNAUTHENTICATED endpoint cannot invent a session", async () => {
    // /livez and /readyz sit on the admin base but answer 200 to anyone. If a
    // 200 from them counted as proof of a credential, every dashboard would
    // read as `active` and the next 401 would be reported as a lost session for
    // an operator who never had one — the exact bug, reintroduced one layer down.
    const stub = stubFetch(() => noContent(200));
    try {
      await aisixAdminFetch(`${ADMIN}/livez`);
    } finally {
      stub.restore();
    }
    assert.equal(getAisixSessionState(), "anonymous");
  });

  test("a 5xx does not create or end a session", async () => {
    const stub = stubFetch(() => json({ error_msg: "boom" }, 500));
    try {
      await aisixAdminFetch(MODELS_URL);
    } finally {
      stub.restore();
    }
    // An unhealthy gateway is neither a credential nor its absence; classifying
    // it either way sends the operator to the wrong fix.
    assert.equal(getAisixSessionState(), "anonymous");
  });

  test("re-signing in after an ended session returns to active", async () => {
    const first = stubFetch(() => json({ models: [] }));
    try {
      await aisixAdminFetch(MODELS_URL);
    } finally {
      first.restore();
    }
    const refused = stubFetch(() => json({ error_msg: "unauthorized" }, 401));
    try {
      await aisixAdminFetch(MODELS_URL);
    } finally {
      refused.restore();
    }
    assert.equal(getAisixSessionState(), "ended");

    const again = stubFetch((url) => (url === SESSION_URL ? noContent(204) : json({ models: [] })));
    try {
      await exchangeAdminKeyForSession("key");
    } finally {
      again.restore();
    }
    assert.equal(getAisixSessionState(), "active");
  });
  test("an exchange whose cookie was NOT kept is anonymous, not an ended session", async () => {
    // The `Secure`-cookie-over-plain-HTTP failure: the gateway answers the
    // exchange with a 204 and the browser drops the cookie, so the confirming
    // read 401s. The exchange's own 204 is a credentialed-admin 2xx, so the
    // "any 2xx proves a session" rule used to fire on the exchange itself and
    // land the operator on `ended` — a session that never existed, described to
    // them as one that had ended, beside the correct `session_not_kept` error.
    const stub = stubFetch((url) =>
      url === SESSION_URL ? noContent(204) : json({ error_msg: "unauthorized" }, 401)
    );
    try {
      const outcome = await exchangeAdminKeyForSession("key");
      assert.equal(failed(outcome).failure, "session_not_kept");
    } finally {
      stub.restore();
    }
    // There is no session, so there is no ended one. Reverting the exclusion of
    // the exchange path from `isCredentialedAdminEndpoint` makes this "ended".
    assert.equal(getAisixSessionState(), "anonymous");
  });

  test("a public admin route carrying a credentialed path in its QUERY invents nothing", async () => {
    // `/livez` and `/readyz` are unauthenticated and answer 200 to anyone. The
    // proof of a credential was matched by substring over the whole URL, so the
    // first caller that appends a `returnTo`/`next` parameter reinstates the hole
    // the comment claims is closed. The check is on the PATH; the query is not
    // part of the request's identity on the server either.
    const stub = stubFetch(() => noContent(200));
    try {
      await aisixAdminFetch(`${ADMIN}/livez?next=/admin/v1/models`);
    } finally {
      stub.restore();
    }
    assert.equal(getAisixSessionState(), "anonymous");

    // A fragment cannot reach the server, so it is even more clearly not a path.
    const fragment = stubFetch(() => noContent(200));
    try {
      await aisixAdminFetch(`${ADMIN}/readyz#/admin/v1/models`);
    } finally {
      fragment.restore();
    }
    assert.equal(getAisixSessionState(), "anonymous");

    // The positive half, so the assertion above is not satisfied by a predicate
    // that never matches anything: the real path still proves a session.
    const real = stubFetch(() => json({ models: [] }));
    try {
      await aisixAdminFetch(`${ADMIN}/admin/v1/models?limit=1`);
    } finally {
      real.restore();
    }
    assert.equal(getAisixSessionState(), "active");
  });
});
