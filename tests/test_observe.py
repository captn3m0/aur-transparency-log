import json
import os
import tempfile
import unittest
from unittest import mock

from aurlog import aur, batch, net, observe, state

RSS = b"""<rss><channel>
<item><title>foo</title><pubDate>Wed, 25 Nov 2026 17:31:04 +0000</pubDate></item>
<item><title>bar</title><pubDate>garbage</pubDate></item>
<item><title>baz</title><pubDate>Wed, 25 Nov 2026 17:00:00 +0000</pubDate></item>
</channel></rss>"""
SHA = "a" * 40


class Tests(unittest.TestCase):
    def test_parse_rss_skips_bad_rows(self):
        rows = aur.parse_rss(RSS)
        self.assertEqual([r[0] for r in rows], ["foo", "baz"])

    def test_head_rejects_bad_names(self):
        self.assertIsNone(aur.head("--upload-pack=evil"))

    def test_subject_digest_is_stable(self):
        self.assertEqual(batch.subject_digest("x"), batch.subject_digest("x"))
        self.assertEqual(len(batch.subject_digest("x")), 64)

    def run_cycle(self, tmp, head=SHA, rss=RSS):
        with mock.patch.object(net, "get", return_value=(rss, "etag1")), mock.patch.object(
            aur, "rpc_info", return_value={"foo": ("foo", 5)}
        ), mock.patch.object(aur, "head", return_value=head):
            return observe.observe(tmp, os.path.join(tmp, "out"), now=1795627900)

    def test_cycle_and_dedupe(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = self.run_cycle(tmp)
            self.assertEqual(first[0]["commit"], SHA)
            self.assertTrue(observe.commit(tmp))
            self.assertEqual(self.run_cycle(tmp), [])
            lines = open(os.path.join(tmp, "out", "subjects.txt")).read().split()
            self.assertEqual(lines[1], "aur/foo")

    def test_failed_head_goes_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(net, "get", return_value=(RSS, None)), mock.patch.object(
                aur, "rpc_info", return_value={"foo": ("foo", 5)}
            ), mock.patch.object(aur, "head", side_effect=RuntimeError("boom")):
                self.assertEqual(observe.observe(tmp, tmp, now=1795627900), [])
            st = state.load(os.path.join(tmp, "state.json"))
            self.assertEqual(st["pending"], {"foo": 1})

    def test_rss_failure_keeps_cursor(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(net, "get", side_effect=RuntimeError("down")):
                self.assertEqual(observe.observe(tmp, tmp), [])
            self.assertEqual(state.load(os.path.join(tmp, "state.json"))["last_ts"], 0)

    def test_statement_shape(self):
        stmt = batch.statement([{"pkgbase": "foo", "commit": SHA, "before": None, "modified_ts": 1}], 0)
        json.dumps(stmt)
        self.assertEqual(stmt["subject"][0]["name"], "aur/foo")


if __name__ == "__main__":
    unittest.main()


class KeyTests(unittest.TestCase):
    def test_jwk_from_cosign_pub(self):
        from aurlog import jwk

        key = jwk.from_pem(os.path.join(os.path.dirname(__file__), "..", "keys", "worker-1.pub"))
        self.assertEqual((key["kty"], key["crv"], key["alg"]), ("EC", "P-256", "ES256"))
        self.assertEqual(key["kid"], jwk.thumbprint(key))
        self.assertEqual(len(jwk.discovery("https://x")["jwks_uri"]) > 0, True)

    def test_key_statement_has_own_type_and_signer(self):
        from aurlog import KEY_PREDICATE_TYPE

        stmt = batch.statement([{"pkgbase": "foo", "commit": SHA}], 0, batch.key_profile("kid1"))
        self.assertEqual(stmt["predicateType"], KEY_PREDICATE_TYPE)
        self.assertEqual(stmt["predicate"]["signer"]["kid"], "kid1")
        self.assertNotIn("signer", batch.statement([], 0)["predicate"])
