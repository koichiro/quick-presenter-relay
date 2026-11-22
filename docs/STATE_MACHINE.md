# State transitions and delivery

Room states: Created, Active, PresenterDisconnected, Ended, Expired.
A room identity is never reused after a terminal transition.

| Input                        | Preconditions                                  | Effect                                                  |
| ---------------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| Presenter attach/resume      | Credentials valid; nonterminal                 | Increment presenter epoch, fence old socket, Active     |
| Current presenter disconnect | Matching epoch                                 | PresenterDisconnected; bounded reconnect grace          |
| Audience join                | Active; admission hook allows input            | Atomically reserve membership, count +1                 |
| Audience disconnect          | Existing membership                            | Remove once; count -1                                   |
| Event submission             | Active, valid member and input                 | Optional policy; bounded pending offer; no accepted yet |
| Matching receipt             | Current room/presenter, pending event          | Complete result with qp outcome                         |
| Pending timeout / disconnect | Outstanding request                            | Unknown; never replay                                   |
| Pause/resume update          | Current presenter and increasing display epoch | Capture new display epoch; history/log intake continues |
| End                          | Owner authority                                | Terminal; close sockets, invalidate pending, no revival |
| Room deadline                | now >= expires_at                              | Expired; stop joins/submissions, preserve PDF playback  |
| Grace expiry                 | Disconnected and deadline reached              | Expired; no deferred event batch                        |

End/expiry override pending operations. A later receipt cannot revive a room or
produce accepted. An old presenter disconnect cannot disconnect its replacement.

For asynchronous hook calls: capture identity/epochs/revision, await
with a deadline, then serialize/recheck state before mutation. Do not hold a
storage transaction across an external call. An ended room, changed policy revision
or replaced presenter invalidates the stale completion.

An accepted event is transient. qp local queue/log submission may succeed while
receipt delivery fails; return unknown, not rejected. Exact-once and guaranteed
screen display are explicitly outside the protocol. An event's display epoch
never changes merely because it arrived late.

`protocol/fixtures/state-traces.json` is a reusable test format. The small model
in `scripts/contract-model.mjs` checks selected guarantees only; it has no sockets,
authentication, durable storage, clock implementation or production suitability.
