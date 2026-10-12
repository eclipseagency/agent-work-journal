# Architecture notes

## Why an event journal?

Coordination is easier to debug when the history is visible. Each accepted command produces one event and one task version. A projection rebuilds the latest task state. The original request is retained to distinguish a safe retry from a request ID accidentally reused for a different operation.

## Why JSONL instead of a hosted database?

It keeps this sample runnable with only Node and npm. This is not a substitute for transactions across distributed processes. The entry point enforces one process per journal with an exclusive lock; the journal class itself assumes its caller respects that constraint. Normal write failures truncate to the prior file length before allowing another command. Hard crashes can leave an incomplete line, which startup detects and rejects.

## Concurrency semantics

The queue serializes commands, then compares expectedVersion with the committed version. A successful append increments the version once. Idempotency is evaluated first, so a valid retry works even if later edits changed the task. Snapshot reads run through the same queue and return copies; callers cannot mutate the in-memory projection.

## UI behavior

The board does not optimistically move a task before persistence succeeds. A conflict reloads current state and shows a message. A network error retains the original command for an explicit retry using the same request ID. This avoids creating duplicate events when a response was lost after the disk write.

## Portfolio scope

Original sample authored in October 2026 to demonstrate fullstack patterns. No customer data, private source, service secrets or paid infrastructure. No GitHub publication was performed by the implementation subagent; the parent owns final review and publication.
