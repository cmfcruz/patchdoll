import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actorMayInvoke,
  buildInvocationDeniedResult
} from "../dist/invocationGate.js";

const CLOSED = { admins: [], trustedUsers: [] };

test("denies everyone when no lists are set (fail closed, no escape hatch)", () => {
  assert.equal(actorMayInvoke("U_RANDOM", CLOSED), false);
  assert.equal(actorMayInvoke(undefined, CLOSED), false);
});

test("admits trusted users by exact actor id", () => {
  const policy = { ...CLOSED, trustedUsers: ["U_TRUSTED"] };
  assert.equal(actorMayInvoke("U_TRUSTED", policy), true);
  assert.equal(actorMayInvoke("U_OTHER", policy), false);
});

test("admins are implicitly trusted (bootstrap)", () => {
  const policy = { ...CLOSED, admins: ["U_ADMIN"] };
  assert.equal(actorMayInvoke("U_ADMIN", policy), true);
});

test("an unknown actor is denied even alongside a populated allowlist", () => {
  const policy = { ...CLOSED, trustedUsers: ["U_TRUSTED"] };
  assert.equal(actorMayInvoke(undefined, policy), false);
});

test("denial result carries a chat reply and metadata", () => {
  const result = buildInvocationDeniedResult("U_RANDOM");
  assert.match(result.reply ?? "", /trusted-users/i);
  assert.equal(result.metadata?.invocationDenied, true);
  assert.equal(result.metadata?.actor, "U_RANDOM");
  assert.equal(result.proposedActions?.[0]?.type, "chat.reply");
});
