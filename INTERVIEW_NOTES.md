# Interview prep (private: delete this file before submitting)

Be able to answer these from memory, in your own words:
1. Why `FOR UPDATE` instead of optimistic locking? What happens when two bids arrive in the same millisecond?
2. Why does the server own the clock? Where does `now()` come from?
3. What does `SKIP LOCKED` do, and what goes wrong without it when two workers run?
4. How does an idempotency key stop a double bid on a retry? What if the request fails after the DB commit?
5. What is anti-sniping and what are its downsides (no cap)?
6. What breaks first at 10x users? (WebSocket fan-out across instances, per-process rate limits, hot-row lock.)
7. Why REST for bids and WebSocket only for broadcasts?
8. Why integer paise? Why denormalise `current_price` and `bid_count`?
9. Where could this be attacked? (XSS + localStorage token, public /metrics, brute-force login, bid spam.)
10. What would you do with another week? (Redis adapter, refresh tokens, queue-based closing, E2E tests, admin edit UI, audit log.)

Read these files line by line: `src/bids.ts`, `src/lifecycle.ts`, and the comments in `src/server.ts`.
Run the 50-concurrent-bids test and explain each assertion.
