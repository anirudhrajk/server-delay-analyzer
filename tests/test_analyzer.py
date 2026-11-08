"""
Tests for the back end.   Run from the project folder:   python -m unittest discover tests
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analyzer import DataError, analyse, make_sample, parse_csv  # noqa: E402
from delay_model import delay, optimise  # noqa: E402

DEFAULT = {"A": 400, "B": 4, "C": 90, "E": 2.5, "k": 0.05}


def sweep(p, noise=0.0, seed=1):
    rng = np.random.default_rng(seed)
    n, b, d = [], [], []
    for nn in (2, 4, 6, 8, 12, 16, 24, 32):
        for bb in (1, 2, 4, 8, 16, 32):
            n.append(nn); b.append(bb)
            d.append(delay(p, nn, bb) * (1 + noise * rng.standard_normal()))
    return np.array(n, float), np.array(b, float), np.array(d)


class TestModel(unittest.TestCase):
    def test_default_case_exact(self):
        o = optimise(DEFAULT)
        self.assertEqual(f"{o['n']:.6f}", "9.673458")
        self.assertEqual(f"{o['b']:.6f}", "5.492191")
        self.assertEqual(f"{o['D']:.6f}", "112.817896")
        self.assertTrue(o["is_minimum"])
        self.assertTrue(o["scipy_agrees"])
        self.assertAlmostEqual(o["eigenvalues"][0], 0.8721, places=4)
        self.assertAlmostEqual(o["eigenvalues"][1], 1.0982, places=4)

    def test_edge_detected_when_optimum_outside_range(self):
        o = optimise(DEFAULT, bounds=((1, 5), (1, 50)))
        self.assertEqual(o["edge"]["n"], "high")
        self.assertFalse(o["is_minimum"])


class TestAnalyser(unittest.TestCase):
    def test_noiseless_data_recovers_default_answer(self):
        r = analyse(*sweep(DEFAULT))
        self.assertAlmostEqual(r["best"]["n"], 9.673458, places=4)
        self.assertAlmostEqual(r["best"]["b"], 5.492191, places=4)
        self.assertAlmostEqual(r["best"]["D"], 112.817896, places=4)
        self.assertEqual((r["recommended"]["n"], r["recommended"]["b"]), (10, 5))
        self.assertAlmostEqual(r["recommended"]["D"], 113.00, places=2)
        self.assertGreater(r["fit"]["r2"], 0.999999)

    def test_noisy_data_lands_close(self):
        r = analyse(*sweep(DEFAULT, noise=0.03, seed=5))
        self.assertLess(abs(delay(DEFAULT, r["best"]["n"], r["best"]["b"]) / 112.817896 - 1), 0.01)

    def test_diagnosis_for_too_few_threads_and_big_batches(self):
        r = analyse(*sweep(DEFAULT), current=(4, 16))
        self.assertEqual(r["main_causes"][0], "queue")
        self.assertIn("wait", r["main_causes"])

    def test_diagnosis_for_too_many_threads(self):
        r = analyse(*sweep(DEFAULT), current=(32, 5))
        self.assertEqual(r["main_causes"][0], "crowd")

    def test_sample_file(self):
        n, b, d, skipped = parse_csv(make_sample())
        r = analyse(n, b, d)
        self.assertEqual(skipped, 0)
        self.assertEqual((r["current"]["n"], r["current"]["b"]), (4.0, 16.0))
        self.assertGreater(r["improvement"]["pct"], 0.2)


class TestParsing(unittest.TestCase):
    def test_other_column_names_and_semicolons(self):
        text = "Workers;BatchSize;Latency\n"
        text += "".join(f"{nn};{bb};{delay(DEFAULT, nn, bb):.3f}\n" for nn in (2, 8, 32) for bb in (1, 4, 16))
        n, b, d, _ = parse_csv(text)
        self.assertEqual(len(d), 9)

    def test_missing_column(self):
        with self.assertRaises(DataError):
            parse_csv("threads,delay_ms\n1,2\n")

    def test_bad_rows_skipped(self):
        n, b, d, skipped = parse_csv("threads,batch_size,delay_ms\n1,2,3\nx,2,3\n-1,2,3\n")
        self.assertEqual((len(d), skipped), (1, 2))

    def test_too_few_settings(self):
        n = np.array([1, 1, 2, 2, 1, 2], float)
        with self.assertRaises(DataError):
            analyse(n, n.copy(), n.copy())


if __name__ == "__main__":
    unittest.main()
