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
protected by predicates on the admin and quota UPDATEs, rather than introducing another
schema flag. Admin mutations re-read the barrier after writing and reject a concurrent
deletion. Quota admission and finalisation also check the barrier in their SQL statements.
Installation, its `user.delete_pending` audit insert and copying every reserved R2 key
(including previously swept reservations) to `deleted_account_object_keys` share a D1
transaction. This recovery table has no foreign key to the account and survives its cascade.
Non-expired pending writers block DELETE; expired holds can be released under the barrier
by a sweep, including the bounded sweep DELETE runs before its pending check. Abandoned
uploads therefore do not require a writer to resume before account deletion can finish.
DELETE removes both object and reservation keys after installing the barrier. A writer
that resumes checks run/reservation liveness before finalising and cleans its unique R2
key even if its object row disappeared, attempting deletion even if accounting fails.

Residual limits: R2 and D1 are not transactional. A PUT can land after DELETE's final
physical deletion, even after the account is gone. If that writer dies before cleanup,
the retained key lets a later sweep find and delete its bytes. Sweeps check deleted-account
keys globally even when triggered for another user, rotate a bounded batch, and retain
keys after empty checks, successful deletes and failures: none proves a late PUT cannot
still arrive. These recovery keys and account identifiers currently have no garbage
collection deadline. Temporary late bytes and storage failures can persist until another
sweep succeeds; cleanup runs opportunistically on uploads and account DELETE, with no
background trigger or guaranteed cleanup deadline. A DELETE facing more expired holds
than its sweep batch can reclaim may need retries, while non-expired holds still block it.

Gzip uses pinned fflate with synchronous 256-byte input pushes and a decoded-output
cap, not workerd DecompressionStream. Inflater workspace remains a bounded transient
allocation beyond the output cap; retained chunks and the final joined result can total
roughly twice that cap. Compressed input, JSON parsing and decoded arrays are additional
memory. Optional gzip metadata is capped at 64 KiB. CRC/size corruption is rejected.
Uncapped callers retain an uncapped decoded result by API design. Node tests exercise
this implementation with the native decoder disabled; they do not measure workerd heap.
