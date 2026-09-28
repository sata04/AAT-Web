# Worker upload recovery

Uploads move from a pending reservation to a finalised charge and then publication.
A snapshot is live only when its revision points to it; a poster when a figure points
to it; a source when its staged tombstone is cleared. Expired unpublished objects can
be claimed for cleanup. Publication checks the same settlement marker atomically,
so a sweep cannot delete an object whose publication won the race. Released holds,
settled charges and interrupted finalisation/publication remain discoverable until
R2 deletion and accounting both finish. A finalised-but-unpublished upload retains its charge
until reservation expiry, allowing a still-running publisher to finish. A retry before expiry
can temporarily hold both charges; an upload-triggered sweep after expiry reclaims the abandoned
one. Cleanup runs opportunistically on uploads, so expiry is eligibility, not a cleanup deadline.

Account deletion uses the existing durable `account_deletion_in_progress` ban reason,
protected from admin unban/quota updates, rather than introducing another schema
flag. The sweep rechecks that barrier when claiming a pending reservation. Installation
and its `user.delete_pending` audit insert share a D1 transaction. Expiry alone never
proves an admitted PUT has stopped. A writer that resumes cleans its unique R2 key even
if its object row disappeared, and attempts physical deletion even if accounting fails.

Residual limits: R2 and D1 are not transactional. A killed writer under the barrier can
leave DELETE pending indefinitely; recovery must establish that the writer has stopped
before releasing its hold. A reservation swept *before* barrier installation can already
be terminal while PUT is in flight. Its resumed handler deletes late bytes, but if the
account cascade removes its recovery record and the isolate dies after the late PUT,
an orphan can still remain. Removing that crash window requires a recovery tombstone
outside the user cascade (or bucket reconciliation). Cleanup failures retain records
while the account exists; no background sweep or guaranteed cleanup deadline is claimed.

Gzip uses pinned fflate with synchronous 256-byte input pushes and a decoded-output
cap, not workerd DecompressionStream. Inflater workspace remains a bounded transient
allocation beyond the output cap; retained chunks and the final joined result can total
roughly twice that cap. Compressed input, JSON parsing and decoded arrays are additional
memory. Optional gzip metadata is capped at 64 KiB. CRC/size corruption is rejected.
Uncapped callers retain an uncapped decoded result by API design. Node tests exercise
this implementation with the native decoder disabled; they do not measure workerd heap.
