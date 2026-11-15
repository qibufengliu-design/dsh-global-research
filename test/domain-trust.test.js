import test from "node:test"
import assert from "node:assert/strict"
import { configureDomainTrust, domainTrust, isBlockedDomain, rankHits } from "../lib/util.js"

test("configureDomainTrust promotes trusted hosts and drops blocked ones", () => {
  configureDomainTrust({ trusted: ["example.com"], blocked: ["spam.example.org"] })
  assert.equal(domainTrust("https://docs.example.com/page"), 3)
  assert.equal(domainTrust("https://spam.example.org/x"), -10)
  assert.equal(isBlockedDomain("https://spam.example.org/x"), true)
  assert.equal(isBlockedDomain("https://example.com/x"), false)
  const ranked = rankHits([
    { url: "https://spam.example.org/x", title: "bad", engine: "e" },
    { url: "https://neutral.test/y", title: "good", engine: "e" },
  ])
  assert.deepEqual(ranked.map((hit) => hit.url), ["https://neutral.test/y"])
  configureDomainTrust({})
})
