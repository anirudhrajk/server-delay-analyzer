"""
demo_server.py  -  a small simulated batching server, for trying the tuner
==========================================================================
    python samples/demo_server.py --threads 8 --batch 4

Requests arrive at random (on average one every millisecond). They are grouped
into batches of --batch requests, and --threads workers process the batches.
It prints the average delay per request, for example:

    delay_ms=9.41

What makes it slow (the same effects as in our formula):
  * too few threads    -> batches queue up waiting for a free worker
  * too many threads   -> workers slow each other down (shared locks)
  * small batches      -> the fixed setup cost per batch is paid too often
  * big batches        -> early requests wait for the batch to fill up
  * threads x batch    -> memory pressure when both are large
With too few threads AND small batches it cannot keep up at all: the queue grows
without limit and the delay explodes (the analyzer reports this as "overloaded").

It simulates time instead of sleeping, so every run finishes in well under a second.
"""
import argparse
import heapq
import os
import random

ARRIVAL_MS = 1.0     # average gap between requests
REQUESTS = 6000
SETUP_MS = 5.0       # fixed cost per batch
ITEM_MS = 0.3        # work per request
CONTEND_MS = 0.4     # lock contention: every extra thread adds this to each batch
CLASH_MS = 0.004     # memory pressure per (thread x request in batch)


def simulate(threads, batch, seed):
    rng = random.Random(seed)
    t, arrivals = 0.0, []
    for _ in range(REQUESTS):
        t += rng.expovariate(1 / ARRIVAL_MS)
        arrivals.append(t)
    free = [0.0] * threads              # when each worker is next free
    heapq.heapify(free)
    total = 0.0
    for i in range(0, REQUESTS, batch):
        group = arrivals[i:i + batch]
        ready = group[-1]                # a batch starts once it is full
        start = max(ready, heapq.heappop(free))
        service = SETUP_MS + len(group) * ITEM_MS + CONTEND_MS * (threads - 1) + CLASH_MS * threads * len(group)
        service *= rng.uniform(0.95, 1.05)
        done = start + service
        heapq.heappush(free, done)
        total += sum(done - a for a in group)
    return total / REQUESTS


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--threads", type=int, required=True)
    ap.add_argument("--batch", type=int, required=True)
    ap.add_argument("--seed", type=int, default=None, help="fix the random arrivals (default: different every run)")
    a = ap.parse_args()
    if a.threads < 1 or a.batch < 1:
        ap.error("--threads and --batch must be at least 1")
    seed = a.seed if a.seed is not None else int.from_bytes(os.urandom(4), "little")
    print(f"delay_ms={simulate(a.threads, a.batch, seed):.3f}")


if __name__ == "__main__":
    main()
